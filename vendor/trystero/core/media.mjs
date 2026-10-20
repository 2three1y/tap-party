import { genId, libName, mkErr } from "./utils.mjs";
//#region src/media.ts
const toPendingMediaMeta = (value) => {
	if (value && typeof value === "object" && !Array.isArray(value) && typeof value.k === "string") return {
		key: value.k,
		...typeof value.s === "string" ? { streamId: value.s } : {},
		...typeof value.t === "string" ? { trackId: value.t } : {},
		...Object.hasOwn(value, "m") ? { metadata: value.m } : {}
	};
	return null;
};
const makeKeyGetter = (map) => (item) => {
	let key = map.get(item);
	if (!key) {
		key = genId(20);
		map.set(item, key);
	}
	return key;
};
const createMediaIdentityCache = () => {
	const localStreamKeys = /* @__PURE__ */ new WeakMap();
	const localTrackKeys = /* @__PURE__ */ new WeakMap();
	const remoteStreamsByKey = /* @__PURE__ */ new Map();
	const remoteStreamsById = /* @__PURE__ */ new Map();
	const remoteTracksByKey = /* @__PURE__ */ new Map();
	const remoteTracksById = /* @__PURE__ */ new Map();
	const remoteStreamKeys = /* @__PURE__ */ new WeakMap();
	const remoteTrackKeys = /* @__PURE__ */ new WeakMap();
	return {
		getStreamKey: makeKeyGetter(localStreamKeys),
		getTrackKey: makeKeyGetter(localTrackKeys),
		rememberRemoteStream: (key, stream, streamId) => {
			const previous = remoteStreamKeys.get(stream);
			if (previous !== void 0 && remoteStreamsByKey.get(previous) === stream) remoteStreamsByKey.delete(previous);
			remoteStreamKeys.set(stream, key);
			remoteStreamsByKey.set(key, stream);
			if (streamId) remoteStreamsById.set(streamId, stream);
			stream.getTracks?.().forEach((track) => {
				if (typeof track.id === "string") remoteTracksById.set(track.id, {
					track,
					stream
				});
			});
		},
		getRemoteStream: (key, streamId) => remoteStreamsByKey.get(key) ?? (streamId ? remoteStreamsById.get(streamId) : void 0),
		rememberRemoteTrack: (key, track, stream, trackId, streamId) => {
			const ref = {
				track,
				stream
			};
			const previous = remoteTrackKeys.get(track);
			if (previous !== void 0 && remoteTracksByKey.get(previous)?.track === track) remoteTracksByKey.delete(previous);
			remoteTrackKeys.set(track, key);
			remoteTracksByKey.set(key, ref);
			if (trackId) remoteTracksById.set(trackId, ref);
			if (streamId) remoteStreamsById.set(streamId, stream);
		},
		getRemoteTrack: (key, trackId) => remoteTracksByKey.get(key) ?? (trackId ? remoteTracksById.get(trackId) : void 0),
		hasRemoteMedia: () => remoteStreamsByKey.size > 0 || remoteTracksByKey.size > 0,
		clearRemote: () => {
			remoteStreamsByKey.clear();
			remoteStreamsById.clear();
			remoteTracksByKey.clear();
			remoteTracksById.clear();
		}
	};
};
const createMediaManager = ({ iterate, isActive, getSharedMediaPeer, onPeerError }) => {
	const pendingStreamMetas = {};
	const pendingTrackMetas = {};
	const peerMediaCaches = {};
	const localMedia = createMediaIdentityCache();
	const getPeerMedia = (id) => getSharedMediaPeer(id)?.__trysteroMedia ?? (peerMediaCaches[id] ??= createMediaIdentityCache());
	const queuePendingMeta = (metas, id, parsed, kind) => {
		const queue = metas[id] ??= [];
		if (queue.length >= 64) {
			console.warn(`${libName}: too many pending ${kind} metadata messages`);
			onPeerError(id, mkErr("too many pending media metadata messages"));
			return;
		}
		queue.push(parsed);
	};
	const takePendingMeta = (queue, idValue, getMetaId) => {
		if (!queue?.length) return;
		const index = idValue ? queue.findIndex((meta) => {
			const metaId = getMetaId(meta);
			return !metaId || metaId === idValue;
		}) : 0;
		return index >= 0 ? queue.splice(index, 1)[0] : void 0;
	};
	const emitStream = (id, key, stream, metadata) => {
		if (!isActive(id)) return;
		getPeerMedia(id).rememberRemoteStream(key, stream, typeof stream.id === "string" ? stream.id : void 0);
		manager.onPeerStream?.(stream, id, metadata);
	};
	const emitTrack = (id, key, track, stream, metadata) => {
		if (!isActive(id)) return;
		getPeerMedia(id).rememberRemoteTrack(key, track, stream, typeof track.id === "string" ? track.id : void 0, typeof stream.id === "string" ? stream.id : void 0);
		manager.onPeerTrack?.(track, stream, id, metadata);
	};
	const applyMediaOp = (targets, key, metadata, sendMeta, op, mediaIds = {}) => {
		const payload = {
			k: key,
			...mediaIds,
			...metadata === void 0 ? {} : { m: metadata }
		};
		return iterate(targets, async (id, peer) => {
			await sendMeta(payload, id);
			await op(peer);
		});
	};
	const manager = {
		addStream: (stream, options, sendMeta) => applyMediaOp(options.target, localMedia.getStreamKey(stream), options.metadata, sendMeta, (peer) => peer.addStream(stream), { s: stream.id }),
		removeStream: (stream, target) => {
			iterate(target, (_, peer) => peer.removeStream(stream));
		},
		addTrack: (track, stream, options, sendMeta) => applyMediaOp(options.target, localMedia.getTrackKey(track), options.metadata, sendMeta, (peer) => peer.addTrack(track, stream), {
			s: stream.id,
			t: track.id
		}),
		removeTrack: (track, target) => {
			iterate(target, (_, peer) => peer.removeTrack(track));
		},
		replaceTrack: (oldTrack, newTrack, options, sendMeta) => applyMediaOp(options.target, localMedia.getTrackKey(newTrack), options.metadata, sendMeta, (peer) => peer.replaceTrack(oldTrack, newTrack), { t: oldTrack.id }),
		receiveStreamMeta: (meta, id) => {
			if (!isActive(id)) return;
			const parsed = toPendingMediaMeta(meta);
			if (!parsed) return;
			const cached = getPeerMedia(id).getRemoteStream(parsed.key, parsed.streamId);
			if (cached?.getTracks().length) {
				emitStream(id, parsed.key, cached, parsed.metadata);
				return;
			}
			queuePendingMeta(pendingStreamMetas, id, parsed, "stream");
		},
		receiveTrackMeta: (meta, id) => {
			if (!isActive(id)) return;
			const parsed = toPendingMediaMeta(meta);
			if (!parsed) return;
			const cached = getPeerMedia(id).getRemoteTrack(parsed.key, parsed.trackId);
			if (cached && cached.track.readyState !== "ended" && (!cached.stream.getTracks || cached.stream.getTracks().includes(cached.track))) {
				emitTrack(id, parsed.key, cached.track, cached.stream, parsed.metadata);
				return;
			}
			queuePendingMeta(pendingTrackMetas, id, parsed, "track");
		},
		receiveRemoteStream: (id, stream) => {
			if (!isActive(id)) return;
			const next = takePendingMeta(pendingStreamMetas[id], typeof stream.id === "string" ? stream.id : void 0, (meta) => meta.streamId);
			if (!next) return;
			emitStream(id, next.key, stream, next.metadata);
		},
		receiveRemoteTrack: (id, track, stream) => {
			if (!isActive(id)) return;
			const queue = pendingTrackMetas[id];
			const trackId = typeof track.id === "string" ? track.id : void 0;
			const streamId = typeof stream.id === "string" ? stream.id : void 0;
			const byTrackIdx = queue && trackId ? queue.findIndex((meta) => meta.trackId === trackId) : -1;
			const next = byTrackIdx >= 0 ? queue?.splice(byTrackIdx, 1)[0] : takePendingMeta(queue, streamId, (meta) => meta.streamId);
			if (!next) return;
			emitTrack(id, next.key, track, stream, next.metadata);
		},
		clearPeer: (id) => {
			delete pendingStreamMetas[id];
			delete pendingTrackMetas[id];
			delete peerMediaCaches[id];
		},
		onPeerStream: null,
		onPeerTrack: null
	};
	return manager;
};
//#endregion
export { createMediaIdentityCache, createMediaManager };

