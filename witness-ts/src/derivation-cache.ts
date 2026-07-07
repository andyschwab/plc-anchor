//! Derivation memo — the refresh CPU-cost optimization on the verify-on-read status path.
//!
//! `check(did)` re-derives the status by running the full PLC validator (ECDSA signature
//! verification, linkage, 72h recovery) over BOTH the anchor's on-chain op log and the directory's
//! audit log — `deriveAnchorLive` and `deriveLiveChain`. That crypto, not the RPC, is what pins a
//! shared CPU when a console refreshes a large roster every cycle: the event-gated chain cache
//! (`EventCachingAnchorView`) stopped us re-*fetching* unchanged logs, but `check()` still re-
//! *verified* them every cycle.
//!
//! This memoizes each side's *validated* result, keyed on a content hash of its input, per DID. An
//! unchanged op log hashes the same → the cached `LiveChain` is returned and not one signature is
//! re-verified. It is a **pure skip-when-identical cache**: identical input yields the identical
//! result the uncached path would have, so it cannot change any verdict (the never-false-`diverged`
//! invariant is untouched). Only the cheap, clock-dependent `headsFromLive` re-runs each cycle, so
//! the 72h confirmed-window rollover is still reflected without re-verifying anything.
//!
//! The memo is per-DID single-slot (each DID keeps only its latest input→result), so it is bounded
//! by the roster size, and in-memory (the checker is held across cycles). A restart loses it and
//! pays one cold cycle — the same shape as the chain cache.

import { createHash } from "node:crypto";
import { deriveLiveChain, type AuditEntry, type LiveChain } from "./directory.ts";
import type { AnchorOp } from "./starknet.ts";
import { deriveAnchorLive, headsFromLive, type AnchorHeads } from "./status.ts";

/** sha256 of the anchor op log — the bytes + block time + provenance that fully determine the
 * validated live chain. */
function hashOps(ops: readonly AnchorOp[]): string {
  const h = createHash("sha256");
  for (const op of ops) {
    h.update(op.signed);
    h.update(` ${op.createdAt} ${op.imported ? 1 : 0} `);
  }
  return h.digest("base64");
}

/** sha256 of a directory audit log. Identical fetched log → identical JSON → identical hash. */
function hashLog(log: readonly AuditEntry[]): string {
  return createHash("sha256").update(JSON.stringify(log)).digest("base64");
}

interface Slot {
  hash: string;
  live: LiveChain;
}

/** Wall-clock-independent derivation counts for the most recent cycle (observability). */
export interface DerivationStats {
  /** Chains actually re-validated (crypto ran) this cycle. */
  verified: number;
  /** Chains served from the memo (crypto skipped) this cycle. */
  cached: number;
}

export class DerivationCache {
  readonly #anchor = new Map<string, Slot>();
  readonly #directory = new Map<string, Slot>();
  #verified = 0;
  #cached = 0;

  /** Reset the per-cycle counters. Call once at the start of a refresh pass. */
  beginCycle(): void {
    this.#verified = 0;
    this.#cached = 0;
  }

  stats(): DerivationStats {
    return { verified: this.#verified, cached: this.#cached };
  }

  /** A `CheckOptions.deriveAnchor`: memoizes the expensive `deriveAnchorLive` on the op-log hash,
   * then applies the cheap clock-dependent `headsFromLive` fresh each call. */
  deriveAnchor = (ops: readonly AnchorOp[], ctx: { now: number; did: string }): AnchorHeads => {
    const live = this.#memo(this.#anchor, ctx.did, hashOps(ops), () => deriveAnchorLive(ops, ctx.did));
    return headsFromLive(live, ctx.now);
  };

  /** A `CheckOptions.deriveLive`: memoizes the directory-side `deriveLiveChain` on the audit-log
   * hash. The whole result is clock-independent, so it is reused verbatim when the log is unchanged. */
  deriveLive = (log: readonly AuditEntry[], did: string): LiveChain => {
    return this.#memo(this.#directory, did, hashLog(log), () => deriveLiveChain(log, did));
  };

  #memo(slots: Map<string, Slot>, did: string, hash: string, compute: () => LiveChain): LiveChain {
    const cur = slots.get(did);
    if (cur !== undefined && cur.hash === hash) {
      this.#cached += 1;
      return cur.live;
    }
    this.#verified += 1;
    const live = compute();
    slots.set(did, { hash, live });
    return live;
  }
}
