import { decodeBytes, encodeBytes, keys, libName, mkErr, noOp, resetTimer, values } from "./utils.mjs";
import { pendingDataTimeoutMs } from "./data-limits.mjs";
import { createMediaIdentityCache } from "./media.mjs";
//#region src/shared-peer.ts
const roomFrameVersion = 1;
const roomPresenceFrameVersion = 2;
const wrapRoomFrame = (roomToken, data) => {
	const tokenBytes = encodeBytes(roomToken);
	const frame = new Uint8Array(3 + tokenBytes.byteLength + data.byteLength);
	frame[0] = roomFrameVersion;
	frame[1] = tokenBytes.byteLength >>> 8 & 255;
	frame[2] = tokenBytes.byteLength & 255;
	frame.set(tokenBytes, 3);
	frame.set(data, 3 + tokenBytes.byteLength);
	return frame;
};
const wrapRoomPresenceFrame = (roomToken, isPresent) => {
	const tokenBytes = encodeBytes(roomToken);
	const frame = new Uint8Array(4 + tokenBytes.byteLength);
	frame[0] = roomPresenceFrameVersion;
	frame[1] = Number(isPresent);
	frame[2] = tokenBytes.byteLength >>> 8 & 255;
	frame[3] = tokenBytes.byteLength & 255;
	frame.set(tokenBytes, 4);
	return frame;
};
const decodeRoomTokenHeader = (buffer, offset) => {
	if (buffer.byteLength < offset + 2) return null;
	const tokenSize = (buffer[offset] ?? 0) << 8 | (buffer[offset + 1] ?? 0);
	const headerSize = offset + 2 + tokenSize;
	if (tokenSize <= 0 || tokenSize > 128 || buffer.byteLength < headerSize) return null;
	return {
		roomToken: decodeBytes(buffer.subarray(offset + 2, headerSize)),
		headerSize
	};
};
const unwrapFrame = (data) => {
	const buffer = new Uint8Array(data);
	if (buffer.byteLength < 3 || buffer.byteLength > 16515) return null;
	if (buffer[0] === roomFrameVersion) {
		const header = decodeRoomTokenHeader(buffer, 1);
		return header ? {
			type: "room",
			roomToken: header.roomToken,
			payload: buffer.subarray(header.headerSize).slice().buffer
		} : null;
	}
	if (buffer[0] === roomPresenceFrameVersion) {
		const header = decodeRoomTokenHeader(buffer, 2);
		return header ? {
			type: "presence",
			roomToken: header.roomToken,
			isPresent: buffer[1] === 1
		} : null;
	}
	return null;
};
const isPeerUnderlyingStale = (peer) => {
	const { connection, channel } = peer;
	return peer.isDead || connection.connectionState === "closed" || connection.connectionState === "failed" || connection.iceConnectionState === "closed" || connection.iceConnectionState === "failed" || channel?.readyState === "closing" || channel?.readyState === "closed";
};
const getConnectedPeerHealth = (peer) => {
	if (isPeerUnderlyingStale(peer)) return "stale";
	const { channel } = peer;
	if (!channel || channel.readyState !== "open") return "transient";
	return "live";
};
var SharedPeerManager = class {
	rooms = /* @__PURE__ */ new Map();
	unclaimedDataTimers = /* @__PURE__ */ new WeakMap();
	pendingDataTimers = /* @__PURE__ */ new WeakMap();
	byApp = {};
	registerRoom(appId, roomId, tokenPromise, options) {
		const rooms = this.rooms.get(appId) ?? /* @__PURE__ */ new Map();
		if (rooms.has(roomId)) throw mkErr("room membership already registered");
		const registration = {
			token: null,
			tokenPromise,
			...options
		};
		rooms.set(roomId, registration);
		this.rooms.set(appId, rooms);
		const current = () => this.rooms.get(appId)?.get(roomId) === registration;
		const advertise = (present) => {
			if (!registration.token) return;
			for (const shared of values(this.byApp[appId] ?? {})) try {
				this.sendRoomPresence(shared, registration.token, present);
			} catch {}
		};
		tokenPromise.then((token) => {
			if (!current()) return;
			registration.token = token;
			for (const shared of values(this.byApp[appId] ?? {})) {
				if (shared.remoteRoomTokens.has(token)) this.attachRoom(appId, roomId, registration, shared);
				this.discardUnboundData(shared);
			}
			if (current() && registration.active) advertise(true);
		});
		return {
			connect: (peerId, peer, idleMs) => {
				if (!current()) {
					peer.destroy();
					return;
				}
				const existing = this.reusable(appId, peerId);
				if (existing && existing.peer !== peer) peer.destroy();
				const shared = existing ?? this.register(appId, peerId, peer, idleMs);
				this.attachRoom(appId, roomId, registration, shared);
				if (!existing) {
					for (const room of rooms.values()) if (room.active && room.token) this.sendRoomPresence(shared, room.token, true);
				}
			},
			reuse: (peerId) => {
				if (!current()) return false;
				const shared = this.reusable(appId, peerId);
				if (!shared) return false;
				this.attachRoom(appId, roomId, registration, shared);
				return true;
			},
			setActive: (active) => {
				if (!current() || registration.active === active) return;
				registration.active = active;
				advertise(active);
			},
			leave: () => {
				if (!current()) return;
				rooms.delete(roomId);
				if (!rooms.size) this.rooms.delete(appId);
				advertise(false);
				for (const shared of values(this.byApp[appId] ?? {})) {
					const binding = shared.bindings[roomId];
					binding?.handlers.close?.();
					binding?.detach();
					this.discardUnboundData(shared);
				}
			}
		};
	}
	owns(appId, peerId, peer) {
		return this.byApp[appId]?.[peerId]?.peer === peer;
	}
	reusable(appId, peerId) {
		const shared = this.byApp[appId]?.[peerId];
		if (shared && isPeerUnderlyingStale(shared.peer)) {
			this.clear(appId, peerId, { destroyPeer: true });
			return;
		}
		return shared;
	}
	attachRoom(appId, roomId, registration, shared) {
		if (this.rooms.get(appId)?.get(roomId) !== registration || shared.isClosing || this.get(appId, shared.peerId) !== shared) return;
		const { proxy, isNew } = this.bind(roomId, registration.tokenPromise, shared, { onDetach: () => registration.onDetach(shared.peerId, shared.peer) });
		if (isNew) registration.onPeer(proxy, shared.peerId, shared.peer);
	}
	get(appId, peerId) {
		return this.byApp[appId]?.[peerId];
	}
	sendRoomPresence(shared, roomToken, isPresent) {
		if (shared.isClosing || isPeerUnderlyingStale(shared.peer)) return;
		shared.peer.sendData(wrapRoomPresenceFrame(roomToken, isPresent));
	}
	clear(appId, peerId, { destroyPeer }) {
		const map = this.byApp[appId];
		const shared = map?.[peerId];
		if (!shared || shared.isClosing) return;
		shared.idleTimer = resetTimer(shared.idleTimer);
		this.clearDataTimers(shared);
		shared.isClosing = true;
		if (destroyPeer && !shared.peer.isDead) shared.peer.destroy();
		const bindings = values(shared.bindings);
		shared.bindings = {};
		shared.bindingsByToken = {};
		shared.controlRoomId = null;
		delete map[peerId];
		bindings.forEach((binding) => {
			binding.handlers.close?.();
			binding.pendingData.length = 0;
			binding.pendingSendData.length = 0;
			binding.pendingTracks.length = 0;
		});
		shared.media.clearRemote();
		shared.pendingDataByToken.clear();
		shared.remoteRoomTokens.clear();
		if (keys(map).length === 0) delete this.byApp[appId];
	}
	register(appId, peerId, peer, idleMs) {
		const existing = this.byApp[appId]?.[peerId];
		if (existing) {
			existing.idleTimer = resetTimer(existing.idleTimer);
			if (existing.peer === peer) return existing;
			this.clear(appId, peerId, { destroyPeer: true });
		}
		const shared = {
			appId,
			peerId,
			peer,
			bindings: {},
			bindingsByToken: {},
			pendingDataByToken: /* @__PURE__ */ new Map(),
			remoteRoomTokens: /* @__PURE__ */ new Set(),
			idleTimer: null,
			controlRoomId: null,
			streamOwners: /* @__PURE__ */ new Map(),
			trackOwners: /* @__PURE__ */ new Map(),
			media: createMediaIdentityCache(),
			idleMs,
			isClosing: false
		};
		(this.byApp[appId] ??= {})[peerId] = shared;
		const clearCurrent = () => {
			if (this.owns(appId, peerId, peer)) this.clear(appId, peerId, { destroyPeer: true });
		};
		peer.setHandlers({
			data: (data) => this.dispatchData(shared, data),
			signal: (signal) => this.dispatchSignal(shared, signal),
			close: clearCurrent,
			error: (err) => {
				console.error(`${libName} peer error:`, err);
				clearCurrent();
			},
			track: (track, stream) => this.dispatchTrack(shared, track, stream)
		});
		return shared;
	}
	bind(roomId, roomTokenPromise, shared, { onDetach }) {
		const existingBinding = shared.bindings[roomId];
		if (existingBinding) {
			shared.idleTimer = resetTimer(shared.idleTimer);
			return {
				proxy: existingBinding.proxy,
				isNew: false
			};
		}
		const binding = {
			roomId,
			roomToken: null,
			roomTokenPromise,
			handlers: {},
			pendingData: [],
			pendingSendData: [],
			pendingTracks: [],
			detach: noOp,
			proxy: {}
		};
		const detachBinding = () => {
			if (shared.bindings[roomId] !== binding) return;
			const shouldDestroy = keys(shared.bindings).length === 1 && (shared.streamOwners.size > 0 || shared.trackOwners.size > 0 || shared.media.hasRemoteMedia());
			if (!shouldDestroy) this.pruneRoomOwnership(shared, roomId);
			delete shared.bindings[roomId];
			if (binding.roomToken && shared.bindingsByToken[binding.roomToken] === binding) delete shared.bindingsByToken[binding.roomToken];
			if (shared.controlRoomId === roomId) shared.controlRoomId = keys(shared.bindings)[0] ?? null;
			this.discardUnboundData(shared);
			onDetach();
			if (shouldDestroy) this.clear(shared.appId, shared.peerId, { destroyPeer: true });
			else this.scheduleIdleTimer(shared);
		};
		const proxy = {
			get connection() {
				return shared.peer.connection;
			},
			get channel() {
				return shared.peer.channel;
			},
			get isDead() {
				return shared.peer.isDead;
			},
			getOffer: (restartIce) => shared.peer.getOffer(restartIce),
			signal: (sdp) => shared.peer.signal(sdp),
			sendData: (data) => {
				if (!binding.roomToken) {
					binding.pendingSendData.push(data);
					return;
				}
				shared.peer.sendData(wrapRoomFrame(binding.roomToken, data));
			},
			destroy: () => detachBinding(),
			setHandlers: (newHandlers) => {
				Object.assign(binding.handlers, newHandlers);
				this.flushBindingQueues(shared, binding);
			},
			addStream: (stream) => {
				const owners = shared.streamOwners.get(stream) ?? /* @__PURE__ */ new Set();
				const shouldAttach = owners.size === 0;
				owners.add(roomId);
				shared.streamOwners.set(stream, owners);
				if (shouldAttach) shared.peer.addStream(stream);
			},
			removeStream: (stream) => this.releaseStreamOwner(shared, stream, roomId),
			addTrack: (track, stream) => {
				const entry = shared.trackOwners.get(track) ?? {
					stream,
					rooms: /* @__PURE__ */ new Set()
				};
				const shouldAttach = entry.rooms.size === 0;
				entry.stream = stream;
				entry.rooms.add(roomId);
				shared.trackOwners.set(track, entry);
				if (shouldAttach) return shared.peer.addTrack(track, stream);
				return shared.peer.connection.getSenders().find((s) => s.track === track) ?? shared.peer.addTrack(track, stream);
			},
			removeTrack: (track) => this.releaseTrackOwner(shared, track, roomId),
			replaceTrack: async (oldTrack, newTrack) => {
				const oldEntry = shared.trackOwners.get(oldTrack);
				await shared.peer.replaceTrack(oldTrack, newTrack);
				if (oldEntry && shared.trackOwners.get(oldTrack) === oldEntry) {
					shared.trackOwners.delete(oldTrack);
					const nextEntry = shared.trackOwners.get(newTrack) ?? {
						stream: oldEntry.stream,
						rooms: /* @__PURE__ */ new Set()
					};
					oldEntry.rooms.forEach((room) => nextEntry.rooms.add(room));
					shared.trackOwners.set(newTrack, nextEntry);
				}
			},
			__trysteroMedia: shared.media
		};
		binding.proxy = proxy;
		binding.detach = detachBinding;
		shared.bindings[roomId] = binding;
		shared.controlRoomId ??= roomId;
		shared.idleTimer = resetTimer(shared.idleTimer);
		roomTokenPromise.then((roomToken) => {
			if (shared.isClosing || shared.bindings[roomId] !== binding) return;
			binding.roomToken = roomToken;
			shared.bindingsByToken[roomToken] = binding;
			const pendingData = shared.pendingDataByToken.get(roomToken);
			if (pendingData?.length) {
				binding.pendingData.push(...pendingData);
				shared.pendingDataByToken.delete(roomToken);
			}
			const pendingSendData = binding.pendingSendData.splice(0);
			if (!isPeerUnderlyingStale(shared.peer)) pendingSendData.forEach((payload) => {
				try {
					shared.peer.sendData(wrapRoomFrame(roomToken, payload));
				} catch {}
			});
			this.flushBindingQueues(shared, binding);
			this.discardUnboundData(shared);
		});
		return {
			proxy,
			isNew: true
		};
	}
	releaseStreamOwner(shared, stream, roomIdToRemove) {
		const rooms = shared.streamOwners.get(stream);
		if (!rooms) return;
		rooms.delete(roomIdToRemove);
		if (rooms.size === 0) {
			shared.streamOwners.delete(stream);
			shared.peer.removeStream(stream);
		}
	}
	releaseTrackOwner(shared, track, roomIdToRemove) {
		const entry = shared.trackOwners.get(track);
		if (!entry) return;
		entry.rooms.delete(roomIdToRemove);
		if (entry.rooms.size === 0) {
			shared.trackOwners.delete(track);
			shared.peer.removeTrack(track);
		}
	}
	pruneRoomOwnership(shared, roomIdToRemove) {
		shared.streamOwners.forEach((_, stream) => this.releaseStreamOwner(shared, stream, roomIdToRemove));
		shared.trackOwners.forEach((_, track) => this.releaseTrackOwner(shared, track, roomIdToRemove));
	}
	scheduleIdleTimer(shared) {
		if (shared.isClosing || keys(shared.bindings).length > 0) return;
		shared.idleTimer = resetTimer(shared.idleTimer);
		shared.idleTimer = setTimeout(() => {
			const current = this.byApp[shared.appId]?.[shared.peerId];
			if (!current || keys(current.bindings).length > 0) return;
			this.clear(shared.appId, shared.peerId, { destroyPeer: true });
		}, shared.idleMs);
	}
	getSignalBinding(shared) {
		if (shared.controlRoomId) {
			const selected = shared.bindings[shared.controlRoomId];
			if (selected?.handlers.signal) return selected;
		}
		const fallback = values(shared.bindings).find((binding) => Boolean(binding.handlers.signal));
		if (!fallback) return null;
		shared.controlRoomId = fallback.roomId;
		return fallback;
	}
	flushBindingQueues(shared, binding) {
		const { handlers } = binding;
		if (handlers.data && binding.pendingData.length > 0) {
			const queued = binding.pendingData.splice(0);
			this.syncDataTimers(shared);
			queued.forEach((payload) => handlers.data?.(payload));
		} else this.syncDataTimers(shared);
		if ((handlers.track || handlers.stream) && binding.pendingTracks.length) binding.pendingTracks.splice(0).forEach(({ track, stream }) => {
			handlers.track?.(track, stream);
			handlers.stream?.(stream);
		});
	}
	unclaimedBufferedFrameCount(shared) {
		let count = 0;
		for (const queue of shared.pendingDataByToken.values()) count += queue.length;
		return count;
	}
	boundBufferedFrameCount(shared) {
		let count = 0;
		for (const binding of values(shared.bindings)) count += binding.pendingData.length;
		return count;
	}
	bufferedFrameCount(shared) {
		return this.unclaimedBufferedFrameCount(shared) + this.boundBufferedFrameCount(shared);
	}
	clearDataTimers(shared) {
		resetTimer(this.unclaimedDataTimers.get(shared));
		this.unclaimedDataTimers.delete(shared);
		resetTimer(this.pendingDataTimers.get(shared));
		this.pendingDataTimers.delete(shared);
	}
	syncDataTimers(shared) {
		if (shared.isClosing) {
			this.clearDataTimers(shared);
			return;
		}
		if (this.unclaimedBufferedFrameCount(shared) === 0) {
			resetTimer(this.unclaimedDataTimers.get(shared));
			this.unclaimedDataTimers.delete(shared);
		} else if (!this.unclaimedDataTimers.has(shared)) this.unclaimedDataTimers.set(shared, setTimeout(() => {
			this.unclaimedDataTimers.delete(shared);
			shared.pendingDataByToken.clear();
		}, pendingDataTimeoutMs));
		if (this.boundBufferedFrameCount(shared) === 0) {
			resetTimer(this.pendingDataTimers.get(shared));
			this.pendingDataTimers.delete(shared);
		} else if (!this.pendingDataTimers.has(shared)) this.pendingDataTimers.set(shared, setTimeout(() => {
			this.pendingDataTimers.delete(shared);
			if (this.boundBufferedFrameCount(shared) > 0) this.failData(shared, "room data handler timed out");
		}, pendingDataTimeoutMs));
	}
	canBindRoomToken(shared, token) {
		return values(shared.bindings).some((binding) => !binding.roomToken) || [...this.rooms.get(shared.appId)?.values() ?? []].some((room) => !room.token || room.token === token);
	}
	discardUnboundData(shared) {
		for (const token of shared.pendingDataByToken.keys()) if (!this.canBindRoomToken(shared, token)) shared.pendingDataByToken.delete(token);
		this.syncDataTimers(shared);
	}
	failData(shared, reason) {
		console.warn(`${libName}: ${reason}; disconnecting peer ${shared.peerId}`);
		this.clear(shared.appId, shared.peerId, { destroyPeer: true });
	}
	dispatchData(shared, data) {
		if (shared.isClosing) return;
		const decoded = unwrapFrame(data);
		if (!decoded) {
			this.failData(shared, "invalid or incompatible room frame");
			return;
		}
		if (decoded.type === "presence") {
			if (decoded.isPresent) {
				if (!shared.remoteRoomTokens.has(decoded.roomToken) && shared.remoteRoomTokens.size >= 64) {
					this.failData(shared, "too many advertised rooms");
					return;
				}
				shared.remoteRoomTokens.add(decoded.roomToken);
				for (const [roomId, registration] of this.rooms.get(shared.appId) ?? []) if (registration.token === decoded.roomToken) this.attachRoom(shared.appId, roomId, registration, shared);
			} else {
				shared.remoteRoomTokens.delete(decoded.roomToken);
				shared.pendingDataByToken.delete(decoded.roomToken);
				const binding = shared.bindingsByToken[decoded.roomToken];
				binding?.handlers.close?.();
				binding?.detach();
				this.syncDataTimers(shared);
			}
			return;
		}
		const binding = shared.bindingsByToken[decoded.roomToken];
		if (!binding) {
			if (!this.canBindRoomToken(shared, decoded.roomToken) || this.bufferedFrameCount(shared) >= 64) return;
			const pending = shared.pendingDataByToken.get(decoded.roomToken) ?? [];
			pending.push(decoded.payload);
			shared.pendingDataByToken.set(decoded.roomToken, pending);
			this.syncDataTimers(shared);
			return;
		}
		if (binding.handlers.data) binding.handlers.data(decoded.payload);
		else {
			if (this.bufferedFrameCount(shared) >= 64) {
				this.failData(shared, "too much data waiting for a room handler");
				return;
			}
			binding.pendingData.push(decoded.payload);
			this.syncDataTimers(shared);
		}
	}
	dispatchSignal(shared, signal) {
		const binding = this.getSignalBinding(shared);
		if (binding) binding.handlers.signal?.(signal);
		else if (signal.type === "offer") this.clear(shared.appId, shared.peerId, { destroyPeer: true });
	}
	dispatchTrack(shared, track, stream) {
		values(shared.bindings).forEach((binding) => {
			if (binding.handlers.track || binding.handlers.stream) {
				binding.handlers.track?.(track, stream);
				binding.handlers.stream?.(stream);
				return;
			}
			binding.pendingTracks.push({
				track,
				stream
			});
		});
	}
};
//#endregion
export { SharedPeerManager, getConnectedPeerHealth };

