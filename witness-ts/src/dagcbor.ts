//! Canonical DRISL / dag-cbor (dCBOR42) encoding + DASL CID derivation — the resolver-side
//! byte-exact mirror of `cairo/packages/drisl` (`drisl.cairo` encode + `cid.cairo`).
//!
//! The witness re-derives PLC recovery locally (SECURITY-TODO item 1) instead of trusting the
//! directory's `nullified` flag. Doing that means reproducing two hashes PLC self-certifies over,
//! and both are over *canonical* dag-cbor bytes — there is exactly one valid encoding of a value:
//!
//!   - **signature** is over the DRISL encoding of the *unsigned* op (sig field removed).
//!   - **CID** (and the `did:plc` fragment) is over the DRISL encoding of the *signed* op.
//!
//! (REFERENCE.md §5; CLAUDE.md "signed vs unsigned — do not conflate".) This encoder must stay
//! byte-identical to `@ipld/dag-cbor` (the encoder `@did-plc/lib` uses) — the differential corpus
//! in `test/nullified.test.ts` pins that against a `@did-plc/lib`-ground-truthed fixture.
//!
//! Blessed subset only: minimal-length integer/length encoding; 64-bit floats; definite lengths;
//! text-string map keys ordered length-first then bytewise (dag-cbor's canonical ordering, the
//! same `key_gt` rule as `drisl.cairo`). PLC ops contain only strings / null / arrays / maps, but
//! ints/floats/bools are handled too so any well-formed op hashes correctly.

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Emit a CBOR major-type head with the minimal-length argument encoding (mirrors
 * `drisl.cairo::encode_head`). */
function encodeHead(out: number[], major: number, arg: number): void {
  const mt = major * 32;
  if (arg < 24) {
    out.push(mt + arg);
  } else if (arg < 0x100) {
    out.push(mt + 24, arg & 0xff);
  } else if (arg < 0x10000) {
    out.push(mt + 25, (arg >>> 8) & 0xff, arg & 0xff);
  } else if (arg < 0x100000000) {
    out.push(mt + 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff);
  } else {
    // 64-bit argument (map/array/string length or integer). Split across the 2^32 boundary since
    // bitwise ops in JS are 32-bit.
    const hi = Math.floor(arg / 0x100000000);
    const lo = arg >>> 0;
    out.push(
      mt + 27,
      (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    );
  }
}

/** Compare two map keys by dag-cbor canonical order: length first, then bytewise (RFC 8949's
 * length-first ordering that dag-cbor mandates; the same rule as `drisl.cairo::key_gt`). */
function keyLess(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

function encodeValue(out: number[], value: unknown): void {
  if (value === null || value === undefined) {
    out.push(0xf6); // null (undefined is not dag-cbor-representable; a real op never carries it)
    return;
  }
  const t = typeof value;
  if (t === "boolean") {
    out.push(value ? 0xf5 : 0xf4);
    return;
  }
  if (t === "string") {
    const b = utf8(value as string);
    encodeHead(out, 3, b.length);
    for (const x of b) out.push(x);
    return;
  }
  if (t === "number") {
    const n = value as number;
    if (Number.isInteger(n)) {
      if (n >= 0) encodeHead(out, 0, n);
      else encodeHead(out, 1, -n - 1);
    } else {
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setFloat64(0, n, false);
      out.push(0xfb, ...buf);
    }
    return;
  }
  if (Array.isArray(value)) {
    encodeHead(out, 4, value.length);
    for (const e of value) encodeValue(out, e);
    return;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (keyLess(a, b) ? -1 : a === b ? 0 : 1));
    encodeHead(out, 5, keys.length);
    for (const k of keys) {
      const kb = utf8(k);
      encodeHead(out, 3, kb.length);
      for (const x of kb) out.push(x);
      encodeValue(out, obj[k]);
    }
    return;
  }
  throw new Error(`dag-cbor: unsupported value type ${t}`);
}

/** Canonically encode a JSON-like value to DRISL / dag-cbor bytes. */
export function encodeDagCbor(value: unknown): Uint8Array {
  const out: number[] = [];
  encodeValue(out, value);
  return Uint8Array.from(out);
}

// ── DASL CID derivation (mirrors cid.cairo) ──

import { createHash } from "node:crypto";

const CID_V1 = 0x01;
const CODEC_DAGCBOR = 0x71;
const MH_SHA2_256 = 0x12;
const DIGEST_LEN_32 = 0x20;

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

/** RFC 4648 base32, lowercase, no padding (mirrors `cid.cairo::base32_encode_nopad`). */
function base32NoPad(data: Uint8Array): string {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let acc = 0;
  let nbits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    nbits += 8;
    while (nbits >= 5) {
      nbits -= 5;
      out += ALPHABET[(acc >>> nbits) & 0x1f];
    }
    acc &= (1 << nbits) - 1;
  }
  if (nbits > 0) out += ALPHABET[(acc << (5 - nbits)) & 0x1f];
  return out;
}

/** The base32 multibase CID string PLC stores in `prev` and resolvers print: `'b'` +
 * base32-lower-nopad of `0x01 0x71 0x12 0x20 ‖ sha256(payload)`. This is `derive_cid_string`
 * in `cid.cairo` for `codec = dag-cbor`. */
export function cidForBytes(payload: Uint8Array): string {
  const digest = sha256(payload);
  const cid = new Uint8Array(4 + digest.length);
  cid[0] = CID_V1;
  cid[1] = CODEC_DAGCBOR;
  cid[2] = MH_SHA2_256;
  cid[3] = DIGEST_LEN_32;
  cid.set(digest, 4);
  return `b${base32NoPad(cid)}`;
}

/** The CID of a (signed) PLC op: encode it canonically, then derive the dag-cbor CID string. */
export function cidForOp(op: unknown): string {
  return cidForBytes(encodeDagCbor(op));
}

/** The `did:plc:<fragment>` for a signed genesis op: `did:plc:` + base32lower-nopad(
 * sha256(signed op))[0..24] (mirrors `cid.cairo::derive_did_fragment`; hashes the *signed* op —
 * REFERENCE.md §5). */
export function didForGenesisOp(op: unknown): string {
  const digest = sha256(encodeDagCbor(op));
  return `did:plc:${base32NoPad(digest.subarray(0, 15)).slice(0, 24)}`;
}
