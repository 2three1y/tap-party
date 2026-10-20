import { decodeBytes, encodeBytes, libName, toHex } from "./utils.mjs";
//#region src/crypto.ts
const algo = "AES-GCM";
const strToSha1 = {};
const pack = (buff) => btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(buff))));
const unpack = (packed) => {
	const str = atob(packed);
	return new Uint8Array(str.length).map((_, i) => str.charCodeAt(i)).buffer;
};
const hashWith = async (algorithm, str) => new Uint8Array(await crypto.subtle.digest(algorithm, encodeBytes(str)));
const sha1 = async (str) => strToSha1[str] ??= Array.from(await hashWith("SHA-1", str)).map((b) => b.toString(36)).join("");
const genKey = async (secret, appId, roomId) => crypto.subtle.importKey("raw", await crypto.subtle.digest({ name: "SHA-256" }, encodeBytes(`${secret}:${appId}:${roomId}`)), { name: algo }, false, ["encrypt", "decrypt"]);
const deriveRoomNamespace = async (appId, roomId) => toHex(await hashWith("SHA-256", `${libName}:${appId}:${roomId}`));
const joinChar = "$";
const ivJoinChar = ",";
const encrypt = async (keyP, plaintext) => {
	const iv = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
	return iv.join(ivJoinChar) + joinChar + pack(await crypto.subtle.encrypt({
		name: algo,
		iv
	}, await keyP, encodeBytes(plaintext)));
};
const decrypt = async (keyP, raw) => {
	const [iv, c] = raw.split(joinChar);
	return decodeBytes(await crypto.subtle.decrypt({
		name: algo,
		iv: new Uint8Array(iv?.split(ivJoinChar).map(Number) ?? [])
	}, await keyP, unpack(c ?? "")));
};
//#endregion
export { decrypt, deriveRoomNamespace, encrypt, genKey, hashWith, sha1 };

