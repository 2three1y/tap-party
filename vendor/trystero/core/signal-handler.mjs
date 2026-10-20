import { all, candidateType, fromJson, genId, mkErr, resetTimer, selfId, toJson, topicPath } from "./utils.mjs";
import { sha1 } from "./crypto.mjs";
import { getConnectedPeerHealth } from "./shared-peer.mjs";
//#region src/signal-handler.ts
const offerPostAnswerTtlMs = 23333;
const offerTtl = 57333;
const offerIdSize = 12;
const disconnectedPeerGraceMs = 7533;
const answeringTtlMs = 23333;
const offerRelayPlaceholder = "offer-placeholder";
const signalKeys = [
	"offer",
	"answer",
	"candidate"
];
const toPayload = (msg) => {
	if (typeof msg === "string") try {
		const parsed = fromJson(msg);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
	return msg && typeof msg === "object" && !Array.isArray(msg) ? msg : null;
};
const getString = (payload, key) => typeof payload[key] === "string" && payload[key] ? payload[key] : void 0;
const isPeerHandle = (value) => Boolean(value && typeof value === "object" && typeof value.signal === "function" && typeof value.destroy === "function" && typeof value.setHandlers === "function");
const hasInvalidSignalField = (payload, isStringMessage = false) => signalKeys.some((key) => key in payload && (typeof payload[key] !== "string" || payload[key] === "")) || "peer" in payload && (isStringMessage || payload["peer"] !== void 0 && !isPeerHandle(payload["peer"]));
const shouldActivatePassiveRoom = (msg) => {
	const payload = toPayload(msg);
	if (!payload || hasInvalidSignalField(payload, typeof msg === "string")) return false;
	const peerId = getString(payload, "peerId");
	return Boolean(peerId && peerId !== selfId && payload["passive"] !== true && !getString(payload, "answer") && !getString(payload, "candidate"));
};
const publishCipheredSignalingMessage = (ctx, signal, peerTopic, signalPeer, buildPayload, stillValid) => {
	ctx.toCipher(signal).then((encryptedSignal) => {
		if (ctx.isLeaving() || !stillValid()) return;
		signalPeer(peerTopic, toJson(buildPayload(encryptedSignal.sdp)));
	});
};
const makeState = () => ({
	offerPeer: null,
	offerId: null,
	offerSdp: null,
	offerInitPromise: null,
	offerAnswered: false,
	offerRelays: [],
	offerSignalRelays: [],
	offerSignalBacklog: [],
	offerRelayTimers: [],
	offerExpiryTimer: null,
	connectedPeer: null,
	connectedPeerUnhealthySinceMs: null,
	answeringExpiryTimer: null,
	answeringPeer: null,
	answerSent: false,
	answerReplay: null,
	connectionErrorReported: false
});
const hasTurnServer = (config) => {
	return [...config.turnConfig ?? [], ...config.rtcConfig?.iceServers ?? []].some(({ urls }) => {
		return (Array.isArray(urls) ? urls : [urls]).some((url) => /^turns?:/i.test(url));
	});
};
const getSdpExchangeConnectionError = (peerId, config) => `could not connect to peer ${peerId} after exchanging SDP; ${hasTurnServer(config) ? "check that your TURN server URLs and credentials are reachable by both peers" : "configure TURN servers with turnConfig or rtcConfig.iceServers"}`;
const reportSdpExchangeConnectionFailure = (ctx, state, peerId) => {
	if (ctx.isLeaving() || state.connectedPeer || state.connectionErrorReported) return;
	state.connectionErrorReported = true;
	ctx.onJoinError?.({
		error: getSdpExchangeConnectionError(peerId, ctx.config),
		appId: ctx.appId,
		peerId,
		roomId: ctx.roomId
	});
};
const getState = (peerStates, peerId) => peerStates[peerId] ??= makeState();
const counterAnnounceTimestamps = /* @__PURE__ */ new WeakMap();
const resetAnsweringState = (state) => {
	counterAnnounceTimestamps.delete(state);
	state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer);
	state.answeringPeer = null;
	state.answerSent = false;
	state.answerReplay = null;
};
const clearAnswering = (state, peer) => {
	if (state.answeringPeer === peer) {
		resetAnsweringState(state);
		if (state.connectedPeer !== peer && !peer.isDead) peer.destroy();
	}
};
const markPeerConnected = (state, physical) => {
	if (state.answeringPeer && state.answeringPeer !== physical && !state.answeringPeer.isDead) state.answeringPeer.destroy();
	resetAnsweringState(state);
	state.connectedPeer = physical;
	state.connectedPeerUnhealthySinceMs = null;
};
const detachConnectedPeer = (state, physical) => {
	if (state?.connectedPeer === physical) {
		state.connectedPeer = null;
		state.connectedPeerUnhealthySinceMs = null;
	}
};
const clearConnectedPeer = (state, peerId, _reason) => {
	if (!state.connectedPeer) return;
	if (!state.connectedPeer.isDead) state.connectedPeer.destroy();
	state.connectedPeer = null;
	state.connectedPeerUnhealthySinceMs = null;
};
const clearOfferRelay = (state, relayId) => {
	state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId]);
	if (state.offerRelays[relayId]) state.offerRelays[relayId] = void 0;
};
const clearOfferRelayIfPlaceholder = (state, relayId) => {
	if (state?.offerRelays[relayId] === offerRelayPlaceholder) clearOfferRelay(state, relayId);
};
const resetOfferState = (state) => {
	counterAnnounceTimestamps.delete(state);
	state.offerExpiryTimer = resetTimer(state.offerExpiryTimer);
	state.offerInitPromise = null;
	state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId));
	state.offerRelays = [];
	state.offerSignalRelays = [];
	state.offerRelayTimers = [];
	state.offerSignalBacklog = [];
	if (state.offerPeer && state.offerPeer !== state.connectedPeer) {
		if (!state.offerPeer.isDead) state.offerPeer.destroy();
	}
	state.offerPeer = null;
	state.offerId = null;
	state.offerSdp = null;
	state.offerAnswered = false;
	state.connectionErrorReported = false;
};
const scheduleAnsweringExpiry = (ctx, state, peerId, peer) => {
	resetTimer(state.answeringExpiryTimer);
	state.answeringExpiryTimer = setTimeout(() => {
		const current = ctx.peerStates[peerId];
		if (!current || current.connectedPeer || current.answeringPeer !== peer) return;
		if (current.answerSent) reportSdpExchangeConnectionFailure(ctx, current, peerId);
		clearAnswering(current, peer);
		ctx.checkDeactivate();
	}, answeringTtlMs);
};
const scheduleOfferExpiry = (ctx, state, peerId, ttlMs = offerTtl) => {
	resetTimer(state.offerExpiryTimer);
	const offerId = state.offerId;
	state.offerExpiryTimer = setTimeout(() => {
		const current = ctx.peerStates[peerId];
		if (!current || current.connectedPeer || current.offerId !== offerId) return;
		if (current.offerAnswered) reportSdpExchangeConnectionFailure(ctx, current, peerId);
		resetOfferState(current);
		ctx.checkDeactivate();
	}, ttlMs);
};
const bindOfferPeerHandlers = (ctx, state, peerId, peer, onSignal) => {
	const onOfferPeerClosedOrError = () => {
		if (state.offerPeer === peer && !state.connectedPeer) {
			if (state.offerAnswered) reportSdpExchangeConnectionFailure(ctx, state, peerId);
			resetOfferState(state);
		}
		ctx.disconnectPeer(peer, peerId);
		ctx.checkDeactivate();
	};
	peer.setHandlers({
		connect: () => ctx.connectPeer(peer, peerId),
		...onSignal ? { signal: onSignal } : {},
		close: onOfferPeerClosedOrError,
		error: onOfferPeerClosedOrError
	});
};
const ensureOffer = (ctx, state, peerId) => {
	if (state.offerPeer && state.offerId && state.offerSdp) return Promise.resolve({
		peer: state.offerPeer,
		offer: state.offerSdp,
		offerId: state.offerId
	});
	if (state.offerInitPromise) return state.offerInitPromise;
	const allocateOffer = async () => {
		let firstOffer;
		try {
			firstOffer = (await ctx.offerManager.checkout(1, false, ctx.encryptOffer))[0];
		} catch (error) {
			if (ctx.isLeaving() || state.offerInitPromise !== pending) return null;
			throw error;
		}
		if (!firstOffer) throw mkErr("failed to allocate offer peer");
		const { peer, offer } = firstOffer;
		if (ctx.isLeaving() || state.offerInitPromise !== pending) {
			peer.destroy();
			return null;
		}
		state.offerPeer = peer;
		state.offerId = genId(offerIdSize);
		state.offerSdp = offer;
		state.offerAnswered = false;
		state.connectionErrorReported = false;
		state.offerSignalBacklog = [];
		bindOfferPeerHandlers(ctx, state, peerId, peer, (signal) => {
			if (state.offerPeer !== peer) return;
			state.offerSignalBacklog.push(signal);
			state.offerSignalRelays.forEach((sendSignal) => sendSignal?.(signal));
		});
		scheduleOfferExpiry(ctx, state, peerId);
		return {
			peer,
			offer,
			offerId: state.offerId
		};
	};
	const pending = allocateOffer().finally(() => {
		if (state.offerInitPromise === pending) state.offerInitPromise = null;
	});
	return state.offerInitPromise = pending;
};
const handleAnnouncement = async (ctx, relayId, peerId, signalPeer, retryAttempt = 0) => {
	const state = ctx.peerStates[peerId];
	if (!state || state.connectedPeer || state.answeringPeer || state.offerAnswered) {
		clearOfferRelayIfPlaceholder(state, relayId);
		return;
	}
	if (state.offerRelays[relayId] !== offerRelayPlaceholder) return;
	const [peerTopic, offerInfo] = await all([sha1(topicPath(ctx.rootTopicPlaintext, peerId)), ensureOffer(ctx, state, peerId)]);
	if (!offerInfo) {
		clearOfferRelayIfPlaceholder(state, relayId);
		return;
	}
	if (ctx.isLeaving()) {
		resetOfferState(state);
		return;
	}
	if (state.connectedPeer || state.answeringPeer || state.offerAnswered || state.offerRelays[relayId] !== offerRelayPlaceholder) {
		clearOfferRelayIfPlaceholder(state, relayId);
		return;
	}
	state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId]);
	state.offerRelays[relayId] = true;
	state.offerRelayTimers[relayId] = setTimeout(() => {
		if (retryAttempt >= 2 || ctx.isLeaving() || state.connectedPeer || state.answeringPeer || state.offerAnswered || state.offerPeer !== offerInfo.peer || state.offerId !== offerInfo.offerId) {
			prunePendingOffer(ctx, peerId, relayId);
			return;
		}
		state.offerRelays[relayId] = offerRelayPlaceholder;
		handleAnnouncement(ctx, relayId, peerId, signalPeer, retryAttempt + 1);
	}, retryAttempt === 0 && ctx.announceIntervals[relayId] === void 0 ? 2e3 : (ctx.announceIntervals[relayId] ?? ctx.announceIntervalMs) * .9);
	let didSendOffer = false;
	state.offerSignalRelays[relayId] = (signal) => {
		if (!didSendOffer) return;
		if (ctx.isLeaving() || state.connectedPeer || state.offerPeer !== offerInfo.peer || state.offerId !== offerInfo.offerId || signal.type !== "candidate") return;
		publishCipheredSignalingMessage(ctx, signal, peerTopic, signalPeer, (sdp) => ({
			peerId: selfId,
			offerId: offerInfo.offerId,
			candidate: sdp,
			...ctx.isPassive ? { passive: true } : {}
		}), () => !state.connectedPeer && state.offerPeer === offerInfo.peer && state.offerId === offerInfo.offerId);
	};
	signalPeer(peerTopic, toJson({
		peerId: selfId,
		offerId: offerInfo.offerId,
		offer: offerInfo.offer,
		...ctx.isPassive ? { passive: true } : {}
	}));
	didSendOffer = true;
	state.offerSignalBacklog.forEach((signal) => state.offerSignalRelays[relayId]?.(signal));
};
const handleOffer = async (ctx, relayId, peerId, offer, offerId, signalPeer) => {
	const state = getState(ctx.peerStates, peerId);
	if (state.answeringPeer || state.offerAnswered) {
		const replay = state.answerReplay;
		const lastSentAt = replay?.lastSentAt[relayId];
		if (state.answeringPeer && !state.answeringPeer.isDead && replay && replay.offer === offer && replay.offerId === offerId && (lastSentAt === void 0 || Date.now() - lastSentAt >= 1e3)) {
			replay.lastSentAt[relayId] = Date.now();
			const peerTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId));
			if (!ctx.isLeaving() && state.answerReplay === replay && !state.connectedPeer) {
				const send = (message) => signalPeer(peerTopic, message);
				replay.relays[relayId] = send;
				replay.messages.forEach(send);
			}
		}
		return;
	}
	const hasTrackedOutgoingOffer = Boolean(state.offerPeer || state.offerRelays.some(Boolean));
	if (hasTrackedOutgoingOffer && selfId < peerId) return;
	if (hasTrackedOutgoingOffer) resetOfferState(state);
	const answerPeer = ctx.initPeer(false, ctx.config);
	const replay = {
		offer,
		offerId,
		messages: [],
		lastSentAt: [],
		relays: []
	};
	replay.lastSentAt[relayId] = Date.now();
	state.answeringPeer = answerPeer;
	state.answerSent = false;
	state.answerReplay = replay;
	state.connectionErrorReported = false;
	scheduleAnsweringExpiry(ctx, state, peerId, answerPeer);
	const onAnswerPeerClosedOrError = () => {
		if (state.answeringPeer === answerPeer && !state.connectedPeer && state.answerSent) reportSdpExchangeConnectionFailure(ctx, state, peerId);
		clearAnswering(state, answerPeer);
		ctx.disconnectPeer(answerPeer, peerId);
		ctx.checkDeactivate();
	};
	answerPeer.setHandlers({
		connect: () => ctx.connectPeer(answerPeer, peerId),
		close: onAnswerPeerClosedOrError,
		error: onAnswerPeerClosedOrError
	});
	let plainOffer;
	try {
		plainOffer = await ctx.toPlain({
			type: "offer",
			sdp: offer
		});
	} catch {
		clearAnswering(state, answerPeer);
		ctx.onJoinError?.({
			error: "incorrect room password when decrypting offer",
			appId: ctx.appId,
			peerId,
			roomId: ctx.roomId
		});
		return;
	}
	if (answerPeer.isDead) {
		clearAnswering(state, answerPeer);
		return;
	}
	const peerTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId));
	if (ctx.isLeaving() || state.answerReplay !== replay) return;
	replay.relays[relayId] = (message) => signalPeer(peerTopic, message);
	const pendingCandidates = [];
	let didSendAnswer = false;
	const publishAnswerSignal = (signal) => {
		ctx.toCipher(signal).then((encryptedSignal) => {
			if (ctx.isLeaving() || state.answeringPeer !== answerPeer || answerPeer.isDead) return;
			const payloadToSend = { peerId: selfId };
			if (signal.type === "answer") {
				state.answerSent = true;
				payloadToSend["answer"] = encryptedSignal.sdp;
			} else payloadToSend["candidate"] = encryptedSignal.sdp;
			if (offerId) payloadToSend["offerId"] = offerId;
			if (ctx.isPassive) payloadToSend["passive"] = true;
			const message = toJson(payloadToSend);
			const now = Date.now();
			replay.messages.push(message);
			replay.relays.forEach((send, id) => {
				if (send) {
					replay.lastSentAt[id] = now;
					send(message);
				}
			});
			if (signal.type === "answer" && !didSendAnswer) {
				didSendAnswer = true;
				pendingCandidates.splice(0).forEach(publishAnswerSignal);
			}
		});
	};
	answerPeer.setHandlers({ signal: (signal) => {
		if (ctx.isLeaving() || state.answeringPeer !== answerPeer || answerPeer.isDead) return;
		if (signal.type !== "answer" && signal.type !== "candidate") return;
		if (signal.type === "candidate" && !didSendAnswer) {
			pendingCandidates.push(signal);
			return;
		}
		publishAnswerSignal(signal);
	} });
	await answerPeer.signal(plainOffer);
};
const handleCandidate = async (ctx, peerId, candidate, offerId, peer) => {
	let plainCandidate;
	try {
		plainCandidate = await ctx.toPlain({
			type: candidateType,
			sdp: candidate
		});
	} catch {
		return;
	}
	const state = ctx.peerStates[peerId];
	const offerPeerMatch = offerId && state?.offerPeer && state.offerId === offerId ? state.offerPeer : null;
	const answeringPeer = !offerId || state?.answerReplay?.offerId === offerId ? state?.answeringPeer : null;
	const fallbackOfferPeer = !offerId && state?.offerPeer ? state.offerPeer : null;
	const targetPeer = peer && !peer.isDead ? peer : offerPeerMatch ?? answeringPeer ?? fallbackOfferPeer;
	if (targetPeer && !targetPeer.isDead) targetPeer.signal(plainCandidate);
};
const handleAnswer = async (ctx, peerId, answer, offerId, peer) => {
	let plainAnswer;
	try {
		plainAnswer = await ctx.toPlain({
			type: "answer",
			sdp: answer
		});
	} catch {
		if (peer) {
			ctx.offerManager.reclaimLeased(peer);
			if (!peer.isDead) peer.destroy();
		}
		ctx.onJoinError?.({
			error: "incorrect room password when decrypting answer",
			appId: ctx.appId,
			peerId,
			roomId: ctx.roomId
		});
		return;
	}
	if (peer) {
		const state = getState(ctx.peerStates, peerId);
		ctx.offerManager.claimLeased(peer);
		if (state.connectedPeer || state.offerAnswered || state.answeringPeer && !state.answeringPeer.isDead && selfId > peerId) {
			peer.destroy();
			return;
		}
		if (state.answeringPeer) {
			const answeringPeer = state.answeringPeer;
			clearAnswering(state, answeringPeer);
		}
		resetOfferState(state);
		state.offerPeer = peer;
		state.offerId = offerId ?? null;
		state.offerAnswered = true;
		scheduleOfferExpiry(ctx, state, peerId, offerPostAnswerTtlMs);
		bindOfferPeerHandlers(ctx, state, peerId, peer);
		peer.signal(plainAnswer);
	} else {
		const state = ctx.peerStates[peerId];
		if (!state || !state.offerPeer || state.offerAnswered || offerId && state.offerId && offerId !== state.offerId || state.offerPeer.isDead) return;
		state.offerAnswered = true;
		scheduleOfferExpiry(ctx, state, peerId, offerPostAnswerTtlMs);
		state.offerPeer.signal(plainAnswer);
	}
};
const prunePendingOffer = (ctx, peerId, relayId) => {
	const state = ctx.peerStates[peerId];
	if (!state || state.connectedPeer) return;
	if (state.offerRelays[relayId]) {
		clearOfferRelay(state, relayId);
		ctx.checkDeactivate();
	}
};
const createSignalHandler = (ctx) => (relayId) => async (topic, msg, signalPeer) => {
	if (ctx.isLeaving()) return;
	const payload = toPayload(msg);
	if (!payload || hasInvalidSignalField(payload, typeof msg === "string")) return;
	const peerId = getString(payload, "peerId") ?? "";
	const offer = getString(payload, "offer");
	const answer = getString(payload, "answer");
	const candidate = getString(payload, "candidate");
	const offerId = getString(payload, "offerId");
	const peer = isPeerHandle(payload["peer"]) ? payload["peer"] : void 0;
	const remoteIsPassive = payload["passive"] === true;
	if (!peerId || peerId === selfId) return;
	const [rootTopic, selfTopic] = await all([ctx.rootTopicP, ctx.selfTopicP]);
	if (ctx.isLeaving()) return;
	if (topic !== rootTopic && topic !== selfTopic) return;
	if (ctx.isPassive && remoteIsPassive) return;
	if (ctx.isPassive && !ctx.isActive && !answer && !candidate) {
		ctx.isActive = true;
		ctx.requeueAnnounce?.();
	}
	if (ctx.isPassive && !ctx.isActive) return;
	const state = ctx.peerStates[peerId];
	const connectedPeer = state?.connectedPeer;
	if (connectedPeer && state) {
		const health = getConnectedPeerHealth(connectedPeer);
		if (health === "live") {
			state.connectedPeerUnhealthySinceMs = null;
			return;
		}
		if (health === "stale") clearConnectedPeer(state, peerId, "message-from-stale-peer");
		else {
			const nowMs = Date.now();
			const unhealthySinceMs = state.connectedPeerUnhealthySinceMs ?? nowMs;
			state.connectedPeerUnhealthySinceMs = unhealthySinceMs;
			if (nowMs - unhealthySinceMs < disconnectedPeerGraceMs) return;
			clearConnectedPeer(state, peerId, "message-from-prolonged-disconnect");
		}
	}
	if (ctx.reusePeer(peerId)) return;
	if (Boolean(peerId && !offer && !answer && !candidate)) {
		const announcePeerState = getState(ctx.peerStates, peerId);
		const shouldLeadOffer = selfId < peerId;
		if (announcePeerState.answeringPeer || announcePeerState.connectedPeer || announcePeerState.offerAnswered) return;
		if (!shouldLeadOffer && !announcePeerState.offerPeer) {
			let lastSentByRelay = counterAnnounceTimestamps.get(announcePeerState);
			if (!lastSentByRelay) {
				lastSentByRelay = [];
				counterAnnounceTimestamps.set(announcePeerState, lastSentByRelay);
			}
			const lastSentAt = lastSentByRelay[relayId];
			if (lastSentAt !== void 0 && Date.now() - lastSentAt < 1e3) return;
			lastSentByRelay[relayId] = Date.now();
			const peerSelfTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId));
			if (!ctx.isLeaving() && !announcePeerState.connectedPeer && !announcePeerState.answeringPeer && !announcePeerState.offerAnswered) signalPeer(peerSelfTopic, toJson({ peerId: selfId }));
			return;
		}
		if (announcePeerState.offerRelays[relayId]) return;
		announcePeerState.offerRelays[relayId] = offerRelayPlaceholder;
		return handleAnnouncement(ctx, relayId, peerId, signalPeer);
	}
	if (offer) return handleOffer(ctx, relayId, peerId, offer, offerId, signalPeer);
	if (candidate) return handleCandidate(ctx, peerId, candidate, offerId, peer);
	if (answer) return handleAnswer(ctx, peerId, answer, offerId, peer);
};
//#endregion
export { clearConnectedPeer, createSignalHandler, detachConnectedPeer, getState, markPeerConnected, resetAnsweringState, resetOfferState, shouldActivatePassiveRoom };

