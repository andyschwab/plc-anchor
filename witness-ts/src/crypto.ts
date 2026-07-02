//! did:key ECDSA verification for PLC ops — the resolver-side mirror of
//! `cairo/packages/plc_core/src/{key_parse,sig_verify}.cairo`.
//!
//! PLC ops are signed with one of two curves (REFERENCE.md §5): **secp256k1** and **P-256**
//! (secp256r1), compact low-S/raw ECDSA (64-byte `r‖s`, base64url-nopad) over the sha-256 of the
//! DRISL-encoded *unsigned* op, keyed by a compressed did:key. Verification uses `node:crypto`
//! (OpenSSL) — no new dependency, preserving the witness's zero-dep / no-build invariant.
//!
//! S-malleability is curve-asymmetric, matching the authoritative `@atproto/crypto` (which
//! `@did-plc/lib` uses — CLAUDE.md), i.e. matching `sig_verify.cairo`:
//!   - **secp256k1: low-S required.** OpenSSL accepts either S, so we additionally reject S > n/2.
//!   - **P-256: malleable (either S accepted).** atproto's p256 signer does not normalise, so a
//!     high-S op is a *valid* PLC op; OpenSSL accepts both, so no extra check — rejecting would fork.

import { createPublicKey, verify as nodeVerify } from "node:crypto";

/** The two curves PLC uses. */
type Curve = "secp256k1" | "P-256";

interface DidKey {
  curve: Curve;
  /** JWK affine coordinates (base64url), decompressed from the compressed did:key point. */
  x: string;
  y: string;
}

// secp256k1 group order n; low-S requires s <= n/2 (mirrors the corelib low-S check).
const N_K256 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const N_K256_HALF = N_K256 >> 1n;

// Field primes and curve constants for point decompression (both primes ≡ 3 (mod 4)).
const P_K256 = 2n ** 256n - 0x1000003d1n;
const P_R256 = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const B_K256 = 7n;
const B_R256 = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58btc string to bytes (the carry-propagation algorithm, mirroring
 * `key_parse.cairo::decode_base58btc`). Throws on an invalid character. */
function base58btcDecode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const val = B58_ALPHABET.indexOf(ch);
    if (val < 0) throw new Error(`did:key: invalid base58btc character ${JSON.stringify(ch)}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's are leading zero bytes.
  for (let k = 0; k < s.length && s[k] === "1"; k += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

function bigIntTo32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Recover the affine y for a compressed point: sqrt of x³+ax+b with the requested parity.
 * Both curve primes are ≡ 3 (mod 4), so the square root is a single modular exponentiation. */
function decompressY(x: bigint, odd: boolean, curve: Curve): bigint {
  const p = curve === "secp256k1" ? P_K256 : P_R256;
  const a = curve === "secp256k1" ? 0n : p - 3n;
  const b = curve === "secp256k1" ? B_K256 : B_R256;
  const rhs = (((x * x) % p) * x + a * x + b) % p;
  let y = modPow(rhs, (p + 1n) / 4n, p);
  if ((y & 1n) !== (odd ? 1n : 0n)) y = p - y;
  return y;
}

/** Parse a `did:key:z<base58btc>` string into its curve + decompressed JWK coordinates. Accepts
 * exactly the two PLC curves (secp256k1 `0xe701`, P-256 `0x8024` multicodec prefixes); mirrors
 * `key_parse.cairo::parse_did_key`. Throws on anything else. */
function parseDidKey(didKey: string): DidKey {
  if (!didKey.startsWith("did:key:")) throw new Error("did:key: missing prefix");
  const mb = didKey.slice("did:key:".length);
  if (mb[0] !== "z") throw new Error("did:key: not base58btc multibase");
  const decoded = base58btcDecode(mb.slice(1));
  if (decoded.length !== 35) throw new Error("did:key: wrong decoded length");
  const [mc0, mc1, parity] = decoded;
  let curve: Curve;
  if (mc0 === 0xe7 && mc1 === 0x01) curve = "secp256k1";
  else if (mc0 === 0x80 && mc1 === 0x24) curve = "P-256";
  else throw new Error("did:key: unsupported curve");
  if (parity !== 0x02 && parity !== 0x03) throw new Error("did:key: bad compressed-point prefix");
  const x = bytesToBigInt(decoded.subarray(3, 35));
  const y = decompressY(x, parity === 0x03, curve);
  return { curve, x: b64url(bigIntTo32(x)), y: b64url(bigIntTo32(y)) };
}

/**
 * Verify that `sig` (base64url-nopad compact `r‖s`) is a valid ECDSA signature by `didKey` over
 * `unsignedBytes` (the DRISL-encoded unsigned op). Returns `false` on any structural or
 * cryptographic failure — never throws — so an unparseable key is simply "not the signer"
 * (mirroring `op_verify.cairo`'s try-each semantics and `sig_verify.cairo`'s curve asymmetry).
 */
export function verifySig(didKey: string, unsignedBytes: Uint8Array, sig: string): boolean {
  let key: DidKey;
  try {
    key = parseDidKey(didKey);
  } catch {
    return false;
  }
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;

  // secp256k1: enforce low-S (OpenSSL accepts high-S; the reference rejects it). P-256 is
  // malleable in the reference, so no S check there.
  if (key.curve === "secp256k1") {
    const s = bytesToBigInt(sigBytes.subarray(32, 64));
    if (s > N_K256_HALF) return false;
  }

  try {
    const pub = createPublicKey({ key: { kty: "EC", crv: key.curve, x: key.x, y: key.y }, format: "jwk" });
    // ieee-p1363 makes node accept the compact r‖s sig; the digest is sha-256 over the op bytes.
    return nodeVerify("sha256", unsignedBytes, { key: pub, dsaEncoding: "ieee-p1363" }, sigBytes);
  } catch {
    return false;
  }
}
