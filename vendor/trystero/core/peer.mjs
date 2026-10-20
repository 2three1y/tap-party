import { all, alloc, candidateType, libName, resetTimer, toError } from "./utils.mjs";
import { pendingDataTimeoutMs } from "./data-limits.mjs";
//#region src/peer.ts
const iceTimeout = 15e3;
const iceCandidateSettleMs = 150;
const disconnectedCloseDelayMs = 5e3;
const iceCandidateEvent = "icecandidate";
const iceStateEvent = "icegatheringstatechange";
const iceConnectionStateEvent = "iceconnectionstatechange";
const offerType = "offer";
const answerType = "answer";
const outOfRangePattern = /out of range/i;
const maxPendingRemoteCandidates = 128;
const maxRemoteCandidateSdpLength = 8192;
const rewriteMdnsCandidatesToLoopback = (sdp) => sdp.replace(/ (\S+\.local) (\d+) typ host/g, " 127.0.0.1 $2 typ host");
var peer_default = (initiator, { trickleIce, rtcConfig, rtcPolyfill, turnConfig, _test_only_mdnsHostFallbackToLoopback }) => {
	const pc = new (rtcPolyfill ?? RTCPeerConnection)({
		iceServers: defaultIceServers.concat(turnConfig ?? []),
		...rtcConfig
	});
	const handlers = {};
	const pendingIceGathering = /* @__PURE__ */ new Set();
	const pendingSignals = [];
	const pendingData = [];
	let pendingDataTimer = null;
	const shouldTrickleIce = trickleIce !== false;
	const pendingRemoteCandidates = [];
	const pendingTracks = [];
	let resolveInitialOffer;
	let makingOffer = false;
	let isSettingRemoteAnswerPending = false;
	let dataChannel = null;
	let disconnectedCloseTimer = null;
	let didEmitClose = false;
	const settleInitialOffer = (signal) => {
		if (resolveInitialOffer) {
			resolveInitialOffer(signal);
			resolveInitialOffer = void 0;
		}
	};
	const clearDisconnectedCloseTimer = () => disconnectedCloseTimer = resetTimer(disconnectedCloseTimer);
	const emitClose = () => {
		if (didEmitClose) return;
		didEmitClose = true;
		pendingIceGathering.forEach((finish) => finish());
		pendingDataTimer = resetTimer(pendingDataTimer);
		pendingData.length = 0;
		clearDisconnectedCloseTimer();
		handlers.close?.();
	};
	const emitSignal = (signal) => {
		if (signal.type === offerType) {
			settleInitialOffer(signal);
			if (!handlers.signal && !pc.remoteDescription) return;
		}
		if (handlers.signal) handlers.signal(signal);
		else pendingSignals.push(signal);
	};
	const appendSignalHandler = (handler) => {
		const previousSignalHandler = handlers.signal;
		handlers.signal = (signal) => {
			previousSignalHandler?.(signal);
			handler(signal);
		};
		if (pendingSignals.length > 0) pendingSignals.splice(0).forEach((signal) => handlers.signal?.(signal));
	};
	const normalizeSdp = (sdp) => _test_only_mdnsHostFallbackToLoopback ? rewriteMdnsCandidatesToLoopback(sdp) : sdp;
	const normalizeCandidate = (candidate) => {
		if (!_test_only_mdnsHostFallbackToLoopback || typeof candidate.candidate !== "string") return candidate;
		const normalizedCandidate = rewriteMdnsCandidatesToLoopback(candidate.candidate);
		return normalizedCandidate === candidate.candidate ? candidate : {
			...candidate,
			candidate: normalizedCandidate
		};
	};
	const localDescriptionSignal = (peerConnection) => ({
		type: peerConnection.localDescription?.type ?? offerType,
		sdp: normalizeSdp(peerConnection.localDescription?.sdp ?? "")
	});
	const getRemoteUfrag = () => {
		const sdp = pc.remoteDescription?.sdp;
		if (!sdp) return null;
		return sdp.match(/a=ice-ufrag:([^\s]+)/)?.[1] ?? null;
	};
	const getRemoteMediaSectionCount = () => (pc.remoteDescription?.sdp?.match(/^m=/gm) ?? []).length;
	const canApplyRemoteCandidate = (candidate) => {
		if (!pc.remoteDescription) return false;
		const remoteMLineCount = getRemoteMediaSectionCount();
		if (typeof candidate.sdpMLineIndex === "number" && remoteMLineCount > 0 && candidate.sdpMLineIndex >= remoteMLineCount) return false;
		const remoteUfrag = getRemoteUfrag();
		if (remoteUfrag && candidate.usernameFragment && candidate.usernameFragment !== remoteUfrag) return false;
		return true;
	};
	const addIceCandidateSafe = async (candidate) => {
		try {
			await pc.addIceCandidate(candidate);
			return true;
		} catch (err) {
			if (err instanceof Error && outOfRangePattern.test(err.message) && typeof candidate.sdpMLineIndex === "number") return false;
			throw err;
		}
	};
	const queueRemoteCandidate = (candidate) => {
		if (pendingRemoteCandidates.length >= maxPendingRemoteCandidates) pendingRemoteCandidates.shift();
		pendingRemoteCandidates.push(candidate);
	};
	const flushPendingRemoteCandidates = async () => {
		if (!pc.remoteDescription || pendingRemoteCandidates.length === 0) return;
		const remoteUfrag = getRemoteUfrag();
		const queuedCandidates = pendingRemoteCandidates.splice(0);
		const stillPending = [];
		for (const candidate of queuedCandidates) {
			if (remoteUfrag && candidate.usernameFragment && candidate.usernameFragment !== remoteUfrag) continue;
			if (!canApplyRemoteCandidate(candidate)) {
				stillPending.push(candidate);
				continue;
			}
			if (!await addIceCandidateSafe(candidate)) stillPending.push(candidate);
		}
		stillPending.forEach(queueRemoteCandidate);
	};
	const addRemoteCandidate = async (candidate) => {
		if (canApplyRemoteCandidate(candidate)) {
			if (!await addIceCandidateSafe(candidate)) queueRemoteCandidate(candidate);
			return;
		}
		queueRemoteCandidate(candidate);
	};
	const setupDataChannel = (channel) => {
		channel.binaryType = "arraybuffer";
		channel.bufferedAmountLowThreshold = 65535;
		const failData = () => {
			console.warn(`${libName}: invalid or excessive data before handler registration; disconnecting peer`);
			channel.close();
			pc.close();
			emitClose();
		};
		channel.onmessage = (e) => {
			const data = e.data;
			if (didEmitClose) return;
			if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) || data.byteLength > 16515) {
				failData();
				return;
			}
			if (handlers.data) handlers.data(data);
			else {
				if (pendingData.length >= 64) {
					failData();
					return;
				}
				if (!pendingDataTimer) pendingDataTimer = setTimeout(failData, pendingDataTimeoutMs);
				pendingData.push(data);
			}
		};
		channel.onopen = () => handlers.connect?.();
		channel.onclose = emitClose;
		channel.onerror = ({ error }) => {
			if (didEmitClose || error?.errorDetail === "sctp-failure" && (error.sctpCauseCode === 12 || /^User-Initiated Abort\b/.test(error.message))) return;
			handlers.error?.(toError(error, "data channel error"));
		};
	};
	const configuredIceServers = rtcConfig?.iceServers ?? defaultIceServers.concat(turnConfig ?? []);
	const hasServerUrlPattern = (pattern) => configuredIceServers.some(({ urls }) => (Array.isArray(urls) ? urls : [urls]).some((url) => pattern.test(url)));
	const expectsTurnCandidate = hasServerUrlPattern(/^turns?:/i);
	const expectsStunCandidate = !expectsTurnCandidate && hasServerUrlPattern(/^stuns?:/i);
	const targetCandidatePattern = expectsTurnCandidate ? /\btyp relay\b/ : expectsStunCandidate ? /\btyp (?:srflx|relay|prflx)\b/ : /\btyp (?:host|srflx|relay|prflx)\b/;
	const waitForIceGathering = async (peerConnection) => {
		await new Promise((resolve) => {
			let timeout = null;
			let settleTimeout = null;
			const finish = () => {
				resetTimer(timeout);
				resetTimer(settleTimeout);
				peerConnection.removeEventListener(iceStateEvent, checkState);
				peerConnection.removeEventListener(iceCandidateEvent, onCandidate);
				pendingIceGathering.delete(finish);
				resolve();
			};
			const scheduleSettle = (candidateLine = "") => {
				const sdp = `${peerConnection.localDescription?.sdp ?? ""}\n${candidateLine}`;
				if (targetCandidatePattern.test(sdp)) {
					resetTimer(settleTimeout);
					settleTimeout = setTimeout(finish, iceCandidateSettleMs);
				}
			};
			const checkState = () => {
				if (peerConnection.iceGatheringState === "complete" || didEmitClose) finish();
				else scheduleSettle();
			};
			const onCandidate = (event) => {
				const { candidate } = event;
				if (candidate) scheduleSettle(candidate.candidate);
				else finish();
			};
			pendingIceGathering.add(finish);
			timeout = setTimeout(finish, iceTimeout);
			peerConnection.addEventListener(iceStateEvent, checkState);
			peerConnection.addEventListener(iceCandidateEvent, onCandidate);
			checkState();
		});
		return localDescriptionSignal(peerConnection);
	};
	const emitLocalDescriptionSignal = async () => {
		const signal = shouldTrickleIce ? localDescriptionSignal(pc) : await waitForIceGathering(pc);
		if (!didEmitClose) emitSignal(signal);
		return signal;
	};
	if (initiator) {
		dataChannel = pc.createDataChannel("data");
		setupDataChannel(dataChannel);
	} else pc.ondatachannel = ({ channel }) => {
		dataChannel = channel;
		setupDataChannel(channel);
	};
	const createOffer = async (restartIce = false) => {
		if (pc.connectionState === "closed" || !restartIce && (makingOffer || pc.signalingState !== "stable")) {
			if (pc.connectionState === "closed") settleInitialOffer();
			return;
		}
		try {
			makingOffer = true;
			if (restartIce) {
				if (pc.remoteDescription && pc.signalingState !== "stable" && pc.signalingState !== "closed" && pc.localDescription?.type === offerType) await pc.setLocalDescription({ type: "rollback" });
				if (typeof pc.restartIce === "function") pc.restartIce();
			}
			await pc.setLocalDescription(restartIce ? await pc.createOffer({ iceRestart: true }) : void 0);
			return await emitLocalDescriptionSignal();
		} catch (err) {
			if (!restartIce) settleInitialOffer();
			handlers.error?.(toError(err, "failed to create local offer"));
		} finally {
			makingOffer = false;
		}
	};
	pc.onnegotiationneeded = async () => createOffer(false);
	pc.onicecandidate = ({ candidate }) => {
		if (!shouldTrickleIce || !candidate) return;
		const candidatePayload = normalizeCandidate(typeof candidate.toJSON === "function" ? candidate.toJSON() : {
			candidate: candidate.candidate,
			sdpMid: candidate.sdpMid,
			sdpMLineIndex: candidate.sdpMLineIndex,
			usernameFragment: candidate.usernameFragment
		});
		emitSignal({
			type: candidateType,
			sdp: JSON.stringify(candidatePayload)
		});
	};
	const handleConnectionStateChange = () => {
		if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
			emitClose();
			return;
		}
		if (pc.connectionState === "connected" || pc.connectionState === "connecting" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed" || pc.iceConnectionState === "checking") {
			clearDisconnectedCloseTimer();
			return;
		}
		if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") {
			if (!disconnectedCloseTimer) disconnectedCloseTimer = setTimeout(() => {
				disconnectedCloseTimer = null;
				if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") emitClose();
			}, disconnectedCloseDelayMs);
			return;
		}
	};
	pc.onconnectionstatechange = handleConnectionStateChange;
	pc.addEventListener(iceConnectionStateEvent, handleConnectionStateChange);
	pc.ontrack = (e) => {
		const stream = e.streams[0];
		if (stream) {
			if (!handlers.track && !handlers.stream) {
				pendingTracks.push({
					track: e.track,
					stream
				});
				return;
			}
			handlers.track?.(e.track, stream);
			handlers.stream?.(stream);
		}
	};
	const offerPromise = initiator ? new Promise((res) => {
		resolveInitialOffer = res;
	}) : Promise.resolve();
	if (initiator) queueMicrotask(() => {
		if (!makingOffer && pc.signalingState === "stable" && !pc.localDescription && pc.connectionState !== "closed") pc.onnegotiationneeded?.(new Event("negotiationneeded"));
	});
	return {
		connection: pc,
		get channel() {
			return dataChannel;
		},
		get isDead() {
			return pc.connectionState === "closed";
		},
		getOffer: async (restartIce = false) => {
			if (!initiator) return;
			if (restartIce) return createOffer(true);
			if (resolveInitialOffer) return offerPromise;
			if (pc.localDescription?.type === offerType) return shouldTrickleIce ? localDescriptionSignal(pc) : waitForIceGathering(pc);
			return offerPromise;
		},
		async signal(sdp) {
			if (sdp.type === "candidate") {
				if (sdp.sdp.length > maxRemoteCandidateSdpLength) return;
				try {
					const candidate = JSON.parse(sdp.sdp);
					if (candidate && typeof candidate === "object") await addRemoteCandidate(normalizeCandidate(candidate));
				} catch (err) {
					handlers.error?.(toError(err, "failed to parse remote candidate"));
				}
				return;
			}
			if (dataChannel?.readyState === "open" && !sdp.sdp?.includes("a=rtpmap")) return;
			try {
				const rtcSdp = {
					...sdp,
					sdp: normalizeSdp(sdp.sdp)
				};
				if (sdp.type === offerType) {
					const isCollision = makingOffer || pc.signalingState !== "stable" && !isSettingRemoteAnswerPending;
					if (isCollision && initiator) return;
					if (isCollision && pc.signalingState !== "stable") await all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(rtcSdp)]);
					else await pc.setRemoteDescription(rtcSdp);
					await flushPendingRemoteCandidates();
					await pc.setLocalDescription();
					return await emitLocalDescriptionSignal();
				}
				if (sdp.type === answerType) {
					isSettingRemoteAnswerPending = true;
					try {
						await pc.setRemoteDescription(rtcSdp);
						await flushPendingRemoteCandidates();
					} finally {
						isSettingRemoteAnswerPending = false;
					}
				}
			} catch (err) {
				handlers.error?.(toError(err, "failed to apply remote signal"));
			}
		},
		sendData: (data) => dataChannel?.send(data),
		destroy: () => {
			clearDisconnectedCloseTimer();
			settleInitialOffer();
			dataChannel?.close();
			pc.close();
			makingOffer = false;
			isSettingRemoteAnswerPending = false;
			emitClose();
		},
		setHandlers: (newHandlers) => {
			const { signal, ...restHandlers } = newHandlers;
			Object.assign(handlers, restHandlers);
			if (handlers.data && pendingData.length > 0) {
				pendingDataTimer = resetTimer(pendingDataTimer);
				pendingData.splice(0).forEach((data) => handlers.data?.(data));
			}
			if (signal) appendSignalHandler(signal);
			if ((handlers.track || handlers.stream) && pendingTracks.length > 0) pendingTracks.splice(0).forEach(({ track, stream }) => {
				handlers.track?.(track, stream);
				handlers.stream?.(stream);
			});
		},
		addStream: (stream) => stream.getTracks().forEach((track) => pc.addTrack(track, stream)),
		removeStream: (stream) => pc.getSenders().filter((sender) => sender.track && stream.getTracks().includes(sender.track)).forEach((sender) => pc.removeTrack(sender)),
		addTrack: (track, stream) => pc.addTrack(track, stream),
		removeTrack: (track) => {
			const sender = pc.getSenders().find((s) => s.track === track);
			if (sender) pc.removeTrack(sender);
		},
		replaceTrack: (oldTrack, newTrack) => {
			const sender = pc.getSenders().find((s) => s.track === oldTrack);
			if (sender) return sender.replaceTrack(newTrack);
		}
	};
};
const defaultIceServers = [...alloc(3, (_, i) => `stun:stun${i || ""}.l.google.com:19302`), "stun:stun.cloudflare.com:3478"].map((url) => ({ urls: url }));
//#endregion
export { peer_default as default, defaultIceServers };

