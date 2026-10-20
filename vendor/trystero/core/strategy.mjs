import { all, entries, keys, libName, mkErr, noOp, resetTimer, selfId, toErrorMessage, topicPath, values, watchOnline } from "./utils.mjs";
import { decrypt, deriveRoomNamespace, encrypt, genKey, sha1 } from "./crypto.mjs";
import { OfferManager } from "./offer-manager.mjs";
import { createPasswordHandshake } from "./handshake.mjs";
import peer_default from "./peer.mjs";
import room_default from "./room.mjs";
import { SharedPeerManager } from "./shared-peer.mjs";
import { clearConnectedPeer, createSignalHandler, detachConnectedPeer, getState, markPeerConnected, resetAnsweringState, resetOfferState } from "./signal-handler.mjs";
//#region src/strategy.ts
const announceIntervalMs = 5333;
const announceWarmupIntervalsMs = [
	233,
	533,
	1333
];
const passiveActivationGraceMs = 7533;
const sharedPeerIdleMsDefault = 123333;
var strategy_default = ({ init, subscribe, announce, deactivate }) => {
	const occupiedRooms = {};
	const leavingRoomCleanups = {};
	const sharedPeers = new SharedPeerManager();
	const hasActiveRooms = () => values(occupiedRooms).some((rooms) => keys(rooms).length > 0);
	let didInit = false;
	let initPromises = [];
	let cleanupWatchOnline = noOp;
	return (config, roomId, callbacks) => {
		if (!config) throw mkErr("requires a config map as the first argument");
		if (callbacks && typeof callbacks !== "object") throw mkErr("third argument must be a callbacks object");
		const { appId } = config;
		const onJoinError = callbacks?.onJoinError;
		const onPeerHandshake = callbacks?.onPeerHandshake;
		const handshakeTimeoutMs = callbacks?.handshakeTimeoutMs;
		if (!appId) throw mkErr("config map is missing appId field");
		if (!roomId) throw mkErr("roomId argument required");
		if (config.maxReceiveBytes !== void 0 && (!Number.isSafeInteger(config.maxReceiveBytes) || config.maxReceiveBytes <= 0)) throw mkErr("maxReceiveBytes must be a positive safe integer");
		if (handshakeTimeoutMs !== void 0 && (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0)) throw mkErr("handshakeTimeoutMs must be a positive number");
		if (occupiedRooms[appId]?.[roomId]) return occupiedRooms[appId][roomId];
		leavingRoomCleanups[appId]?.[roomId]?.(true);
		const rootTopicPlaintext = topicPath(libName, appId, roomId);
		const rootTopicP = sha1(rootTopicPlaintext);
		const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId));
		const key = genKey(config.password ?? "", appId, roomId);
		const roomNamespacePromise = deriveRoomNamespace(appId, roomId);
		const sharedPeerIdleMs = config._test_only_sharedPeerIdleMs ?? sharedPeerIdleMsDefault;
		let didLeaveRoom = false;
		const withKey = (f) => async (signal) => ({
			type: signal.type,
			sdp: await f(key, signal.sdp)
		});
		const toPlain = withKey(decrypt);
		const toCipher = withKey(encrypt);
		const makeOffer = () => peer_default(true, config);
		let reannounceOnDisconnect = false;
		const offerManager = new OfferManager(makeOffer);
		const encryptOffer = async (peer) => {
			const plainOffer = await peer.getOffer();
			if (!plainOffer || plainOffer.type !== "offer") throw mkErr("failed to get offer for peer");
			return (await toCipher(plainOffer)).sdp;
		};
		const connectPeer = (peer, peerId) => {
			membership.connect(peerId, peer, sharedPeerIdleMs);
		};
		let disconnectReannounceQueued = false;
		const reannounceAfterDisconnect = () => {
			if (isPassive || !reannounceOnDisconnect || disconnectReannounceQueued) return;
			disconnectReannounceQueued = true;
			queueMicrotask(() => {
				disconnectReannounceQueued = false;
				if (!didLeaveRoom) ctx.requeueAnnounce?.();
			});
		};
		const disconnectPeer = (peer, peerId) => {
			if (didLeaveRoom) return;
			const state = ctx.peerStates[peerId];
			if (state?.connectedPeer === peer) {
				clearConnectedPeer(state, peerId, "close-event");
				checkDeactivate();
				reannounceAfterDisconnect();
			}
		};
		const isPassive = Boolean(config.passive);
		let passiveActivationTimeout;
		let deactivateRelayAnnouncements = noOp;
		const checkDeactivate = () => {
			if (!isPassive || !ctx.isActive) return;
			let hasActiveWork = false;
			entries(ctx.peerStates).forEach(([peerId, state]) => {
				if (state.connectedPeer || state.answeringPeer || state.offerInitPromise || state.offerPeer || state.offerRelays.some(Boolean)) hasActiveWork = true;
				else delete ctx.peerStates[peerId];
			});
			if (!hasActiveWork) {
				ctx.isActive = false;
				passiveActivationTimeout = resetTimer(passiveActivationTimeout);
				announceTimeouts.forEach(resetTimer);
				announceTimeouts.length = 0;
				deactivateRelayAnnouncements();
				membership.setActive(false);
			}
		};
		const ctx = {
			appId,
			roomId,
			config,
			peerStates: {},
			rootTopicPlaintext,
			rootTopicP,
			selfTopicP,
			toPlain,
			toCipher,
			isLeaving: () => didLeaveRoom,
			isPassive,
			isActive: !isPassive,
			onJoinError,
			offerManager,
			encryptOffer,
			initPeer: peer_default,
			connectPeer,
			disconnectPeer,
			reusePeer: (peerId) => membership.reuse(peerId),
			checkDeactivate,
			announceIntervals: [],
			announceIntervalMs
		};
		const strategyContext = {
			config,
			appId,
			roomId,
			isPassive
		};
		const handleMessage = createSignalHandler(ctx);
		if (!didInit) {
			const initRes = init(config);
			initPromises = (Array.isArray(initRes) ? initRes : [initRes]).map((value) => Promise.resolve(value));
			didInit = true;
			cleanupWatchOnline = config.relayConfig?.manualReconnection ? noOp : watchOnline();
		}
		const announceScheduleIntervals = initPromises.map(() => announceIntervalMs);
		const announceAttemptCounts = initPromises.map(() => 0);
		const announceErrorStreaks = initPromises.map(() => 0);
		const announceTimeouts = [];
		const unsubFns = initPromises.map(async (relayP, i) => subscribe(await relayP, await rootTopicP, await selfTopicP, handleMessage(i), (n) => offerManager.getOffers(n, encryptOffer), strategyContext));
		all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
			if (didLeaveRoom) return;
			const queueAnnounce = async (relay, i) => {
				if (didLeaveRoom) return;
				if (isPassive && !ctx.isActive) return;
				const extra = isPassive ? { passive: true } : void 0;
				let announceResult = void 0;
				try {
					announceResult = await announce(relay, rootTopic, selfTopic, extra, strategyContext);
					announceErrorStreaks[i] = 0;
				} catch (error) {
					if (didLeaveRoom) return;
					const errorStreak = announceErrorStreaks[i] ?? 0;
					if (errorStreak === 0 && config.relayConfig?.warnOnRelayFailure !== false) console.warn(`${libName}: announce failed - ${toErrorMessage(error, "")}`);
					announceErrorStreaks[i] = errorStreak + 1;
				}
				if (didLeaveRoom || isPassive && !ctx.isActive) return;
				if (announceResult && typeof announceResult !== "number" && "stopAnnouncing" in announceResult) return;
				if (typeof announceResult === "number") {
					ctx.announceIntervals[i] = announceResult;
					announceScheduleIntervals[i] = announceResult;
				} else if (announceResult) {
					announceScheduleIntervals[i] = announceResult.nextAnnounceMs;
					reannounceOnDisconnect ||= announceResult.reannounceOnDisconnect === true;
				}
				const announceAttempt = announceAttemptCounts[i] ?? 0;
				announceAttemptCounts[i] = announceAttempt + 1;
				const currentInterval = announceScheduleIntervals[i] ?? announceIntervalMs;
				const warmupDelay = announceWarmupIntervalsMs[announceAttempt] ?? (announceAttempt === 3 && typeof announceResult === "object" ? announceIntervalMs : void 0);
				announceTimeouts[i] = setTimeout(() => {
					queueAnnounce(relay, i);
				}, typeof warmupDelay === "number" ? Math.min(currentInterval, warmupDelay) : currentInterval);
			};
			deactivateRelayAnnouncements = () => {
				if (!deactivate) return;
				initPromises.forEach(async (relayP) => {
					const relay = await relayP;
					if (!didLeaveRoom) deactivate(relay, rootTopic, selfTopic, strategyContext);
				});
			};
			ctx.requeueAnnounce = () => {
				announceTimeouts.forEach(resetTimer);
				announceTimeouts.length = 0;
				passiveActivationTimeout = resetTimer(passiveActivationTimeout);
				membership.setActive(true);
				passiveActivationTimeout = setTimeout(checkDeactivate, passiveActivationGraceMs);
				initPromises.forEach(async (relayP, i) => {
					const relay = await relayP;
					if (relay && !didLeaveRoom) {
						announceAttemptCounts[i] = 0;
						queueAnnounce(relay, i);
					}
				});
			};
			unsubFns.forEach(async (didSub, i) => {
				await didSub;
				if (didLeaveRoom) return;
				const relay = await initPromises[i];
				if (relay && !didLeaveRoom && (!isPassive || ctx.isActive)) queueAnnounce(relay, i);
			});
		});
		let onPeerConnect = noOp;
		const sharedPassword = config.password ?? "";
		const { compose } = createPasswordHandshake(sharedPassword, appId, roomId);
		const composedPeerHandshake = compose(onPeerHandshake);
		const releaseOccupiedRoom = () => {
			if (occupiedRooms[appId]?.[roomId] === joinedRoom) {
				delete occupiedRooms[appId][roomId];
				if (keys(occupiedRooms[appId]).length === 0) delete occupiedRooms[appId];
			}
		};
		const clearLeavingCleanup = () => {
			if (leavingRoomCleanups[appId]?.[roomId] === cleanupRoom) {
				delete leavingRoomCleanups[appId][roomId];
				if (keys(leavingRoomCleanups[appId]).length === 0) delete leavingRoomCleanups[appId];
			}
		};
		const cleanupRoom = (rejoining = false) => {
			if (didLeaveRoom) return;
			didLeaveRoom = true;
			onPeerConnect = noOp;
			releaseOccupiedRoom();
			clearLeavingCleanup();
			membership.leave();
			entries(ctx.peerStates).forEach(([peerId, state]) => {
				if (state.connectedPeer && !state.connectedPeer.isDead) {
					if (!sharedPeers.owns(appId, peerId, state.connectedPeer)) state.connectedPeer.destroy();
				}
				if (state.answeringPeer && !state.answeringPeer.isDead) state.answeringPeer.destroy();
				resetOfferState(state);
				resetAnsweringState(state);
				state.connectedPeer = null;
				state.connectedPeerUnhealthySinceMs = null;
			});
			announceTimeouts.forEach(resetTimer);
			passiveActivationTimeout = resetTimer(passiveActivationTimeout);
			unsubFns.forEach(async (f) => {
				(await f)();
			});
			offerManager.destroy();
			if (rejoining || hasActiveRooms()) return;
			didInit = false;
			cleanupWatchOnline();
		};
		const roomOptions = {
			...config.maxReceiveBytes === void 0 ? {} : { maxReceiveBytes: config.maxReceiveBytes },
			...composedPeerHandshake ? { onPeerHandshake: composedPeerHandshake } : {},
			...handshakeTimeoutMs === void 0 ? {} : { handshakeTimeoutMs },
			isPassive,
			onBeforeLeave: () => {
				releaseOccupiedRoom();
				(leavingRoomCleanups[appId] ??= {})[roomId] = cleanupRoom;
			},
			onHandshakeError: (peerId, error) => onJoinError?.({
				error: error.replace(/^handshake failed: /, ""),
				appId,
				peerId,
				roomId
			})
		};
		occupiedRooms[appId] ??= {};
		const joinedRoom = room_default((f) => onPeerConnect = f, (id) => {
			if (didLeaveRoom) return;
			const state = ctx.peerStates[id];
			if (state?.connectedPeer) detachConnectedPeer(state, state.connectedPeer);
			checkDeactivate();
			reannounceAfterDisconnect();
		}, () => cleanupRoom(false), roomOptions);
		const membership = sharedPeers.registerRoom(appId, roomId, roomNamespacePromise, {
			active: !isPassive || ctx.isActive,
			onPeer: (proxy, peerId, physical) => {
				const state = getState(ctx.peerStates, peerId);
				markPeerConnected(state, physical);
				if (isPassive && !ctx.isActive) {
					ctx.isActive = true;
					membership.setActive(true);
					if (ctx.requeueAnnounce) ctx.requeueAnnounce();
					else {
						passiveActivationTimeout = resetTimer(passiveActivationTimeout);
						passiveActivationTimeout = setTimeout(checkDeactivate, passiveActivationGraceMs);
					}
				}
				onPeerConnect(proxy, peerId);
				resetOfferState(state);
			},
			onDetach: (peerId, physical) => {
				detachConnectedPeer(ctx.peerStates[peerId], physical);
				checkDeactivate();
			}
		});
		return occupiedRooms[appId][roomId] = joinedRoom;
	};
};
//#endregion
export { strategy_default as default };

