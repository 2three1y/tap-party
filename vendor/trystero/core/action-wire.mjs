import { all, decodeBytes, encodeBytes, fromJson, libName, mkErr, noOp, resetTimer, toJson } from "./utils.mjs";
import { maxActionFrameBytes, transferTimeoutMs } from "./data-limits.mjs";
import { createActionReceiver } from "./action-receiver.mjs";
//#region src/action-wire.ts
const version = 2;
const inline = 0;
const offer = 1;
const chunk = 2;
const accepted = 3;
const rejected = 4;
const cancelled = 5;
const inlineHeaderSize = 36;
const offerHeaderSize = 48;
const controlHeaderSize = 6;
const chunkHeaderSize = 14;
const chunkSize = maxActionFrameBytes - chunkHeaderSize;
const defaultMaxReceiveBytes = 256 * 1024 ** 2;
const maxControlBufferedBytes = 1024 ** 2;
const buffLowEvent = "bufferedamountlow";
const channelCloseEvent = "close";
const channelErrorEvent = "error";
const backpressureWaitTimeoutMs = 1e4;
const makeActionError = (kind, message) => {
	const error = mkErr(message);
	error.kind = kind;
	error.name = kind === "aborted" ? "AbortError" : error.name;
	return error;
};
const throwIfAborted = (signal) => {
	if (signal?.aborted) throw makeActionError("aborted", "operation aborted");
};
const packet = (kind, id, size = controlHeaderSize) => {
	const bytes = new Uint8Array(size);
	bytes[0] = version;
	bytes[1] = kind;
	new DataView(bytes.buffer).setUint32(2, id);
	return bytes;
};
const transferError = makeActionError;
const waitForBufferedAmountLow = (channel, signal, timeoutMs = backpressureWaitTimeoutMs) => {
	if (channel.readyState !== "open" || channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve(channel.readyState === "open");
	return new Promise((res) => {
		let settled = false;
		let timeout = null;
		const finish = (didDrain) => {
			if (settled) return;
			settled = true;
			channel.removeEventListener(buffLowEvent, onBufferLow);
			channel.removeEventListener(channelCloseEvent, onCloseOrError);
			channel.removeEventListener(channelErrorEvent, onCloseOrError);
			signal?.removeEventListener("abort", onCloseOrError);
			resetTimer(timeout);
			res(didDrain);
		};
		const onBufferLow = () => finish(true);
		const onCloseOrError = () => finish(false);
		channel.addEventListener(buffLowEvent, onBufferLow);
		channel.addEventListener(channelCloseEvent, onCloseOrError);
		channel.addEventListener(channelErrorEvent, onCloseOrError);
		signal?.addEventListener("abort", onCloseOrError, { once: true });
		timeout = setTimeout(() => finish(false), timeoutMs);
		if (channel.readyState !== "open" || signal?.aborted) {
			finish(false);
			return;
		}
		if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) finish(true);
	});
};
const createActionWireManager = ({ getPeer, getPeerIds, canReceiveFromPeer, onPeerError, throwIfAborted: checkAborted = throwIfAborted, maxReceiveBytes = defaultMaxReceiveBytes }) => {
	if (!Number.isSafeInteger(maxReceiveBytes) || maxReceiveBytes <= 0) throw mkErr("maxReceiveBytes must be a positive safe integer");
	const actions = /* @__PURE__ */ new Map();
	const outgoing = /* @__PURE__ */ new Map();
	const failedPeers = /* @__PURE__ */ new WeakSet();
	let nextId = 0;
	const receiver = createActionReceiver({
		fail: (peerId, reason) => failPeer(peerId, reason),
		accept: (peerId, id) => control(peerId, id, accepted),
		refuse: (peerId, id, reason) => control(peerId, id, rejected, reason),
		maxReceiveBytes,
		chunkSize
	});
	const clearPeer = (peerId) => {
		for (const state of outgoing.get(peerId)?.values() ?? []) state.fail(transferError("disconnected", "peer disconnected"));
		outgoing.delete(peerId);
		receiver.clearPeer(peerId);
	};
	const failPeer = (peerId, reason) => {
		const peer = getPeer(peerId, true);
		if (peer && !failedPeers.has(peer)) {
			failedPeers.add(peer);
			console.warn(`${libName}: ${reason}; disconnecting peer ${peerId}`);
			onPeerError(peerId, mkErr(reason));
		}
	};
	const control = (peerId, id, kind, reason = "") => {
		const peer = getPeer(peerId, true);
		if (!peer) return;
		const text = encodeBytes(reason).subarray(0, 200);
		const bytes = packet(kind, id, controlHeaderSize + text.length);
		bytes.set(text, controlHeaderSize);
		try {
			if ((peer.channel?.bufferedAmount ?? 0) > maxControlBufferedBytes) throw mkErr("control send buffer is full");
			peer.sendData(bytes);
		} catch {
			failPeer(peerId, "unable to send action control");
		}
	};
	const makeInternalAction = (type, options = {}) => {
		const normalizedOptions = {
			sendToPending: Boolean(options.sendToPending),
			receiveWhilePending: Boolean(options.receiveWhilePending),
			...options.maxPayloadBytes === void 0 ? {} : { maxPayloadBytes: options.maxPayloadBytes },
			...options.receiveScope ? { receiveScope: options.receiveScope } : {}
		};
		const cached = actions.get(type);
		if (cached) {
			if (cached.options.sendToPending !== normalizedOptions.sendToPending || cached.options.receiveWhilePending !== normalizedOptions.receiveWhilePending || cached.options.receiveScope !== normalizedOptions.receiveScope || cached.options.maxPayloadBytes !== normalizedOptions.maxPayloadBytes) throw mkErr(`action type "${type}" cannot be redefined`);
			return cached.action;
		}
		const typeBytes = encodeBytes(type);
		if (!type || type.includes("\0") || typeBytes.length > 32) throw mkErr("action type must contain 1–32 UTF-8 bytes and no null characters");
		const action = {
			options: normalizedOptions,
			action: {
				...receiver.register(type, normalizedOptions),
				send: async (data, targets, metadata, onProgress, signal) => {
					checkAborted(signal);
					if (data === void 0) throw mkErr("action data cannot be undefined");
					const isBlob = data instanceof Blob;
					const binary = isBlob || data instanceof ArrayBuffer || ArrayBuffer.isView(data);
					const format = binary ? 2 : typeof data === "string" ? 0 : 1;
					let source = isBlob ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : encodeBytes(format === 0 ? data : toJson(data));
					const size = source instanceof Blob ? source.size : source.byteLength;
					const meta = metadata === void 0 ? /* @__PURE__ */ new Uint8Array() : encodeBytes(toJson(metadata));
					if (meta.length > 16336) throw mkErr("action metadata is too large");
					const small = inlineHeaderSize + meta.length + size <= maxActionFrameBytes;
					if (!small && binary && !(source instanceof Blob)) source = source.slice();
					const id = small ? 0 : nextId++ >>> 0;
					const headerSize = small ? inlineHeaderSize : offerHeaderSize;
					const start = new Uint8Array(headerSize + meta.length + (small ? size : 0));
					start[0] = version;
					start[1] = (small ? inline : offer) | format << 4;
					start.set(typeBytes, 2);
					const view = new DataView(start.buffer);
					view.setUint16(34, meta.length);
					if (!small) {
						view.setUint32(36, id);
						view.setFloat64(40, size);
					}
					start.set(meta, headerSize);
					if (small) start.set(source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source, headerSize + meta.length);
					const ids = targets ? Array.isArray(targets) ? targets : [targets] : getPeerIds(normalizedOptions.sendToPending);
					await all([...new Set(ids)].map(async (peerId) => {
						const peer = getPeer(peerId, normalizedOptions.sendToPending);
						if (!peer) {
							console.warn(`${libName}: no peer with id ${peerId} found`);
							return;
						}
						let failure = null;
						const check = () => {
							if (failure) throw failure;
							checkAborted(signal);
							if (getPeer(peerId, normalizedOptions.sendToPending) !== peer || peer.channel?.readyState === "closed") throw transferError("disconnected", "peer disconnected");
						};
						const sendFrame = async (bytes) => {
							check();
							const channel = peer.channel;
							if (channel && (channel.readyState !== "open" || channel.bufferedAmount > channel.bufferedAmountLowThreshold)) {
								if (!await waitForBufferedAmountLow(channel, signal)) {
									checkAborted(signal);
									throw transferError("disconnected", "data channel stopped draining");
								}
								check();
							}
							try {
								peer.sendData(bytes);
							} catch {
								throw transferError("disconnected", "peer disconnected");
							}
						};
						if (small) {
							await sendFrame(start);
							onProgress?.(1, peerId, metadata);
							return;
						}
						let didSendOffer = false;
						let settledByReceiver = false;
						let lastSeen = Date.now();
						let accept;
						let rejectOffer;
						const permission = new Promise((resolve, rejectPromise) => {
							accept = resolve;
							rejectOffer = rejectPromise;
						});
						permission.catch(noOp);
						const transfers = outgoing.get(peerId) ?? /* @__PURE__ */ new Map();
						if (transfers.has(id)) throw mkErr("action transmission id is still in use");
						outgoing.set(peerId, transfers);
						let timer = null;
						const state = {
							accept: () => {
								if (!timer || failure) return false;
								timer = resetTimer(timer);
								accept();
								return true;
							},
							fail: (error, fromReceiver = false) => {
								if (fromReceiver) settledByReceiver = true;
								failure = error;
								rejectOffer(error);
							},
							touch: () => {
								if (timer) lastSeen = Date.now();
							}
						};
						transfers.set(id, state);
						const expire = () => {
							const remaining = transferTimeoutMs - (Date.now() - lastSeen);
							if (remaining > 0) timer = setTimeout(expire, remaining);
							else state.fail(transferError("timeout", "action offer timed out"));
						};
						timer = setTimeout(expire, transferTimeoutMs);
						const abort = () => {
							try {
								checkAborted(signal);
							} catch (error) {
								state.fail(error);
							}
						};
						signal?.addEventListener("abort", abort, { once: true });
						try {
							await sendFrame(start);
							didSendOffer = true;
							await permission;
							for (let offset = 0; offset < size; offset += chunkSize) {
								check();
								const length = Math.min(chunkSize, size - offset);
								const bytes = packet(chunk, id, chunkHeaderSize + length);
								new DataView(bytes.buffer).setFloat64(controlHeaderSize, offset);
								bytes.set(source instanceof Blob ? new Uint8Array(await source.slice(offset, offset + length).arrayBuffer()) : source.subarray(offset, offset + length), chunkHeaderSize);
								await sendFrame(bytes);
								for (const pending of transfers.values()) pending.touch();
								onProgress?.((offset + length) / size, peerId, metadata);
							}
							check();
						} catch (error) {
							if (didSendOffer && !settledByReceiver && getPeer(peerId, true) === peer && (!peer.channel || peer.channel.readyState === "open" && (peer.channel.bufferedAmount ?? 0) <= maxControlBufferedBytes)) control(peerId, id, cancelled);
							throw error;
						} finally {
							timer = resetTimer(timer);
							signal?.removeEventListener("abort", abort);
							transfers.delete(id);
							if (!transfers.size && outgoing.get(peerId) === transfers) outgoing.delete(peerId);
						}
					}));
				}
			}
		};
		actions.set(type, action);
		return action.action;
	};
	const handleData = (peerId, data) => {
		if (data.byteLength < 2 || data.byteLength > 16384) {
			failPeer(peerId, "invalid action frame");
			return;
		}
		const bytes = new Uint8Array(data);
		if (bytes[0] !== version) {
			failPeer(peerId, "incompatible action protocol version");
			return;
		}
		const kind = bytes[1] & 15;
		const format = bytes[1] >>> 4;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (kind > cancelled || format > 2 || kind > offer && format !== 0) {
			failPeer(peerId, "invalid action frame");
			return;
		}
		if (kind >= chunk) {
			if (bytes.length < controlHeaderSize || (kind === accepted || kind === cancelled) && bytes.length !== controlHeaderSize || kind === rejected && bytes.length > 206) {
				failPeer(peerId, "invalid action control");
				return;
			}
			const id = view.getUint32(2);
			if (kind === accepted) {
				const transfers = outgoing.get(peerId);
				if (transfers?.get(id)?.accept()) for (const pending of transfers.values()) pending.touch();
				return;
			}
			if (kind === rejected) {
				outgoing.get(peerId)?.get(id)?.fail(transferError("rejected", decodeBytes(bytes.subarray(controlHeaderSize))), true);
				return;
			}
			if (kind === cancelled) receiver.cancel(peerId, id);
			else receiver.receiveChunk(peerId, id, bytes.length >= chunkHeaderSize ? view.getFloat64(controlHeaderSize) : NaN, bytes.subarray(chunkHeaderSize));
			return;
		}
		const headerSize = kind === inline ? inlineHeaderSize : offerHeaderSize;
		if (bytes.length < headerSize) {
			failPeer(peerId, "invalid action header");
			return;
		}
		const type = decodeBytes(bytes.subarray(2, 34)).replaceAll("\0", "");
		const action = actions.get(type);
		if (!canReceiveFromPeer(peerId, Boolean(action?.options.receiveWhilePending))) return;
		const metaLength = view.getUint16(34);
		const payloadIndex = headerSize + metaLength;
		const size = kind === inline ? bytes.length - payloadIndex : view.getFloat64(40);
		const id = kind === offer ? view.getUint32(36) : 0;
		if (!type || payloadIndex > bytes.length || !Number.isSafeInteger(size) || size < 0 || kind === offer && (size === 0 || payloadIndex !== bytes.length)) {
			failPeer(peerId, "invalid action proposal");
			return;
		}
		let metadata;
		try {
			if (metaLength) metadata = fromJson(decodeBytes(bytes.subarray(headerSize, payloadIndex)));
		} catch {
			failPeer(peerId, "invalid action metadata");
			return;
		}
		const message = {
			peerId,
			type,
			format,
			size,
			...metadata === void 0 ? {} : { metadata }
		};
		if (kind === inline) receiver.receiveInline(message, bytes.subarray(payloadIndex));
		else receiver.receiveOffer(message, id);
	};
	return {
		makeInternalAction,
		handleData,
		clearPeer
	};
};
//#endregion
export { createActionWireManager, makeActionError, throwIfAborted };

