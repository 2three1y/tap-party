import { genId, mkErr, resetTimer, selfId, toError, toErrorMessage, toHex } from "./utils.mjs";
import { hashWith } from "./crypto.mjs";
//#region src/handshake.ts
const overlapRoomPasswordErr = mkErr("incorrect password for overlapping room");
const createPasswordHandshake = (password, appId, roomId) => {
	const hashChallenge = (challenge) => hashWith("SHA-256", `${challenge}:${password}:${appId}:${roomId}`).then(toHex);
	const run = async (send, receive, isInitiator) => {
		if (!password) return;
		if (isInitiator) {
			const challenge = genId(36);
			await send({
				__trystero_pw: "challenge",
				c: challenge
			});
			const { data } = await receive();
			if (!data || typeof data !== "object" || data.__trystero_pw !== "response" || typeof data.h !== "string") throw overlapRoomPasswordErr;
			const expected = await hashChallenge(challenge);
			if (data.h !== expected) throw overlapRoomPasswordErr;
			return;
		}
		const { data } = await receive();
		if (!data || typeof data !== "object" || data.__trystero_pw !== "challenge" || typeof data.c !== "string") throw overlapRoomPasswordErr;
		await send({
			__trystero_pw: "response",
			h: await hashChallenge(data.c)
		});
	};
	const compose = (userHandshake) => password || userHandshake ? async (peerId, send, receive, isInitiator) => {
		await run(send, receive, isInitiator);
		await userHandshake?.(peerId, send, receive, isInitiator);
	} : void 0;
	return {
		run,
		compose
	};
};
const toHandshakeErrorMessage = (error) => {
	const message = toErrorMessage(error, "unknown error");
	return message.startsWith("handshake ") ? message : `handshake failed: ${message}`;
};
const createHandshakeManager = ({ onPeerHandshake, onHandshakeError, handshakeTimeoutMs, sendHandshakeData, sendHandshakeReady, onActivate, onFailure }) => {
	const peerStates = {};
	const maybeActivatePeer = (id, peer) => {
		const state = peerStates[id];
		if (!state || peer && state.peer !== peer || state.isActive) return;
		if (!state.didLocalHandshakePass || !state.didReceiveRemoteReady) return;
		state.isActive = true;
		state.handshakeTimer = resetTimer(state.handshakeTimer);
		onActivate(id, state.peer);
	};
	const failPeerHandshake = (id, peer, reason) => {
		const state = peerStates[id];
		if (!state || state.peer !== peer) return;
		const error = toHandshakeErrorMessage(reason);
		onHandshakeError?.(id, error);
		onFailure(id, peer, mkErr(error));
	};
	const markLocalHandshakePassed = (id, peer) => {
		const state = peerStates[id];
		if (!state || state.peer !== peer || state.isActive) return;
		state.didLocalHandshakePass = true;
		sendHandshakeReady("", id).catch((err) => failPeerHandshake(id, peer, mkErr(`failed sending handshake readiness: ${toErrorMessage(err, "unknown send failure")}`)));
		maybeActivatePeer(id, peer);
	};
	return {
		addPeer: (id, peer) => {
			peerStates[id] = {
				peer,
				isActive: false,
				didLocalHandshakePass: false,
				didReceiveRemoteReady: false,
				handshakeTimer: null,
				pendingHandshakePayloads: [],
				handshakeWaiters: []
			};
		},
		clearPeer: (id, error) => {
			const state = peerStates[id];
			if (!state) return;
			state.handshakeTimer = resetTimer(state.handshakeTimer);
			state.pendingHandshakePayloads.length = 0;
			state.handshakeWaiters.splice(0).forEach((waiter) => waiter.reject(error));
			delete peerStates[id];
		},
		canReceiveFromPeer: (id, receiveWhilePending) => {
			const state = peerStates[id];
			return Boolean(state && (state.isActive || receiveWhilePending));
		},
		start: (id, peer) => {
			const state = peerStates[id];
			if (!state || state.peer !== peer) return;
			state.handshakeTimer = setTimeout(() => failPeerHandshake(id, peer, mkErr(`handshake timed out after ${handshakeTimeoutMs}ms`)), handshakeTimeoutMs);
			const sendHandshake = async (data, metadata) => {
				await sendHandshakeData(data, id, metadata);
			};
			const receiveHandshake = () => new Promise((resolve, reject) => {
				const current = peerStates[id];
				if (!current || current.peer !== peer) {
					reject(mkErr("peer disconnected during handshake"));
					return;
				}
				const payload = current.pendingHandshakePayloads.shift();
				if (payload) {
					resolve(payload);
					return;
				}
				current.handshakeWaiters.push({
					resolve,
					reject: (error) => reject(error)
				});
			});
			const isInitiator = selfId < id;
			Promise.resolve(onPeerHandshake?.(id, sendHandshake, receiveHandshake, isInitiator)).then(() => markLocalHandshakePassed(id, peer)).catch((err) => failPeerHandshake(id, peer, toError(err, "handshake failed")));
		},
		receiveHandshakeData: (data, id, metadata) => {
			const state = peerStates[id];
			if (!state || state.isActive) return;
			const payload = metadata === void 0 ? { data } : {
				data,
				metadata
			};
			const pending = state.handshakeWaiters.shift();
			if (pending) {
				pending.resolve(payload);
				return;
			}
			if (state.pendingHandshakePayloads.length >= 16) {
				failPeerHandshake(id, state.peer, mkErr("too many pending handshake messages"));
				return;
			}
			state.pendingHandshakePayloads.push(payload);
		},
		receiveHandshakeReady: (id) => {
			const state = peerStates[id];
			if (!state || state.isActive) return;
			state.didReceiveRemoteReady = true;
			maybeActivatePeer(id);
		}
	};
};
//#endregion
export { createHandshakeManager, createPasswordHandshake };

