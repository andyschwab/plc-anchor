//! Event-gated chain cache — the refresh RPC-cost optimization on the verify-on-read anchor.
//!
//! Under verify-on-read the witness reads each DID's raw op log (`chain`) and re-derives its status
//! client-side. A console refreshing N DIDs every cycle therefore issued O(N) `chain` reads per
//! cycle against a metered RPC — even when nothing on-chain had changed. But the anchor emits a
//! `Stored` event on every `submit_op`/`import`, so "did any DID's log change since block X?" is a
//! single `getEvents` query. This view caches each DID's `chain` and, at the start of a cycle,
//! probes for `Stored` events since the last processed block:
//!
//!   - **No events** → nothing on-chain moved → serve every DID's chain from cache. Cost this
//!     cycle: two RPC calls total (`blockNumber` + one empty `getEvents`), regardless of N. The
//!     72h confirmed-window rollover is still reflected, because `status.ts` re-derives the heads
//!     from the *cached* chain against the current clock — no chain re-read is needed for time to
//!     pass, only for the log to change.
//!   - **Some events** → at least one DID changed; the event only carries the hashed `did_key`, not
//!     the DID string, so without reversing that hash we can't tell *which* — refetch every DID's
//!     chain this cycle (still cheaper than the old path: `isAnchored` is now derived from the
//!     cached/fetched chain, not a second RPC call). Sharpening this to refetch only the changed
//!     DIDs needs a vetted `did_key` (Poseidon) computation in TS — a deliberate follow-up.
//!
//! **Fail-safe:** any error probing the gate (or a cold cache with no cursor) invalidates the whole
//! cache for the cycle — we never serve possibly-stale chains when we can't prove nothing changed,
//! so a broken gate degrades to the correct (full-refetch) behavior, never to a missed divergence.

import type { AnchorOp } from "./starknet.ts";
import type { AnchorView } from "./status.ts";

/** The block-number + event reads the gate needs, on top of the per-DID `AnchorView` reads. */
export interface AnchorEventView extends AnchorView {
  blockNumber(): Promise<number>;
  hasStoredEventsSince(fromBlock: number, toBlock: number): Promise<boolean>;
}

/** A persistent store for cached chains + the event cursor. Persisted (not in-memory) because the
 * console rebuilds its checker every tick and restarts periodically — an in-memory cache would be
 * cold every cycle. Keyed by DID. */
export interface ChainCache {
  get(did: string): AnchorOp[] | null;
  set(did: string, ops: AnchorOp[]): void;
  /** The last block number whose `Stored` events have been accounted for; `null` if never set. */
  getCursor(): number | null;
  setCursor(block: number): void;
}

/** What happened on the most recent `beginCycle()` — surfaced for operator observability. */
export interface CycleStats {
  /** Chains actually re-read from RPC this cycle (the cost metric). */
  refetched: number;
  /** Whether the gate decided the cache had to be invalidated (events seen, cold start, or error). */
  invalidated: boolean;
  /** Whether the event probe itself failed (forcing a fail-safe full refetch). */
  probeFailed: boolean;
}

export class EventCachingAnchorView implements AnchorView {
  readonly #reader: AnchorEventView;
  readonly #cache: ChainCache;
  #invalidate = true;
  #probeFailed = false;
  #fetchedThisCycle = new Set<string>();

  constructor(reader: AnchorEventView, cache: ChainCache) {
    this.#reader = reader;
    this.#cache = cache;
  }

  /** Decide, once per refresh cycle, whether the cache is still trustworthy. Never throws — a probe
   * failure degrades to a full refetch (fail-safe), which the per-DID reads then carry out. */
  async beginCycle(): Promise<void> {
    this.#fetchedThisCycle = new Set();
    this.#probeFailed = false;
    try {
      const latest = await this.#reader.blockNumber();
      const cursor = this.#cache.getCursor();
      // Cold cache (no cursor) → treat everything as changed; otherwise probe the new range.
      this.#invalidate = cursor === null || (await this.#reader.hasStoredEventsSince(cursor + 1, latest));
      // Advance only after a successful probe, so a failure re-probes the same range next cycle.
      this.#cache.setCursor(latest);
    } catch {
      this.#invalidate = true;
      this.#probeFailed = true;
    }
  }

  stats(): CycleStats {
    return {
      refetched: this.#fetchedThisCycle.size,
      invalidated: this.#invalidate,
      probeFailed: this.#probeFailed,
    };
  }

  async chain(did: string): Promise<AnchorOp[]> {
    const cached = this.#cache.get(did);
    // Serve from cache unless the gate invalidated it and we haven't already refreshed this DID
    // this cycle (so `isAnchored` + `chain` in one `check()` cost at most one RPC read).
    const mustRefetch = this.#invalidate && !this.#fetchedThisCycle.has(did);
    if (cached !== null && !mustRefetch) return cached;
    const ops = await this.#reader.chain(did);
    this.#cache.set(did, ops);
    this.#fetchedThisCycle.add(did);
    return ops;
  }

  /** Derived from the (cached or freshly-fetched) chain — never a separate RPC call. */
  async isAnchored(did: string): Promise<boolean> {
    return (await this.chain(did)).length > 0;
  }
}
