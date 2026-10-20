import { schnorr } from "@noble/secp256k1";
import { createRelayManager, createTopicStrategy, fromJson, genId, getRelays, hashWith, libName, makeSocket, pauseRelayReconnection, resumeRelayReconnection, selfId, strToNum, toHex, toJson } from "@trystero-p2p/core";
//#region src/index.ts
const relayManager = createRelayManager((client) => client.socket);
const defaultRedundancy = 5;
const tag = "x";
const eventMsgType = "EVENT";
const { secretKey, publicKey } = schnorr.keygen();
const pubkey = toHex(publicKey);
const kindCache = {};
const maxTopicsPerSubscription = 250;
const steadyAnnounceIntervalMs = 6e4;
const maxRelayBackoffMs = 9e5;
const subscriptionRetryMs = 5333;
const relayBackoffs = /* @__PURE__ */ new WeakMap();
const announcementMessages = relayManager.scoped();
const retiredRelays = /* @__PURE__ */ new WeakSet();
const backoffRelay = (client) => {
	const previous = relayBackoffs.get(client);
	const delayMs = Math.min(previous?.delayMs ? Math.max(steadyAnnounceIntervalMs, previous.delayMs * 2) : steadyAnnounceIntervalMs, maxRelayBackoffMs);
	relayBackoffs.set(client, {
		delayMs,
		untilMs: Date.now() + delayMs
	});
	return delayMs;
};
const getRelayBackoffMs = (client) => {
	const state = relayBackoffs.get(client);
	if (!state) return 0;
	const remainingMs = state.untilMs - Date.now();
	if (remainingMs > 0) return remainingMs;
	return 0;
};
const nextAnnounce = (nextAnnounceMs) => ({ nextAnnounceMs });
const stopAnnouncing = { stopAnnouncing: true };
const retireRelay = (client) => {
	if (retiredRelays.has(client)) return false;
	retiredRelays.add(client);
	relayBackoffs.delete(client);
	client.close?.();
	return true;
};
const now = () => Math.floor(Date.now() / 1e3);
const topicToKind = (topic) => kindCache[topic] ??= strToNum(topic, 1e4) + 2e4;
const createEvent = async (topic, content) => {
	const payload = {
		kind: topicToKind(topic),
		tags: [[tag, topic]],
		created_at: now(),
		content,
		pubkey
	};
	const id = await hashWith("SHA-256", toJson([
		0,
		payload.pubkey,
		payload.created_at,
		payload.kind,
		payload.tags,
		payload.content
	]));
	return toJson([eventMsgType, {
		...payload,
		id: toHex(id),
		sig: toHex(await schnorr.signAsync(id, secretKey))
	}]);
};
const subscribe = (subId, topic) => toJson([
	"REQ",
	subId,
	{
		kinds: [topicToKind(topic)],
		since: now(),
		["#x"]: [topic]
	}
]);
const batchers = {};
const resolveBatchFlush = (batcher) => {
	batcher.flushWaiters.forEach((resolve) => resolve());
	batcher.flushWaiters.clear();
};
const batchAdd = (client, topic, handler) => {
	const batcher = batchers[client.url] ??= {
		subIds: [],
		topics: /* @__PURE__ */ new Map(),
		updateTimer: null,
		flushWaiters: /* @__PURE__ */ new Set(),
		retryTimer: null,
		retryMs: subscriptionRetryMs,
		pendingEose: /* @__PURE__ */ new Set(),
		requestedAt: 0
	};
	batcher.topics.set(topic, handler);
	scheduleBatchFlush(client, batcher);
};
const batchRemove = (client, topic) => {
	const batcher = batchers[client.url];
	if (!batcher) return;
	batcher.topics.delete(topic);
	delete announcementMessages.forRelay(client)[topic];
	if (batcher.topics.size === 0) {
		if (batcher.retryTimer !== null) clearTimeout(batcher.retryTimer);
		if (batcher.updateTimer !== null) {
			clearTimeout(batcher.updateTimer);
			batcher.updateTimer = null;
		}
		resolveBatchFlush(batcher);
		batcher.subIds.forEach((subId) => client.send(toJson(["CLOSE", subId])));
		delete batchers[client.url];
	} else scheduleBatchFlush(client, batcher);
};
const scheduleBatchFlush = (client, batcher) => {
	if (batcher.updateTimer !== null) return;
	batcher.updateTimer = setTimeout(() => {
		batcher.updateTimer = null;
		try {
			flushBatch(client);
		} finally {
			resolveBatchFlush(batcher);
		}
	}, 0);
};
const waitForBatchFlush = (client) => {
	const batcher = batchers[client.url];
	if (!batcher || batcher.updateTimer === null) return Promise.resolve();
	return new Promise((resolve) => batcher.flushWaiters.add(resolve));
};
const flushBatch = (client) => {
	const batcher = batchers[client.url];
	if (!batcher || batcher.topics.size === 0) return;
	const topics = [...batcher.topics.keys()];
	const chunks = [];
	const since = now();
	for (let i = 0; i < topics.length; i += maxTopicsPerSubscription) chunks.push(topics.slice(i, i + maxTopicsPerSubscription));
	while (batcher.subIds.length > chunks.length) {
		const subId = batcher.subIds.pop();
		if (subId) client.send(toJson(["CLOSE", subId]));
	}
	batcher.pendingEose.clear();
	batcher.requestedAt = Date.now();
	chunks.forEach((chunk, i) => {
		const subId = batcher.subIds[i] ??= genId(64);
		batcher.pendingEose.add(subId);
		client.send(toJson([
			"REQ",
			subId,
			{
				kinds: [...new Set(chunk.map(topicToKind))],
				since,
				["#x"]: chunk
			}
		]));
	});
};
const resubscribeOnReconnect = (client) => {
	const batcher = batchers[client.url];
	if (batcher && batcher.topics.size > 0 && !client.isClosed) {
		if (getRelayBackoffMs(client) > 0) {
			retrySubscription(client, true);
			return;
		}
		if (batcher.retryTimer !== null) {
			clearTimeout(batcher.retryTimer);
			batcher.retryTimer = null;
		}
		flushBatch(client);
		replayAnnouncements(client);
	}
};
const replayAnnouncements = (client) => {
	Object.entries(announcementMessages.forRelay(client)).forEach(([topic, payload]) => {
		publishMessage(client, topic, payload, true);
	});
};
const publishMessage = async (client, topic, payload, isAnnouncement) => {
	if (retiredRelays.has(client) || client.isClosed) return isAnnouncement ? stopAnnouncing : void 0;
	const remaining = getRelayBackoffMs(client);
	if (remaining > 0 || client.socket.readyState !== 1) return isAnnouncement ? nextAnnounce(Math.max(steadyAnnounceIntervalMs, remaining)) : void 0;
	const event = await createEvent(topic, isAnnouncement ? toJson({
		...fromJson(payload),
		nonce: genId(8)
	}) : payload);
	if (isAnnouncement && !batchers[client.url]?.topics.has(topic)) return nextAnnounce(steadyAnnounceIntervalMs);
	if (getRelayBackoffMs(client) > 0 || client.isClosed || client.socket.readyState !== 1) return isAnnouncement ? nextAnnounce(steadyAnnounceIntervalMs) : void 0;
	client.send(event);
	if (isAnnouncement) return nextAnnounce(steadyAnnounceIntervalMs);
};
const retrySubscription = (client, rateLimited) => {
	const batcher = batchers[client.url];
	if (!batcher || batcher.retryTimer !== null && !rateLimited) return;
	if (batcher.retryTimer !== null) clearTimeout(batcher.retryTimer);
	const delay = rateLimited ? getRelayBackoffMs(client) : batcher.retryMs;
	batcher.retryMs = Math.min(batcher.retryMs * 2, steadyAnnounceIntervalMs);
	batcher.retryTimer = setTimeout(() => {
		batcher.retryTimer = null;
		resubscribeOnReconnect(client);
	}, Math.max(delay, subscriptionRetryMs));
};
const joinRoom = createTopicStrategy({
	init: (config) => getRelays(config, defaultRelayUrls, defaultRedundancy, true).map((url) => {
		const client = relayManager.register(url, () => makeSocket(url, (data) => {
			const [msgType, subId, payload, relayMsg] = fromJson(data);
			if (msgType !== eventMsgType) {
				const prefix = `${libName}: relay failure from ${client.url} - `;
				const rejectionReason = msgType === "CLOSED" && typeof payload === "string" ? payload : relayMsg;
				const didRejectEvent = msgType === "OK" && payload === false;
				const isRateLimited = (didRejectEvent || msgType === "CLOSED") && rejectionReason?.startsWith("rate-limited:");
				const isDuplicate = didRejectEvent && rejectionReason?.startsWith("duplicate:");
				const isTerminalRejection = rejectionReason && /^(blocked|restricted|auth-required|pow):/.test(rejectionReason);
				if (msgType === "OK" && payload === true && getRelayBackoffMs(client) === 0) relayBackoffs.delete(client);
				if ((didRejectEvent || msgType === "CLOSED") && isTerminalRejection && !retireRelay(client)) return;
				if (isRateLimited) backoffRelay(client);
				else if (msgType === "EOSE") {
					const batcher = batchers[client.url];
					if (batcher?.pendingEose.delete(subId) && batcher.pendingEose.size === 0) {
						batcher.retryMs = subscriptionRetryMs;
						if (batcher.retryTimer !== null) {
							clearTimeout(batcher.retryTimer);
							batcher.retryTimer = null;
						}
						if (Date.now() - batcher.requestedAt >= 1e3) replayAnnouncements(client);
					}
				}
				if (msgType === "CLOSED" && !isTerminalRejection) retrySubscription(client, Boolean(isRateLimited));
				if (!isDuplicate && config.relayConfig?.warnOnRelayFailure !== false) {
					if (msgType === "NOTICE") console.warn(prefix + subId);
					else if (didRejectEvent || msgType === "CLOSED") console.warn(prefix + rejectionReason);
				}
				return;
			}
			if (payload && typeof payload === "object" && "content" in payload) {
				const batcher = batchers[client.url];
				if (batcher?.subIds.includes(subId) && payload.tags) {
					const topicTag = payload.tags.find((t) => t[0] === tag);
					if (topicTag?.[1]) batcher.topics.get(topicTag[1])?.(topicTag[1], payload.content);
				}
			}
		}, () => resubscribeOnReconnect(client)));
		return client.ready;
	}),
	subscribeTopic: (client, topic, onMessage, context) => {
		const handler = (topic, data) => void onMessage(topic, data);
		batchAdd(client, topic, handler);
		const cleanup = () => {
			if (batchers[client.url]?.topics.get(topic) === handler) batchRemove(client, topic);
		};
		return context.kind === "root" ? waitForBatchFlush(client).then(() => cleanup) : cleanup;
	},
	publishTopic: (client, topic, msg, { kind }) => {
		const payload = typeof msg === "string" ? msg : toJson(msg);
		if (kind === "announce") announcementMessages.forRelay(client)[topic] = payload;
		return publishMessage(client, topic, payload, kind === "announce");
	},
	unpublishTopic: (client, topic) => {
		delete announcementMessages.forRelay(client)[topic];
	}
});
const getRelaySockets = relayManager.getSockets;
const defaultRelayUrls = [
	"0x-nostr-relay.fly.dev",
	"bendernostur.duckdns.org:8443",
	"cdn.satellite.earth",
	"nos.lol",
	"nostr.chaima.info",
	"nostr.christiansass.de",
	"nostr.rblb.it",
	"nostr.red5d.dev",
	"nostr.robosats.org",
	"nostr.stakey.net",
	"nostrcity-club.fly.dev",
	"relay-dev.gulugulu.moe",
	"relay.aarpia.com",
	"relay.agentry.com",
	"relay.bitmacro.cloud",
	"relay.bullishbounty.com",
	"relay.degmods.com",
	"relay.flashapp.me",
	"relay.grigic.org",
	"relay.hackshed.dev",
	"relay.kaleidoswap.com",
	"relay.layer.systems",
	"relay.nostr.blockhenge.com",
	"relay.nostr.dev.br",
	"relay.nostrmap.net",
	"relay.novospes.com",
	"relay.piazza.today",
	"relay.routstr.com",
	"testr.nymble.world"
].map((url) => "wss://" + url);
//#endregion
export { createEvent, defaultRelayUrls, getRelaySockets, joinRoom, pauseRelayReconnection, resumeRelayReconnection, selfId, subscribe };

