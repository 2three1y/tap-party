//#region src/utils.ts
const { floor, min, sin } = Math;
const libName = "Trystero";
const alloc = (n, f) => Array(n).fill(void 0).map(f);
const charSet = "0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz";
const genId = (n) => alloc(n, () => charSet[floor(Math.random() * 62)] ?? "").join("");
const selfId = genId(20);
const all = Promise.all.bind(Promise);
const isBrowser = typeof window !== "undefined";
const { entries, fromEntries, keys, values } = Object;
const noOp = () => {};
const candidateType = "candidate";
const resetTimer = (timer) => {
	if (timer !== null) clearTimeout(timer);
	return null;
};
const mkErr = (msg) => /* @__PURE__ */ new Error(`${libName}: ${msg}`);
const toErrorMessage = (reason, fallback) => {
	if (reason instanceof Error && reason.message) return reason.message;
	if (typeof reason === "string" && reason) return reason;
	return toJson(reason ?? fallback);
};
const toError = (reason, fallback) => reason instanceof Error ? reason : mkErr(toErrorMessage(reason, fallback));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encodeBytes = (txt) => encoder.encode(txt);
const decodeBytes = (buffer) => decoder.decode(buffer);
const toHex = (buffer) => buffer.reduce((a, c) => a + c.toString(16).padStart(2, "0"), "");
const topicPath = (...parts) => parts.join("@");
const shuffle = (xs, seed) => {
	const a = [...xs];
	const rand = () => {
		const x = sin(seed++) * 1e4;
		return x - floor(x);
	};
	let i = a.length;
	while (i) {
		const j = floor(rand() * i--);
		const tmp = a[i];
		a[i] = a[j];
		a[j] = tmp;
	}
	return a;
};
const getRelays = (config, defaults, defaultN, deriveFromAppId = false) => config.relayConfig?.urls || (deriveFromAppId ? shuffle(defaults, strToNum(config.appId)) : defaults).slice(0, config.relayConfig?.redundancy ?? defaultN);
const toJson = JSON.stringify;
const fromJson = (s) => {
	try {
		return JSON.parse(s);
	} catch {
		throw mkErr(`failed to parse JSON: ${s}`);
	}
};
const strToNum = (str, limit = Number.MAX_SAFE_INTEGER) => str.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % limit;
const defaultRetryMs = 3333;
const maxRetryMs = 6e4;
const socketRetryPeriods = {};
let reconnectionLockingPromise = null;
let resolver = null;
const pauseRelayReconnection = () => {
	if (!reconnectionLockingPromise) reconnectionLockingPromise = new Promise((resolve) => {
		resolver = resolve;
	}).finally(() => {
		resolver = null;
		reconnectionLockingPromise = null;
	});
};
const resumeRelayReconnection = () => {
	resolver?.();
};
const makeSocket = (url, onMessage, onReconnect) => {
	const client = {};
	let didOpen = false;
	let isReconnectPending = false;
	let retryTimer;
	let resolveReady = noOp;
	client.isClosed = false;
	client.ready = new Promise((res) => resolveReady = res);
	const init = () => {
		if (client.isClosed) return;
		retryTimer = void 0;
		isReconnectPending = false;
		const socket = new WebSocket(url);
		socket.onclose = () => {
			if (client.isClosed || isReconnectPending) return;
			isReconnectPending = true;
			if (reconnectionLockingPromise) {
				reconnectionLockingPromise.then(init);
				return;
			}
			const period = socketRetryPeriods[url] ??= defaultRetryMs;
			retryTimer = setTimeout(init, Math.random() * period);
			socketRetryPeriods[url] = min(period * 2, maxRetryMs);
		};
		socket.onmessage = (e) => onMessage(String(e.data));
		client.socket = socket;
		client.url = socket.url;
		socket.onopen = () => {
			const isReconnect = didOpen;
			didOpen = true;
			resolveReady(client);
			socketRetryPeriods[url] = defaultRetryMs;
			if (isReconnect) onReconnect?.();
		};
		client.send = (data) => {
			if (socket.readyState === 1) socket.send(data);
		};
	};
	client.close = () => {
		client.isClosed = true;
		if (retryTimer !== void 0) {
			clearTimeout(retryTimer);
			retryTimer = void 0;
		}
		client.socket.close();
	};
	init();
	return client;
};
const socketGetter = (clientMap) => () => fromEntries(entries(clientMap).map(([url, client]) => [url, client.socket]));
const createRelayManager = (getSocket) => {
	const relays = {};
	const keysByRelay = /* @__PURE__ */ new WeakMap();
	const keyOf = (relay) => {
		const key = keysByRelay.get(relay);
		if (!key) throw mkErr("relay bookkeeping missing registration for relay client");
		return key;
	};
	const scoped = () => {
		const store = {};
		const forKey = (key) => store[key] ??= {};
		return {
			forKey,
			forRelay: (relay) => forKey(keyOf(relay))
		};
	};
	const store = (key, relay) => {
		relays[key] = relay;
		keysByRelay.set(relay, key);
		return relay;
	};
	return {
		register: (key, createRelay) => {
			const relay = relays[key];
			if (relay) return relay;
			return store(key, createRelay());
		},
		keyOf,
		scoped,
		getSockets: () => fromEntries(entries(relays).flatMap(([key, relay]) => {
			const socket = getSocket(relay);
			return socket ? [[key, socket]] : [];
		}))
	};
};
const watchOnline = () => {
	if (isBrowser) {
		const controller = new AbortController();
		addEventListener("online", resumeRelayReconnection, { signal: controller.signal });
		addEventListener("offline", pauseRelayReconnection, { signal: controller.signal });
		return () => controller.abort();
	}
	return noOp;
};
//#endregion
export { all, alloc, candidateType, createRelayManager, decodeBytes, encodeBytes, entries, fromEntries, fromJson, genId, getRelays, isBrowser, keys, libName, makeSocket, mkErr, noOp, pauseRelayReconnection, resetTimer, resumeRelayReconnection, selfId, shuffle, socketGetter, strToNum, toError, toErrorMessage, toHex, toJson, topicPath, values, watchOnline };

