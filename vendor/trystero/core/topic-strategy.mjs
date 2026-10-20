import { mkErr, selfId, toJson } from "./utils.mjs";
import { shouldActivatePassiveRoom } from "./signal-handler.mjs";
import strategy_default from "./strategy.mjs";
//#region src/topic-strategy.ts
const defaultSteadyAnnounceIntervalMs = 6e4;
const requireContext = (context) => {
	if (!context) throw mkErr("topic strategy missing room context");
	return context;
};
const makeTopicContext = (context, kind, rootTopic, selfTopic) => ({
	kind,
	appId: context.appId,
	roomId: context.roomId,
	rootTopic,
	selfTopic
});
var topic_strategy_default = ({ steadyAnnounceIntervalMs = defaultSteadyAnnounceIntervalMs, reannounceOnDisconnect = true, init, subscribeTopic, publishTopic, unpublishTopic }) => strategy_default({
	init,
	subscribe: async (relay, rootTopic, selfTopic, onMessage, _getOffers, rawContext) => {
		const context = requireContext(rawContext);
		const signalPeer = (peerTopic, signal) => void publishTopic(relay, peerTopic, signal, makeTopicContext(context, "signal", rootTopic, selfTopic));
		let selfCleanup = null;
		let selfCleanupDone = false;
		let selfSubscriptionP = null;
		let didCleanup = false;
		const cleanupSelf = (cleanup) => {
			if (selfCleanupDone) return;
			selfCleanupDone = true;
			cleanup();
		};
		const ensureSelfSubscription = () => {
			if (!selfSubscriptionP) selfSubscriptionP = Promise.resolve(subscribeTopic(relay, selfTopic, (topic, msg) => {
				if (!didCleanup) onMessage(topic, msg, signalPeer);
			}, makeTopicContext(context, "self", rootTopic, selfTopic))).then((cleanup) => {
				selfCleanup = cleanup;
				if (didCleanup) cleanupSelf(cleanup);
			});
			return selfSubscriptionP;
		};
		if (!context.isPassive) await ensureSelfSubscription();
		const rootCleanup = await subscribeTopic(relay, rootTopic, async (topic, msg) => {
			if (didCleanup) return;
			if (context.isPassive && shouldActivatePassiveRoom(msg)) await ensureSelfSubscription();
			if (!didCleanup) await onMessage(topic, msg, signalPeer);
		}, makeTopicContext(context, "root", rootTopic, selfTopic));
		return () => {
			didCleanup = true;
			if (selfCleanup) cleanupSelf(selfCleanup);
			rootCleanup();
		};
	},
	announce: async (relay, rootTopic, selfTopic, extraPayload, rawContext) => {
		const context = requireContext(rawContext);
		const result = await publishTopic(relay, rootTopic, toJson({
			peerId: selfId,
			...extraPayload
		}), makeTopicContext(context, "announce", rootTopic, selfTopic));
		return typeof result === "number" || result !== void 0 && "stopAnnouncing" in result ? result : {
			nextAnnounceMs: result?.nextAnnounceMs ?? steadyAnnounceIntervalMs,
			reannounceOnDisconnect: result?.reannounceOnDisconnect ?? reannounceOnDisconnect
		};
	},
	...unpublishTopic ? { deactivate: (relay, rootTopic, selfTopic, rawContext) => {
		const context = requireContext(rawContext);
		return unpublishTopic(relay, rootTopic, makeTopicContext(context, "announce", rootTopic, selfTopic));
	} } : {}
});
//#endregion
export { topic_strategy_default as default };

