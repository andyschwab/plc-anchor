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

// ── Strict DRISL / dag-cbor DECODER (the exact inverse of encodeDagCbor) ──
//
// Verify-on-read (docs/ONCHAIN-REARCH-PLAN.md): the witness reads the anchor's raw op BYTES via
// `chain(did)` and must validate them WITHOUT borrowing the op bodies from the (untrusted)
// directory — otherwise an equivocating directory could withhold bodies to suppress `diverged`.
// So it decodes the on-chain bytes here, independently. Strict/canonical to match @ipld/dag-cbor
// (the encoder's differential authority): non-minimal arguments, out-of-order or duplicate map
// keys, trailing bytes, and anything outside the blessed subset (no byte strings, tags, indefinite
// lengths, or non-float64 simples) are REJECTED — so non-canonical / malformed on-chain bytes
// (necessarily not a directory-served op) are dropped rather than misparsed.

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class CborDecoder {
  pos = 0;
  readonly #data: Uint8Array;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  private u8(): number {
    if (this.pos >= this.#data.length) throw new Error("dag-cbor decode: unexpected end of input");
    return this.#data[this.pos++];
  }

  private bytes(n: number): Uint8Array {
    if (this.pos + n > this.#data.length) throw new Error("dag-cbor decode: unexpected end of input");
    const out = this.#data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read a big-endian unsigned integer of `n` bytes as a JS number (rejects > 2^53-1). */
  private uint(n: number): number {
    let v = 0;
    for (const b of this.bytes(n)) v = v * 256 + b;
    if (!Number.isSafeInteger(v)) throw new Error("dag-cbor decode: integer exceeds 2^53");
    return v;
  }

  /** Decode a head's argument for additional-info `info`, enforcing minimal-length encoding. */
  private arg(info: number): number {
    if (info < 24) return info;
    if (info === 24) {
      const v = this.uint(1);
      if (v < 24) throw new Error("dag-cbor decode: non-minimal 1-byte argument");
      return v;
    }
    if (info === 25) {
      const v = this.uint(2);
      if (v < 0x100) throw new Error("dag-cbor decode: non-minimal 2-byte argument");
      return v;
    }
    if (info === 26) {
      const v = this.uint(4);
      if (v < 0x10000) throw new Error("dag-cbor decode: non-minimal 4-byte argument");
      return v;
    }
    if (info === 27) {
      const v = this.uint(8);
      if (v < 0x100000000) throw new Error("dag-cbor decode: non-minimal 8-byte argument");
      return v;
    }
    throw new Error(`dag-cbor decode: reserved/indefinite additional info ${info}`);
  }

  private str(info: number): string {
    return utf8Decoder.decode(this.bytes(this.arg(info)));
  }

  value(): unknown {
    const head = this.u8();
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0: // unsigned int
        return this.arg(info);
      case 1: // negative int
        return -1 - this.arg(info);
      case 3: // text string
        return this.str(info);
      case 4: { // array
        const n = this.arg(info);
        const arr: unknown[] = [];
        for (let i = 0; i < n; i += 1) arr.push(this.value());
        return arr;
      }
      case 5: { // map
        const n = this.arg(info);
        const obj: Record<string, unknown> = {};
        let prev: string | null = null;
        for (let i = 0; i < n; i += 1) {
          const kHead = this.u8();
          if (kHead >> 5 !== 3) throw new Error("dag-cbor decode: map key is not a text string");
          const key = this.str(kHead & 0x1f);
          // Canonical order: strictly increasing by the same rule the encoder sorts on
          // (length-first, then bytewise) — rejects unsorted keys and duplicates.
          if (prev !== null && !keyLess(prev, key)) {
            throw new Error("dag-cbor decode: map keys out of order or duplicated");
          }
          prev = key;
          obj[key] = this.value();
        }
        return obj;
      }
      case 7: // simple / float
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 27) return new DataView(this.bytes(8).slice().buffer).getFloat64(0, false);
        throw new Error(`dag-cbor decode: unsupported simple value ${info}`);
      default: // 2 = byte string, 6 = tag — not in the blessed subset
        throw new Error(`dag-cbor decode: unsupported major type ${major}`);
    }
  }
}

/** Decode canonical DRISL / dag-cbor bytes to a value — the strict inverse of `encodeDagCbor`.
 * Throws on malformed or non-canonical input (trailing bytes included). */
export function decodeDagCbor(data: Uint8Array): unknown {
  const dec = new CborDecoder(data);
  const value = dec.value();
  if (dec.pos !== data.length) throw new Error("dag-cbor decode: trailing bytes after top-level value");
  return value;
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
