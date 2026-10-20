// bip340-schnorr.mjs: BIP-340 Schnorr keys and signatures for secp256k1.
//
// A JavaScript port of the signing and key code in nbd-wtf/dart-bip340
// (https://github.com/nbd-wtf/dart-bip340, lib/src/bip340.dart and
// lib/src/helpers.dart), Copyright 2021 fiatjaf, MIT License. The full licence
// text is in licenses/dart-bip340.txt.
//
// Changes from the original: ported from Dart to JavaScript (BigInt), SHA-256
// comes from the browser's Web Crypto, and the elliptic-curve point maths that
// the Dart code takes from pointycastle is written here from scratch (Jacobian
// coordinates). Tap Party maps the bare module name "@noble/secp256k1" to this
// file with an import map, so trystero's Nostr strategy signs its events with
// it. Only the two calls trystero makes are provided: schnorr.keygen() and
// schnorr.signAsync(message, secretKey).

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n
const G = [
  0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
]

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m }
const inv = (a, m = P) => { // extended Euclid
  let [x0, x1, r0, r1] = [0n, 1n, m, mod(a, m)]
  while (r1) { const q = r0 / r1; [x0, x1] = [x1, x0 - q * x1]; [r0, r1] = [r1, r0 - q * r1] }
  return mod(x0, m)
}

// Jacobian points [X, Y, Z]; Z = 0n is the point at infinity.
const INF = [0n, 1n, 0n]
const dbl = ([X, Y, Z]) => {
  if (!Z || !Y) return INF
  const YY = mod(Y * Y), S = mod(4n * X * YY), M = mod(3n * X * X)
  const X3 = mod(M * M - 2n * S)
  return [X3, mod(M * (S - X3) - 8n * YY * YY), mod(2n * Y * Z)]
}
const add = (p, q) => {
  if (!p[2]) return q
  if (!q[2]) return p
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2)
  const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1)
  const S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1)
  if (U1 === U2) return S1 === S2 ? dbl(p) : INF
  const H = mod(U2 - U1), R = mod(S2 - S1), HH = mod(H * H), HHH = mod(H * HH)
  const X3 = mod(R * R - HHH - 2n * U1 * HH)
  return [X3, mod(R * (U1 * HH - X3) - S1 * HHH), mod(H * Z1 * Z2)]
}
const mul = (k) => { // k * G, double-and-add
  let r = INF, q = [G[0], G[1], 1n]
  while (k > 0n) { if (k & 1n) r = add(r, q); q = dbl(q); k >>= 1n }
  return r
}
const affine = ([X, Y, Z]) => { const zi = inv(Z), zi2 = mod(zi * zi); return [mod(X * zi2), mod(Y * zi2 * zi)] }

const toBytes = (n) => { const b = new Uint8Array(32); for (let i = 31; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n } return b }
const fromBytes = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n }
const concat = (...a) => { const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length } return out }
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const tagCache = {}
const taggedHash = async (tag, msg) => {
  const t = tagCache[tag] ??= await sha256(new TextEncoder().encode(tag))
  return sha256(concat(t, t, msg))
}

const randomKey = () => {
  for (;;) {
    const d = fromBytes(crypto.getRandomValues(new Uint8Array(32)))
    if (d > 0n && d < N) return d
  }
}

const getPublicKey = (secretKey) => toBytes(affine(mul(fromBytes(secretKey)))[0])

// Port of sign() in dart-bip340, lib/src/bip340.dart
const signAsync = async (message, secretKey, aux = crypto.getRandomValues(new Uint8Array(32))) => {
  message = message instanceof Uint8Array ? message : new Uint8Array(message)
  const d0 = fromBytes(secretKey)
  if (d0 < 1n || d0 > N - 1n) throw new Error('bad secret key')
  const [Px, Py] = affine(mul(d0))
  const d = Py % 2n === 0n ? d0 : N - d0
  const t = d ^ fromBytes(await taggedHash('BIP0340/aux', aux))
  const k0 = fromBytes(await taggedHash('BIP0340/nonce', concat(toBytes(t), toBytes(Px), message))) % N
  if (k0 === 0n) throw new Error('bad nonce')
  const [Rx, Ry] = affine(mul(k0))
  const k = Ry % 2n === 0n ? k0 : N - k0
  const rX = toBytes(Rx)
  const e = fromBytes(await taggedHash('BIP0340/challenge', concat(rX, toBytes(Px), message))) % N
  return concat(rX, toBytes(mod(k + e * d, N)))
}

const keygen = () => {
  const secretKey = toBytes(randomKey())
  return { secretKey, publicKey: getPublicKey(secretKey) }
}

export const schnorr = { keygen, signAsync, getPublicKey }
export default { schnorr }
