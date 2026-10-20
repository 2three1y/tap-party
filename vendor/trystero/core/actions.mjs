import { all, entries, genId, libName, mkErr, noOp, resetTimer, toError, toErrorMessage } from "./utils.mjs";
import { createActionWireManager, makeActionError, throwIfAborted } from "./action-wire.mjs";
//#region src/actions.ts
const getEnvelopeRecord = (metadata) => metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.r === "string" ? metadata : null;
const getRequestMetadata = (metadata) => {
	const record = getEnvelopeRecord(metadata);
	return record ? {
		r: record.r,
		...Object.hasOwn(record, "m") ? { m: record.m } : {}
	} : null;
};
const getResponseMetadata = (metadata) => {
	const record = getEnvelopeRecord(metadata);
	return record ? {
		r: record.r,
		...typeof record.e === "string" ? { e: record.e } : {}
	} : null;
};
const withMetadata = (context, metadata) => metadata === void 0 ? context : {
	...context,
	metadata
};
const createActionManager = ({ getPeer, getPeerIds, canReceiveFromPeer, onPeerError, maxReceiveBytes }) => {
	const publicActions = Object.create(null);
	const pendingRequestWaiters = {};
	const activeRequestControllers = /* @__PURE__ */ new Map();
	const wire = createActionWireManager({
		getPeer,
		getPeerIds,
		canReceiveFromPeer,
		onPeerError,
		...maxReceiveBytes === void 0 ? {} : { maxReceiveBytes }
	});
	const makeInternalAction = wire.makeInternalAction;
	const handleData = wire.handleData;
	const clearPendingRequestWaiter = (requestId) => {
		const waiter = pendingRequestWaiters[requestId];
		if (!waiter) return;
		resetTimer(waiter.timer);
		if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener("abort", waiter.abortHandler);
		delete pendingRequestWaiters[requestId];
		waiter.controller.abort();
	};
	const rejectPendingRequestsForPeer = (id, error) => {
		entries(pendingRequestWaiters).forEach(([requestId, waiter]) => {
			if (waiter.peerId !== id) return;
			clearPendingRequestWaiter(requestId);
			waiter.reject(error);
		});
	};
	const clearPeer = (id, error) => {
		wire.clearPeer(id);
		const controllers = activeRequestControllers.get(id);
		if (controllers) {
			activeRequestControllers.delete(id);
			controllers.forEach((controller) => controller.abort());
		}
		rejectPendingRequestsForPeer(id, makeActionError("disconnected", toErrorMessage(error, "peer disconnected")));
	};
	const responseAction = makeInternalAction("@_response", { receiveScope: (peerId, metadata) => {
		const parsed = getResponseMetadata(metadata);
		const waiter = parsed && pendingRequestWaiters[parsed.r];
		if (!parsed || !waiter || waiter.peerId !== peerId) return null;
		const receive = parsed.e === void 0 ? waiter.getReceive() : null;
		return {
			key: parsed.r,
			signal: waiter.controller.signal,
			receive: receive ? (context) => receive({
				byteLength: context.byteLength,
				peerId: context.peerId,
				kind: "response",
				signal: context.signal
			}) : null,
			reject: (reason) => {
				if (pendingRequestWaiters[parsed.r] === waiter) {
					clearPendingRequestWaiter(parsed.r);
					waiter.reject(makeActionError("rejected", reason));
				}
			}
		};
	} });
	responseAction.onProgress((progress, id, metadata) => {
		const parsed = getResponseMetadata(metadata);
		const waiter = parsed && pendingRequestWaiters[parsed.r];
		if (waiter && waiter.peerId === id && parsed?.e === void 0) waiter.getReceiveProgress()?.(progress, { peerId: id });
	});
	responseAction.onMessage((payload, id, metadata) => {
		const parsed = getResponseMetadata(metadata);
		if (!parsed) return;
		const waiter = pendingRequestWaiters[parsed.r];
		if (!waiter || waiter.peerId !== id) return;
		clearPendingRequestWaiter(parsed.r);
		if (parsed.e !== void 0) {
			waiter.reject(makeActionError("rejected", parsed.e));
			return;
		}
		waiter.resolve(payload);
	});
	const makeActionImpl = (type, config) => {
		if (config && "onRequest" in config && config.kind !== "request") throw mkErr("request actions must use kind: \"request\"");
		const kind = config?.kind ?? "message";
		const rawAction = makeInternalAction(type);
		const existingState = publicActions[type];
		if (existingState) {
			if (existingState.kind !== kind) throw mkErr(`action type "${type}" cannot be redefined`);
			return existingState.action;
		}
		const state = {
			kind,
			action: null,
			onReceive: config?.onReceive ?? null,
			onReceiveProgress: config?.onReceiveProgress ?? null
		};
		const toProgressHandler = (handler, metadata) => handler ? (progress, peerId) => handler(progress, withMetadata({ peerId }, metadata)) : void 0;
		const dispatchReceiveProgress = (progress, peerId, metadata) => {
			const requestMetadata = state.kind === "request" ? getRequestMetadata(metadata) : null;
			state.onReceiveProgress?.(progress, withMetadata({ peerId }, requestMetadata ? requestMetadata.m : metadata));
		};
		const setReceive = (handler) => {
			state.onReceive = handler;
			rawAction.onReceive(handler ? (context) => {
				const requestMetadata = kind === "request" ? getRequestMetadata(context.metadata) : null;
				return handler(withMetadata({
					byteLength: context.byteLength,
					peerId: context.peerId,
					signal: context.signal,
					kind
				}, requestMetadata ? requestMetadata.m : context.metadata));
			} : null);
		};
		setReceive(state.onReceive);
		rawAction.onProgress(dispatchReceiveProgress);
		if (kind === "message") {
			let onMessage = config?.onMessage ?? null;
			const receiveMessage = (payload, peerId, metadata) => {
				const handler = onMessage;
				Promise.resolve().then(() => handler(payload, withMetadata({ peerId }, metadata))).catch((err) => console.error(`${libName} action handler error:`, err));
			};
			const action = {
				send: async (data, options = {}) => {
					await rawAction.send(data, options.target, options.metadata, toProgressHandler(options.onProgress, options.metadata), options.signal);
				},
				get onMessage() {
					return onMessage;
				},
				set onMessage(handler) {
					onMessage = handler;
					rawAction.onMessage(handler ? receiveMessage : null);
				},
				get onReceive() {
					return state.onReceive;
				},
				set onReceive(handler) {
					setReceive(handler);
				},
				get onReceiveProgress() {
					return state.onReceiveProgress;
				},
				set onReceiveProgress(handler) {
					state.onReceiveProgress = handler;
				}
			};
			state.action = action;
			publicActions[type] = state;
			rawAction.onMessage(onMessage ? receiveMessage : null);
			return action;
		}
		rawAction.onReject((peerId, metadata, reason) => {
			const parsed = getRequestMetadata(metadata);
			if (parsed) responseAction.send(null, peerId, {
				r: parsed.r,
				e: reason
			}).catch(noOp);
		});
		let onRequest = config?.onRequest ?? null;
		const receiveRequest = (payload, peerId, metadata) => {
			const parsed = getRequestMetadata(metadata);
			if (!parsed) return;
			const handler = onRequest;
			const controller = new AbortController();
			let peerControllers = activeRequestControllers.get(peerId);
			if (!peerControllers) {
				peerControllers = /* @__PURE__ */ new Set();
				activeRequestControllers.set(peerId, peerControllers);
			}
			peerControllers.add(controller);
			Promise.resolve().then(async () => {
				const response = await handler(payload, {
					...withMetadata({ peerId }, parsed.m),
					signal: controller.signal
				});
				if (response === void 0) throw mkErr("request handler returned undefined");
				return response;
			}).then((response) => responseAction.send(response, peerId, { r: parsed.r }), (error) => responseAction.send(null, peerId, {
				r: parsed.r,
				e: toErrorMessage(error, "request failed").slice(0, 512)
			})).catch(noOp).finally(() => {
				const controllers = activeRequestControllers.get(peerId);
				controllers?.delete(controller);
				if (controllers && !controllers.size) activeRequestControllers.delete(peerId);
				controller.abort();
			});
		};
		const requestOne = async (data, options) => {
			const { target, metadata, onProgress, signal, timeoutMs } = options;
			throwIfAborted(signal);
			if (!getPeer(target, false)) throw makeActionError("disconnected", `no active peer with id ${target}`);
			const requestId = genId(20);
			const controller = new AbortController();
			const responsePromise = new Promise((resolve, reject) => {
				const waiter = {
					controller,
					getReceive: () => state.onReceive,
					getReceiveProgress: () => state.onReceiveProgress,
					peerId: target,
					resolve,
					reject,
					timer: null,
					...signal === void 0 ? {} : { signal }
				};
				const rejectAsAborted = () => {
					clearPendingRequestWaiter(requestId);
					reject(makeActionError("aborted", "operation aborted"));
				};
				if (signal) {
					waiter.abortHandler = rejectAsAborted;
					signal.addEventListener("abort", rejectAsAborted, { once: true });
				}
				pendingRequestWaiters[requestId] = waiter;
				if (timeoutMs !== void 0) waiter.timer = setTimeout(() => {
					clearPendingRequestWaiter(requestId);
					waiter.reject(makeActionError("timeout", "request timed out"));
				}, timeoutMs);
			});
			try {
				const sending = rawAction.send(data, target, metadata === void 0 ? { r: requestId } : {
					r: requestId,
					m: metadata
				}, toProgressHandler(onProgress, metadata), controller.signal);
				return await Promise.race([responsePromise, sending.then(() => responsePromise)]);
			} finally {
				clearPendingRequestWaiter(requestId);
			}
		};
		const action = {
			request: requestOne,
			requestMany: async (data, options) => {
				const { targets, onResult, ...requestOptions } = options;
				throwIfAborted(requestOptions.signal);
				return await all(targets.map(async (target) => {
					try {
						const result = {
							peerId: target,
							status: "fulfilled",
							value: await requestOne(data, {
								...requestOptions,
								target
							})
						};
						onResult?.(result);
						return result;
					} catch (err) {
						const error = toError(err, "request failed");
						if (error.kind === "aborted" || !error.kind) throw error;
						const result = error.kind === "timeout" ? {
							peerId: target,
							status: "timeout"
						} : error.kind === "disconnected" ? {
							peerId: target,
							status: "disconnected"
						} : {
							peerId: target,
							status: "rejected",
							error
						};
						onResult?.(result);
						return result;
					}
				}));
			},
			get onRequest() {
				return onRequest;
			},
			set onRequest(handler) {
				onRequest = handler;
				rawAction.onMessage(handler ? receiveRequest : null);
			},
			get onReceive() {
				return state.onReceive;
			},
			set onReceive(handler) {
				setReceive(handler);
			},
			get onReceiveProgress() {
				return state.onReceiveProgress;
			},
			set onReceiveProgress(handler) {
				state.onReceiveProgress = handler;
			}
		};
		state.action = action;
		publicActions[type] = state;
		rawAction.onMessage(onRequest ? receiveRequest : null);
		return action;
	};
	return {
		makeAction: makeActionImpl,
		makeInternalAction,
		handleData,
		clearPeer
	};
};
//#endregion
export { createActionManager };

