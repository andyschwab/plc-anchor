//! Minimal Starknet read client for the anchor views — hand-encoded calldata, no SDK.
//!
//! Deliberately mirrors `ingest/src/starknet_sink.rs` (`byte_array_calldata` /
//! `byte_array_from_felts`) rather than pulling in `starknet.js`: one ABI-encoding convention
//! across the whole app, and no surprises from an SDK's felt/ByteArray handling on the read
//! path. The selectors are precomputed (`selectors.ts`) because Node has no Keccak-256.
//!
//! The witness only ever **reads** (`starknet_call`); it never builds a transaction. The pure
//! codec (encode/decode) is separated from the network so it can be unit-tested offline.
//!
//! ## Trust boundary — the op log is RPC-trusted (finding 4c)
//!
//! `starknet_call` at `block latest` returns whatever state the queried node *claims*; it is NOT
//! accompanied by a proof against the L1-settled Starknet state root. Under verify-on-read the
//! witness reads the DID's raw op log (`chain`) and re-derives everything from those bytes
//! (`status.ts` → decode + `deriveLiveChain`), so the op *contents* are self-certifying (each op's
//! CID and signature are checked) — but **whether this is the DID's true/complete log comes from
//! this RPC**. A witness pointed at a single untrusted RPC trusts that RPC for the log.
//! Non-equivocation is real
//! at the settlement layer (Starknet has one canonical state, settled to Ethereum); exposing it
//! *trustlessly* to a resolver would require verifying a Starknet **storage proof** against the L1
//! state root — deferred, Mode-2-adjacent infra. Until then: **run your own full node, or trust
//! your RPC.** (REFERENCE.md §1; SECURITY-TODO 4c.)

import { readBoundedText } from "./directory.ts";
import { EVENT_KEYS, SELECTORS, type ViewName } from "./selectors.ts";

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

/** One stored op as returned by the anchor's `chain` view: the raw signed DRISL bytes, the
 * Starknet block time (ms) it was stored at (the independent clock the 72h window uses), and its
 * provenance (settled `import` vs live `submit_op`). Mirrors `anchor.cairo`'s `OpEntry`. */
export interface AnchorOp {
  signed: Uint8Array;
  createdAt: number;
  imported: boolean;
}

/** Decode a Cairo `Array<OpEntry>` (the `chain` view return): a length felt, then each
 * `OpEntry { signed: ByteArray, created_at: u64, imported: bool }` in serde order. */
export function decodeChain(felts: string[], offset = 0): AnchorOp[] {
  let o = offset;
  const len = feltToNumber(felts[o]);
  o += 1;
  const out: AnchorOp[] = [];
  for (let i = 0; i < len; i += 1) {
    const signed = decodeByteArray(felts, o);
    o = signed.next;
    const createdAt = Number(BigInt(felts[o]));
    o += 1;
    const imported = BigInt(felts[o]) !== 0n;
    o += 1;
    out.push({ signed: signed.bytes, createdAt, imported });
  }
  return out;
}

// ---- RPC transport ----------------------------------------------------------

/** A `starknet_call` transport: selector + calldata → the returned felt array. Injectable so
 * the higher-level reads are testable without a live node. */
export type StarknetCall = (selector: string, calldata: string[]) => Promise<string[]>;

/** Upper bound on a `starknet_call` response body. The `chain(did)` view returns a log a
 * permissionless writer can bloat (SECURITY-TODO 4e), so the buffer must be bounded even through
 * an honest RPC. Sized above the felt-JSON encoding (~2.5×) of a `MAX_ANCHOR_LOG_BYTES` log
 * (`status.ts`), so every log the witness would accept fits; a bigger one fails here first. */
const MAX_RPC_BODY_BYTES = 32 * 1024 * 1024;

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
    const body = await readBoundedText(res, MAX_RPC_BODY_BYTES, `starknet_call ${selector}`);
    if (!res.ok) throw new Error(`starknet_call ${selector}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    let json: { result?: string[]; error?: { message: string } };
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`starknet_call ${selector}: non-JSON response from ${rpcUrl} — ${body.slice(0, 200)}`);
    }
    if (json.error) throw new Error(`starknet_call ${selector}: ${json.error.message}`);
    if (!json.result) throw new Error(`starknet_call ${selector}: empty result`);
    return json.result;
  };
}

// ---- Block-number + event transports (the refresh cost gate) ----------------
//
// The console's refresh loop uses these to ask "did any anchored DID's log change since the last
// block I processed?" with one `getEvents` query, instead of re-reading every DID's `chain` every
// cycle. Both are injectable (like `StarknetCall`) so `AnchorReader` stays offline-testable.

/** The node's latest block number (`starknet_blockNumber`). */
export type BlockNumberCall = () => Promise<number>;

/** Count of the anchor's `Stored` events in `[fromBlock, toBlock]` (existence is enough; the
 * caller only branches on `> 0`). Backed by `starknet_getEvents`, filtered on the `Stored` key. */
export type StoredEventProbe = (fromBlock: number, toBlock: number) => Promise<number>;

/** A `starknet_blockNumber` transport over a JSON-RPC endpoint. */
export function httpBlockNumber(rpcUrl: string): BlockNumberCall {
  return async () => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_blockNumber", params: [] }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`starknet_blockNumber: HTTP ${res.status} — ${body.slice(0, 200)}`);
    const json = JSON.parse(body) as { result?: number; error?: { message: string } };
    if (json.error) throw new Error(`starknet_blockNumber: ${json.error.message}`);
    if (typeof json.result !== "number") throw new Error("starknet_blockNumber: no result");
    return json.result;
  };
}

/** A `starknet_getEvents` transport filtered on the anchor's `Stored` event key. Returns how many
 * such events fall in `[fromBlock, toBlock]` (capped by `chunkSize` — the caller only needs "any",
 * so one chunk suffices). An inverted range (`fromBlock > toBlock`: no new blocks) short-circuits
 * to 0 without a network call. */
export function httpStoredEventProbe(
  rpcUrl: string,
  contractAddress: string,
  chunkSize = 1,
): StoredEventProbe {
  return async (fromBlock, toBlock) => {
    if (fromBlock > toBlock) return 0;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_getEvents",
        params: {
          filter: {
            from_block: { block_number: fromBlock },
            to_block: { block_number: toBlock },
            address: contractAddress,
            keys: [[EVENT_KEYS.Stored]],
            chunk_size: chunkSize,
          },
        },
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`starknet_getEvents: HTTP ${res.status} — ${body.slice(0, 200)}`);
    const json = JSON.parse(body) as { result?: { events?: unknown[] }; error?: { message: string } };
    if (json.error) throw new Error(`starknet_getEvents: ${json.error.message}`);
    return json.result?.events?.length ?? 0;
  };
}

// ---- Anchor view reads ------------------------------------------------------

/** Typed reads of the anchor's witness views over an injectable `StarknetCall`. The optional
 * block-number + event probes back the refresh cost gate; a reader built without them (e.g. a test)
 * simply can't gate and re-reads every cycle. */
export class AnchorReader {
  readonly #call: StarknetCall;
  readonly #blockNumber?: BlockNumberCall;
  readonly #storedEvents?: StoredEventProbe;

  constructor(call: StarknetCall, blockNumber?: BlockNumberCall, storedEvents?: StoredEventProbe) {
    this.#call = call;
    this.#blockNumber = blockNumber;
    this.#storedEvents = storedEvents;
  }

  static http(rpcUrl: string, contractAddress: string): AnchorReader {
    return new AnchorReader(
      httpCall(rpcUrl, contractAddress),
      httpBlockNumber(rpcUrl),
      httpStoredEventProbe(rpcUrl, contractAddress),
    );
  }

  #read(view: ViewName, calldata: string[] = []): Promise<string[]> {
    return this.#call(SELECTORS[view], calldata);
  }

  async isAnchored(did: string): Promise<boolean> {
    const felts = await this.#read("is_anchored", encodeString(did));
    return BigInt(felts[0] ?? "0x0") !== 0n;
  }

  /** The DID's full stored op log (oldest-first, including superseded ops), each with its
   * block-time stamp + provenance. `[]` if not anchored. The witness re-derives the live/confirmed
   * head from this (`status.ts`); no on-chain head/root is trusted. */
  async chain(did: string): Promise<AnchorOp[]> {
    return decodeChain(await this.#read("chain", encodeString(did)), 0);
  }

  /** The node's latest block number. Throws if this reader was built without a block-number
   * transport (an injected test reader that doesn't gate). */
  blockNumber(): Promise<number> {
    if (!this.#blockNumber) throw new Error("AnchorReader: no block-number transport configured");
    return this.#blockNumber();
  }

  /** Whether the anchor emitted ≥1 `Stored` event in `[fromBlock, toBlock]` — i.e. any DID's log
   * changed. Throws if built without an event transport. */
  async hasStoredEventsSince(fromBlock: number, toBlock: number): Promise<boolean> {
    if (!this.#storedEvents) throw new Error("AnchorReader: no event transport configured");
    return (await this.#storedEvents(fromBlock, toBlock)) > 0;
  }
}
