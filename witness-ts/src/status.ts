//! The graduated status — the V1 product (REFERENCE.md §1a Mode 1, §4; Phase 5 plan §4).
//!
//! `check(did)` compares the directory's served head against the anchor's proven head and
//! returns `confirmed` / `tentative-consistent` / `diverged` / `absent`, the status a
//! resolver/PDS enforces unilaterally like DMARC's none/quarantine/reject.
//!
//! ## Verify-on-read (docs/ONCHAIN-REARCH-PLAN.md)
//!
//! The anchor contract stores raw op bytes only — it runs no EC verification and adjudicates no
//! forks. So the witness re-derives the anchor's live chain and confirmed head **here**, by
//! DECODING the on-chain bytes itself (`decodeDagCbor`) and running the same PLC validator it runs
//! on the directory (`deriveLiveChain`). Decoding the anchor's own bytes — rather than borrowing op
//! bodies from the directory it is checking — is what lets it catch an equivocating directory: the
//! directory can serve a forged log, but it cannot alter the non-equivocable bytes the anchor
//! stored, so the confirmed head is derived from the anchor alone. The anchor's contribution is
//! that non-equivocation plus its **independent, block-time** stamp per op — the clock the
//! confirmed-head 72h window measures against (`createdAt` is not in the signed op; §1).
//!
//! ## Governing invariant — never a false `diverged` (Phase 5 plan §0)
//!
//! The anchor mitigates a *systemic* risk; a false `diverged` turns that into an *immediate*
//! operational failure on one resolver, whose rational response is to disable the check —
//! removing the mitigation entirely. So every ambiguous edge resolves to a non-alarming
//! status. Concretely, the hard case (window-edge recovery skew) is indistinguishable from a
//! real omission without the anchor's per-op observation time; so `diverged` fires only when the
//! anchor's **confirmed** head (derived from the anchor's block-time clock) is absent from the
//! directory's live chain AND the directory's head is older than a conservative skew horizon (no
//! near-edge recovery + anchor lag could explain it). The horizon is V1's stand-in for the
//! precise skew bound deferred in the plan — generous on purpose.

import { decodeDagCbor } from "./dagcbor.ts";
import { deriveLiveChain, RECOVERY_WINDOW_MS, type AuditEntry, type LiveChain } from "./directory.ts";
import type { AnchorOp } from "./starknet.ts";

// The four graduated statuses, plus `error`: an *unverifiable* input (e.g. the directory
// served a head with an unparseable `createdAt`, or the anchor log exceeds the witness's
// spam bounds — SECURITY-TODO 4e), distinct from any of the four honest verdicts. It never
// asserts divergence, but it must not be silently absorbed into a non-alarming verdict — a
// malicious directory could otherwise use malformed data to suppress `diverged` indefinitely
// (SECURITY-TODO item 4).
export type Status = "confirmed" | "tentative-consistent" | "diverged" | "absent" | "error";

export interface CheckResult {
  status: Status;
  /** Machine-readable tag for the decision (also drives the human explanation). */
  reason: string;
  evidence: {
    directoryHead: string | null;
    /** The anchor's confirmed head, re-derived from the on-chain op log (block-time 72h window). */
    anchorConfirmedHead: string;
    /** The anchor's tentative tip, re-derived from the on-chain op log. */
    anchorTentativeHead: string;
  };
}

/** The anchor's re-derived heads: the immutable confirmed head (past the 72h window) and the
 * current tentative tip, both over the anchor's *validated* live chain. */
export interface AnchorHeads {
  confirmedHead: string;
  tentativeHead: string;
}

// ── Anchor-log bounds (SECURITY-TODO 4e) ──
//
// The anchor's writes are permissionless, so its op log — unlike the operator-run directory's —
// can be bloated by anyone willing to pay gas. These caps mirror the directory-path bounds
// (`MAX_AUDIT_ENTRIES` / `MAX_AUDIT_BODY_BYTES`, `directory.ts`) so the MORE-exposed surface is at
// least as defended: a pumped log degrades to a bounded, non-alarming `error` (never `diverged`,
// never an unbounded decode/verify loop or RPC buffer). A real DID's history is tens of ops.

/** Upper bound on anchor-log ops the witness will validate for one DID. */
export const MAX_ANCHOR_OPS = 10_000;

/** Upper bound on the total signed op bytes the witness will validate for one DID. */
export const MAX_ANCHOR_LOG_BYTES = 8 * 1024 * 1024;

/** A DID's on-chain op log exceeds the witness's bounds (`MAX_ANCHOR_OPS` /
 * `MAX_ANCHOR_LOG_BYTES`) — storage spam on the permissionless write path. `check()` maps this to
 * `error` (`anchor-log-overflow`): unavailable, never a verdict (SECURITY-TODO 4e). */
export class AnchorLogOverflowError extends Error {
  constructor(did: string, detail: string) {
    super(`anchor op log for ${did} exceeds witness bounds: ${detail}`);
    this.name = "AnchorLogOverflowError";
  }
}

/** The anchor reads `check` needs (a subset of `AnchorReader`, so it's fakeable in tests). */
export interface AnchorView {
  isAnchored(did: string): Promise<boolean>;
  /** The DID's full on-chain op log (raw signed bytes + block-time stamps + provenance). */
  chain(did: string): Promise<AnchorOp[]>;
}

/** The directory read `check` needs. */
export interface DirectorySource {
  auditLog(did: string): Promise<AuditEntry[]>;
}

/**
 * Re-derive the anchor's confirmed + tentative heads from its on-chain op log — **independently of
 * the directory**. Reuses the exact PLC chain validator `deriveLiveChain` (signatures, linkage,
 * 72h recovery, recovery-of-imported) over entries built by DECODING each op's on-chain bytes
 * (`decodeDagCbor`), stamped with the anchor's **block time** and flagged with its provenance.
 *
 * Decoding the on-chain bytes (not borrowing op bodies from the directory being checked) is what
 * lets the witness catch an equivocating directory: the directory can serve a forged log, but it
 * cannot alter the non-equivocable bytes the anchor stored, so the confirmed head is derived from
 * the anchor alone. An op that doesn't decode canonically or doesn't validate (necessarily not a
 * directory-served op — a permissionless writer's garbage) is SKIPPED, not a truncation point
 * (SECURITY-TODO 4e): the log is append-only, so truncating at junk would let one cheap bogus
 * append permanently hide every real op stored after it — a per-DID silencing of the witness.
 * Skipping admits nothing: a validly-signed, correctly-linked op is still required to advance the
 * head, so a bogus on-chain append can never become the confirmed head (no false `diverged`).
 *
 * @throws AnchorLogOverflowError when the log exceeds `MAX_ANCHOR_OPS`/`MAX_ANCHOR_LOG_BYTES`
 * (checked before any decode/crypto); `check()` maps it to `error`, never a verdict.
 */
export function deriveAnchorHeads(ops: readonly AnchorOp[], ctx: { now: number; did: string }): AnchorHeads {
  return headsFromLive(deriveAnchorLive(ops, ctx.did), ctx.now);
}

/**
 * The **expensive, clock-independent** half of `deriveAnchorHeads`: decode the anchor's on-chain
 * bytes and run the full PLC validator (signature verification, linkage, 72h recovery). Its result
 * — the validated live chain — depends only on the op bytes, *not* on `now`, so a caller that knows
 * the op log is unchanged (e.g. the event-gated chain cache) can reuse it across cycles instead of
 * re-verifying every signature (`DerivationCache`). Split out purely to make that memoization
 * possible; `deriveAnchorHeads` composes it with `headsFromLive` exactly as before.
 */
export function deriveAnchorLive(ops: readonly AnchorOp[], did: string): LiveChain {
  // Bounds first, before any decode or EC verification, so a spam-pumped log costs the witness
  // one cheap length pass, not an unbounded validation loop (SECURITY-TODO 4e).
  if (ops.length > MAX_ANCHOR_OPS) {
    throw new AnchorLogOverflowError(did, `${ops.length} ops exceeds cap ${MAX_ANCHOR_OPS}`);
  }
  let totalBytes = 0;
  for (const op of ops) totalBytes += op.signed.byteLength;
  if (totalBytes > MAX_ANCHOR_LOG_BYTES) {
    throw new AnchorLogOverflowError(did, `${totalBytes} op bytes exceeds cap ${MAX_ANCHOR_LOG_BYTES}`);
  }

  const entries: { operation: unknown; createdAt: string; imported: boolean }[] = [];
  for (const op of ops) {
    let operation: unknown;
    try {
      operation = decodeDagCbor(op.signed);
    } catch {
      continue; // non-canonical / undecodable bytes → permissionless junk; skip, don't truncate (4e)
    }
    entries.push({
      operation,
      createdAt: new Date(op.createdAt).toISOString(),
      imported: op.imported,
    });
  }
  // Skip-mode replay: decodable-but-invalid entries (forged sig, bad linkage, weaker-key/late
  // recovery) are likewise skipped, for the same 4e reason — junk must not hide later real ops.
  return deriveLiveChain(entries, did, { onInvalid: "skip" });
}

/**
 * The **cheap, clock-dependent** half: pick the confirmed head (latest live op whose block-time 72h
 * window has fully closed — immutable, §4; the read-side mirror of `state::confirmed_head`) and the
 * tentative tip from an already-validated live chain. No crypto, so it is safe to re-run every cycle
 * over a memoized `deriveAnchorLive` result.
 */
export function headsFromLive(live: LiveChain, now: number): AnchorHeads {
  const liveOps = live.ops ?? [];
  let confirmedHead = "";
  for (const o of liveOps) {
    if (now > Date.parse(o.createdAt) + RECOVERY_WINDOW_MS) confirmedHead = o.cid;
  }
  return { confirmedHead, tentativeHead: live.head?.cid ?? "" };
}

export interface CheckOptions {
  /** How recent the directory's head must be for an absent-confirmed-head to be treated as
   * possible window-edge skew rather than `diverged`. The PLC 72h window plus a generous lag
   * allowance; the conservative stand-in for the precise skew bound (plan §0). Default 14 days. */
  skewHorizonMs?: number;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
  /**
   * How the directory's live head + live-CID set are derived from its audit log. The default
   * (`deriveLiveChain`) re-derives PLC recovery from the op contents — discarding the directory's
   * untrusted `nullified` flag (SECURITY-TODO item 1). Tests that isolate the status ladder from
   * the crypto (or drive it with stub ops) inject a flag-based derivation instead.
   */
  deriveLive?: (log: readonly AuditEntry[], did: string) => LiveChain;
  /**
   * How the anchor's confirmed/tentative heads are derived from its on-chain op log. The default
   * (`deriveAnchorHeads`) decodes the on-chain bytes and runs the real crypto re-derivation; tests
   * that isolate the status ladder inject one that returns chosen heads (the label is the test
   * input, mirroring `deriveLive`).
   */
  deriveAnchor?: (ops: readonly AnchorOp[], ctx: { now: number; did: string }) => AnchorHeads;
}

const DEFAULT_SKEW_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

function result(status: Status, reason: string, ev: CheckResult["evidence"]): CheckResult {
  return { status, reason, evidence: ev };
}

/**
 * Compute the graduated status for `did`. Reads are concurrent where independent. See the
 * module invariant: this biases to a non-alarming status on every ambiguous edge.
 */
export async function check(
  did: string,
  anchor: AnchorView,
  directory: DirectorySource,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const skewHorizonMs = options.skewHorizonMs ?? DEFAULT_SKEW_HORIZON_MS;
  const now = options.now ?? Date.now;
  const deriveLive = options.deriveLive ?? deriveLiveChain;
  const deriveAnchor = options.deriveAnchor ?? deriveAnchorHeads;

  if (!(await anchor.isAnchored(did))) {
    return result("absent", "not-anchored", {
      directoryHead: null,
      anchorConfirmedHead: "",
      anchorTentativeHead: "",
    });
  }

  const [anchorOps, log] = await Promise.all([anchor.chain(did), directory.auditLog(did)]);

  const { liveCids, head: dirHead } = deriveLive(log, did);

  // The anchor's heads are re-derived from its own on-chain bytes (decoded), independent of the
  // directory — so an equivocating directory can't suppress the alarm by withholding op bodies.
  // A spam-bloated log (permissionless writes; SECURITY-TODO 4e) exceeds the witness's bounds and
  // degrades to `error` — unavailable, never a verdict, exactly like the directory-side caps.
  let heads: AnchorHeads;
  try {
    heads = deriveAnchor(anchorOps, { now: now(), did });
  } catch (e) {
    if (e instanceof AnchorLogOverflowError) {
      return result("error", "anchor-log-overflow", {
        directoryHead: dirHead?.cid ?? null,
        anchorConfirmedHead: "",
        anchorTentativeHead: "",
      });
    }
    throw e;
  }
  const { confirmedHead, tentativeHead } = heads;

  const ev: CheckResult["evidence"] = {
    directoryHead: dirHead?.cid ?? null,
    anchorConfirmedHead: confirmedHead,
    anchorTentativeHead: tentativeHead,
  };

  // Nothing immutable yet: every op is within the 72h window and still nullifiable. There is no
  // confirmed history to contradict, so the strongest honest answer is tentative-consistent —
  // never an alarm (REFERENCE.md §4: no hard "reject unless confirmed" gate).
  if (confirmedHead === "") {
    return result("tentative-consistent", "within-window-uncommitted", ev);
  }

  // Strongest assertion: the directory serves exactly the head the anchor has made immutable.
  if (dirHead?.cid === confirmedHead) {
    return result("confirmed", "confirmed-head-match", ev);
  }

  // The anchor's confirmed point is still in the directory's live chain — the histories agree on
  // everything proven; the difference is only un-anchored-yet newer ops (ingest lag) or the
  // anchor's tentative tip. Subsumes the expected clock lag (REFERENCE.md §4).
  if (liveCids.has(confirmedHead)) {
    return result("tentative-consistent", "confirmed-head-in-live-chain", ev);
  }

  // The directory's live chain does NOT contain a head the anchor confirmed. Real contradiction
  // UNLESS it is window-edge skew: near the 72h edge the anchor (later clock) can accept a
  // recovery the directory rejected, committing to a head the directory never served. We cannot
  // measure the exact skew, so: if the directory's head is recent (within the horizon), defer —
  // skew-pending. Only a head old enough to rule that out is `diverged`.

  // No live head at all: the directory serves nothing the anchor confirmed — real divergence.
  if (dirHead === null) {
    return result("diverged", "confirmed-head-absent", ev);
  }

  // The skew/divergence split depends entirely on the directory head's `createdAt`. If it is
  // unparseable we cannot make that call, so we must not default to a non-alarming verdict —
  // surface it as `error` rather than letting a malformed timestamp suppress `diverged`
  // indefinitely (SECURITY-TODO item 4).
  const dirCreatedMs = Date.parse(dirHead.createdAt);
  if (Number.isNaN(dirCreatedMs)) {
    return result("error", "directory-timestamp-unparseable", ev);
  }

  if (now() - dirCreatedMs <= skewHorizonMs) {
    return result("tentative-consistent", "skew-pending", ev);
  }

  return result("diverged", "confirmed-head-absent", ev);
}
