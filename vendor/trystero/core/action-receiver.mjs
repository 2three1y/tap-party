import { decodeBytes, fromJson, libName, noOp, resetTimer } from "./utils.mjs";
import { transferTimeoutMs } from "./data-limits.mjs";
//#region src/action-receiver.ts
const maxPendingTransfers = 1024;
const maxPendingPerPeer = 64;
const maxDecisions = 128;
const maxDecisionsPerPeer = 8;
const emptyBytes = /* @__PURE__ */ new Uint8Array();
const decideReceive = (decide, settle) => {
	let result;
	try {
		result = decide();
	} catch {
		return settle(false);
	}
	return typeof result === "boolean" ? settle(result) : Promise.resolve(result).then((value) => settle(value === true), () => settle(false));
};
const decodePayload = (bytes, format, copy) => format === 2 ? copy ? bytes.slice() : bytes : format === 1 ? fromJson(decodeBytes(bytes)) : decodeBytes(bytes);
const progress = (action, value, peerId, metadata) => {
	try {
		action.progress(value, peerId, metadata);
	} catch (error) {
		console.error(`${libName} progress handler error:`, error);
	}
};
const deliverPayload = (action, data, peerId, metadata) => {
	progress(action, 1, peerId, metadata);
	try {
		action.receiver?.(data, peerId, metadata);
	} catch (error) {
		console.error(`${libName} action handler error:`, error);
	}
};
const createActionReceiver = ({ fail, accept, refuse, maxReceiveBytes, chunkSize }) => {
	const actions = /* @__PURE__ */ new Map();
	const peers = /* @__PURE__ */ new Map();
	const waiting = /* @__PURE__ */ new Set();
	const decisions = /* @__PURE__ */ new Map();
	let pendingCount = 0;
	let decisionCount = 0;
	let reservedBytes = 0;
	let draining = false;
	let drainAgain = false;
	const current = (state) => state.phase !== "released";
	const payloadLimit = (action) => Math.min(maxReceiveBytes, action?.maxPayloadBytes ?? maxReceiveBytes);
	const notifyRejected = (message, reason, scope, bulkId) => {
		scope?.reject(reason);
		actions.get(message.type)?.reject?.(message.peerId, message.metadata, reason);
		if (bulkId !== void 0) refuse(message.peerId, bulkId, reason);
	};
	const rotateWaitingForPeer = (peerId) => {
		for (const queued of Array.from(waiting)) if (queued.peerId === peerId) {
			waiting.delete(queued);
			waiting.add(queued);
		}
	};
	const release = (state) => {
		if (!current(state)) return;
		state.phase = "released";
		state.removeAbortListener?.();
		state.timer = resetTimer(state.timer);
		const peer = peers.get(state.peerId);
		if (state.kind === "inline") {
			const queue = peer.inline.get(state.key);
			queue.splice(queue.indexOf(state), 1);
			if (!queue.length) peer.inline.delete(state.key);
			state.data = emptyBytes;
		} else {
			peer.bulk.delete(state.id);
			waiting.delete(state);
			state.data = null;
			if (state.transfer === "receiving") {
				reservedBytes -= state.size;
				if (peer.active === state) {
					peer.active = null;
					rotateWaitingForPeer(state.peerId);
				}
				drainAgain = true;
			}
		}
		peer.count--;
		pendingCount--;
		if (!peer.count) peers.delete(state.peerId);
		state.controller?.abort();
	};
	const reject = (state, reason) => {
		if (!current(state)) return;
		release(state);
		notifyRejected(state, reason, state.scope, state.kind === "bulk" ? state.id : void 0);
	};
	const admit = (state, action) => {
		if (state.phase !== "pending") return state.phase === "ready";
		if (state.size > payloadLimit(action)) {
			reject(state, "payload exceeds receiver size limit");
			return false;
		}
		const receive = state.scope ? state.scope.receive : action.receive;
		if (!receive) {
			if (!action.receiver) return false;
			state.phase = "ready";
			return true;
		}
		if (decisionCount >= maxDecisions || (decisions.get(state.peerId) ?? 0) >= maxDecisionsPerPeer) {
			reject(state, "too many pending receive decisions");
			return false;
		}
		state.phase = "deciding";
		const controller = new AbortController();
		state.controller = controller;
		decisionCount++;
		decisions.set(state.peerId, (decisions.get(state.peerId) ?? 0) + 1);
		const result = decideReceive(() => receive({
			byteLength: state.size,
			peerId: state.peerId,
			signal: controller.signal,
			...state.metadata === void 0 ? {} : { metadata: state.metadata }
		}), (allow) => {
			decisionCount--;
			const count = decisions.get(state.peerId) - 1;
			if (count) decisions.set(state.peerId, count);
			else decisions.delete(state.peerId);
			if (!current(state)) return false;
			if (allow) state.phase = "ready";
			else reject(state, "payload rejected by receiver");
			return allow;
		});
		if (typeof result === "boolean") return result;
		result.then(() => drain());
		return false;
	};
	const complete = (state, action, bytes) => {
		let payload;
		try {
			payload = decodePayload(bytes, state.format, state.kind === "inline");
		} catch {
			release(state);
			fail(state.peerId, "invalid action payload");
			return;
		}
		release(state);
		deliverPayload(action, payload, state.peerId, state.metadata);
	};
	const tryInline = (state) => {
		const action = actions.get(state.type);
		if (current(state) && action && admit(state, action) && action.receiver) complete(state, action, state.data);
	};
	const tryBulk = (state) => {
		const action = actions.get(state.type);
		if (!current(state) || !action || !admit(state, action) || !action.receiver) return;
		if (state.transfer === "receiving") {
			if (state.offset === state.size) complete(state, action, state.data);
			return;
		}
		const peer = peers.get(state.peerId);
		if (!peer.active && reservedBytes + state.size <= maxReceiveBytes) {
			peer.active = state;
			state.transfer = "receiving";
			reservedBytes += state.size;
			state.lastSeen = Date.now();
			waiting.delete(state);
			accept(state.peerId, state.id);
		}
	};
	const drainInline = (peerId, key) => {
		const queue = peers.get(peerId)?.inline.get(key);
		while (queue?.[0]) {
			const state = queue[0];
			tryInline(state);
			if (current(state)) break;
		}
	};
	const drain = () => {
		if (draining) {
			drainAgain = true;
			return;
		}
		draining = true;
		try {
			do {
				drainAgain = false;
				for (const state of waiting) tryBulk(state);
				for (const [id, peer] of peers) {
					for (const state of peer.bulk.values()) if (state.offset === state.size) tryBulk(state);
					for (const key of peer.inline.keys()) drainInline(id, key);
				}
			} while (drainAgain);
		} finally {
			draining = false;
		}
	};
	const enqueue = (state) => {
		let peer = peers.get(state.peerId);
		if (pendingCount >= maxPendingTransfers || (peer?.count ?? 0) >= maxPendingPerPeer) {
			notifyRejected(state, "too many pending transfers", state.scope, state.kind === "bulk" ? state.id : void 0);
			return false;
		}
		if (!peer) {
			peer = {
				bulk: /* @__PURE__ */ new Map(),
				inline: /* @__PURE__ */ new Map(),
				active: null,
				count: 0
			};
			peers.set(state.peerId, peer);
		}
		peer.count++;
		pendingCount++;
		if (state.kind === "inline") {
			const queue = peer.inline.get(state.key) ?? [];
			queue.push(state);
			peer.inline.set(state.key, queue);
		} else {
			peer.bulk.set(state.id, state);
			waiting.add(state);
		}
		const expire = () => {
			const remaining = transferTimeoutMs - (Date.now() - state.lastSeen);
			if (remaining > 0) state.timer = setTimeout(expire, remaining);
			else {
				reject(state, "action transfer timed out");
				drain();
			}
		};
		state.timer = setTimeout(expire, transferTimeoutMs);
		if (state.scope) {
			const { signal } = state.scope;
			const cancel = () => {
				reject(state, "receive cancelled");
				drain();
			};
			signal.addEventListener("abort", cancel, { once: true });
			state.removeAbortListener = () => signal.removeEventListener("abort", cancel);
			if (signal.aborted) {
				cancel();
				return false;
			}
		}
		return true;
	};
	const resolveAdmission = (message, bulkId) => {
		const action = actions.get(message.type);
		const scope = action?.receiveScope?.(message.peerId, message.metadata);
		if (scope === null || scope?.signal.aborted) {
			if (bulkId !== void 0) refuse(message.peerId, bulkId, "unexpected response");
			return null;
		}
		if (message.size > payloadLimit(action)) {
			notifyRejected(message, "payload exceeds receiver size limit", scope, bulkId);
			return null;
		}
		return {
			action,
			scope
		};
	};
	const admission = (message, scope) => ({
		...message,
		...scope ? { scope } : {},
		phase: "pending",
		controller: null,
		lastSeen: Date.now(),
		timer: null
	});
	return {
		register: (type, options = {}) => {
			const action = {
				...options,
				receiver: null,
				receive: null,
				reject: null,
				progress: noOp
			};
			actions.set(type, action);
			return {
				onMessage: (handler) => {
					action.receiver = handler;
					drain();
				},
				onReceive: (handler) => {
					action.receive = handler;
					drain();
				},
				onReject: (handler) => {
					action.reject = handler;
				},
				onProgress: (handler) => {
					action.progress = handler;
				}
			};
		},
		receiveInline: (message, data) => {
			const resolved = resolveAdmission(message);
			if (!resolved) return;
			const { action, scope } = resolved;
			const key = scope ? `${message.type}\0${scope.key}` : message.type;
			if (action?.receiver && !(scope ? scope.receive : action.receive) && !peers.get(message.peerId)?.inline.has(key)) {
				let payload;
				try {
					payload = decodePayload(data, message.format, true);
				} catch {
					fail(message.peerId, "invalid action payload");
					return;
				}
				deliverPayload(action, payload, message.peerId, message.metadata);
				return;
			}
			const state = {
				...admission(message, scope),
				kind: "inline",
				key,
				data
			};
			if (enqueue(state)) drainInline(message.peerId, key);
		},
		receiveOffer: (message, id) => {
			if (peers.get(message.peerId)?.bulk.has(id)) {
				fail(message.peerId, "duplicate action offer");
				return;
			}
			const resolved = resolveAdmission(message, id);
			if (!resolved) return;
			const state = {
				...admission(message, resolved.scope),
				kind: "bulk",
				id,
				transfer: "waiting",
				offset: 0,
				data: null
			};
			if (enqueue(state)) drain();
		},
		receiveChunk: (peerId, id, offset, data) => {
			const peer = peers.get(peerId);
			const state = peer?.bulk.get(id);
			if (!state) return;
			if (state.transfer !== "receiving" || offset !== state.offset || !data.length || data.length !== Math.min(chunkSize, state.size - state.offset)) {
				fail(peerId, "invalid action chunk offset or length");
				return;
			}
			try {
				state.data ??= new Uint8Array(state.size);
			} catch {
				reject(state, "unable to allocate receive buffer");
				drain();
				return;
			}
			state.data.set(data, state.offset);
			state.offset += data.length;
			const now = Date.now();
			state.lastSeen = now;
			for (const queued of waiting) if (queued.phase === "ready" && actions.get(queued.type)?.receiver) queued.lastSeen = now;
			if (state.offset === state.size) {
				tryBulk(state);
				if (current(state) && peer?.active === state) {
					peer.active = null;
					rotateWaitingForPeer(peerId);
				}
				drain();
			} else progress(actions.get(state.type), state.offset / state.size, peerId, state.metadata);
		},
		cancel: (peerId, id) => {
			const state = peers.get(peerId)?.bulk.get(id);
			if (state) {
				release(state);
				state.scope?.reject("response cancelled by sender");
			}
			drain();
		},
		clearPeer: (peerId) => {
			const peer = peers.get(peerId);
			if (peer) {
				for (const state of peer.bulk.values()) release(state);
				for (const queue of peer.inline.values()) {
					const queuedMessages = [...queue];
					for (const state of queuedMessages) release(state);
				}
			}
			drain();
		}
	};
};
//#endregion
export { createActionReceiver };

