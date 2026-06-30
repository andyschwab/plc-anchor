//! Minimal Starknet read client for the anchor views — hand-encoded calldata, no SDK.
//!
//! Deliberately mirrors `ingest/src/starknet_sink.rs` (`byte_array_calldata` /
//! `byte_array_from_felts`) rather than pulling in `starknet.js`: one ABI-encoding convention
//! across the whole app, and no surprises from an SDK's felt/ByteArray handling on the read
//! path. The selectors are precomputed (`selectors.ts`) because Node has no Keccak-256.
//!
//! The witness only ever **reads** (`starknet_call`); it never builds a transaction. The pure
//! codec (encode/decode) is separated from the network so it can be unit-tested offline.

import { SELECTORS, type ViewName } from "./selectors.ts";
import type { ProofStep } from "./merkle.ts";

// ---- felt helpers -----------------------------------------------------------

/** A Cairo `ByteArray`'s 31-byte word size. */
const WORD = 31;

const hexToBytes = (hex: string): Uint8Array => {
  let h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 === 1) h = `0${h}`;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** A big-endian byte slice as a minimal `0x` felt (no leading-zero padding; `0x0` for empty). */
const bytesToFelt = (bytes: Uint8Array): string => {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  hex = hex.replace(/^0+/, "");
  return `0x${hex === "" ? "0" : hex}`;
};

/** A felt decoded into exactly `len` big-endian bytes (right-aligned, zero-padded). */
const feltToBytes = (felt: string, len: number): Uint8Array => {
  let raw = hexToBytes(felt);
  if (raw.length > len) raw = raw.subarray(raw.length - len);
  const out = new Uint8Array(len);
  out.set(raw, len - raw.length);
  return out;
};

const feltToNumber = (felt: string): number => Number(BigInt(felt));

// ---- Cairo ByteArray (de)serialization --------------------------------------
// Layout: [num_full_words, word_0 … word_{n-1} (31B BE each), pending_word (BE), pending_len].
// Mirrors byte_array_calldata / byte_array_from_felts in starknet_sink.rs.

/** Encode bytes as a `ByteArray`'s calldata felts. */
export function encodeByteArray(data: Uint8Array): string[] {
  const full = Math.floor(data.length / WORD);
  const rem = data.length % WORD;
  const out: string[] = [`0x${full.toString(16)}`];
  for (let i = 0; i < full; i += 1) out.push(bytesToFelt(data.subarray(i * WORD, i * WORD + WORD)));
  out.push(bytesToFelt(data.subarray(full * WORD))); // pending word (empty → 0x0)
  out.push(`0x${rem.toString(16)}`);
  return out;
}

/** Encode a UTF-8 string as a `ByteArray`'s calldata felts. */
export const encodeString = (s: string): string[] => encodeByteArray(new TextEncoder().encode(s));

/** Decode one `ByteArray` starting at `offset`; returns its bytes and the next felt index. */
export function decodeByteArray(felts: string[], offset: number): { bytes: Uint8Array; next: number } {
  const full = feltToNumber(felts[offset]);
  const pendingLen = feltToNumber(felts[offset + full + 2]);
  const bytes = new Uint8Array(full * WORD + pendingLen);
  let p = 0;
  for (let i = 0; i < full; i += 1) {
    bytes.set(feltToBytes(felts[offset + 1 + i], WORD), p);
    p += WORD;
  }
  if (pendingLen > 0) bytes.set(feltToBytes(felts[offset + 1 + full], pendingLen), p);
  return { bytes, next: offset + full + 3 };
}

/** Decode a `(ByteArray head, Array<ProofStep>)` tuple — the proof views' return shape. */
export function decodeProof(felts: string[], offset = 0): { head: string; proof: ProofStep[] } {
  const head = decodeByteArray(felts, offset);
  let o = head.next;
  const len = feltToNumber(felts[o]);
  o += 1;
  const proof: ProofStep[] = [];
  for (let i = 0; i < len; i += 1) {
    const sibling = decodeByteArray(felts, o);
    o = sibling.next;
    const siblingIsLeft = BigInt(felts[o]) !== 0n;
    o += 1;
    proof.push({ sibling: sibling.bytes, siblingIsLeft });
  }
  return { head: new TextDecoder().decode(head.bytes), proof };
}

// ---- RPC transport ----------------------------------------------------------

/** A `starknet_call` transport: selector + calldata → the returned felt array. Injectable so
 * the higher-level reads are testable without a live node. */
export type StarknetCall = (selector: string, calldata: string[]) => Promise<string[]>;

/** A `starknet_call` transport backed by a JSON-RPC endpoint (spec 0.10.x). */
export function httpCall(rpcUrl: string, contractAddress: string): StarknetCall {
  return async (selector, calldata) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_call",
        params: {
          request: { contract_address: contractAddress, entry_point_selector: selector, calldata },
          block_id: "latest",
        },
      }),
    });
    const json = (await res.json()) as { result?: string[]; error?: { message: string } };
    if (json.error) throw new Error(`starknet_call ${selector}: ${json.error.message}`);
    if (!json.result) throw new Error(`starknet_call ${selector}: empty result`);
    return json.result;
  };
}

// ---- Anchor view reads ------------------------------------------------------

/** Typed reads of the anchor's witness views over an injectable `StarknetCall`. */
export class AnchorReader {
  readonly #call: StarknetCall;

  constructor(call: StarknetCall) {
    this.#call = call;
  }

  static http(rpcUrl: string, contractAddress: string): AnchorReader {
    return new AnchorReader(httpCall(rpcUrl, contractAddress));
  }

  #read(view: ViewName, calldata: string[] = []): Promise<string[]> {
    return this.#call(SELECTORS[view], calldata);
  }

  async isAnchored(did: string): Promise<boolean> {
    const felts = await this.#read("is_anchored", encodeString(did));
    return BigInt(felts[0] ?? "0x0") !== 0n;
  }

  /** Tentative-tip head CID string, or "" if not anchored. */
  async headCid(did: string): Promise<string> {
    const felts = await this.#read("head_cid", encodeString(did));
    return new TextDecoder().decode(decodeByteArray(felts, 0).bytes);
  }

  /** Confirmed head CID string (past the 72h window), or "" if none yet. */
  async confirmedHead(did: string): Promise<string> {
    const felts = await this.#read("confirmed_head", encodeString(did));
    return new TextDecoder().decode(decodeByteArray(felts, 0).bytes);
  }

  /** 32-byte tentative commitment root. */
  async tentativeRoot(): Promise<Uint8Array> {
    return decodeByteArray(await this.#read("tentative_root"), 0).bytes;
  }

  /** 32-byte confirmed commitment root. */
  async confirmedRoot(): Promise<Uint8Array> {
    return decodeByteArray(await this.#read("confirmed_root"), 0).bytes;
  }

  /** Inclusion proof of `did`'s tentative head against `tentativeRoot()`. `head` is "" if absent. */
  async tentativeProof(did: string): Promise<{ head: string; proof: ProofStep[] }> {
    return decodeProof(await this.#read("tentative_proof", encodeString(did)));
  }

  /** Inclusion proof of `did`'s confirmed head against `confirmedRoot()`. `head` is "" if unconfirmed. */
  async confirmedProof(did: string): Promise<{ head: string; proof: ProofStep[] }> {
    return decodeProof(await this.#read("confirmed_proof", encodeString(did)));
  }
}
