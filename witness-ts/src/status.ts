//! The graduated status — the V1 product (REFERENCE.md §1a Mode 1, §4; Phase 5 plan §4).
//!
//! `check(did)` compares the directory's served head against the anchor's proven head and
//! returns `confirmed` / `tentative-consistent` / `diverged` / `absent`, the status a
//! resolver/PDS enforces unilaterally like DMARC's none/quarantine/reject.
//!
//! ## Verify-on-read (docs/ONCHAIN-REARCH-PLAN.md)
//!
//! The anchor contract stores raw op bytes only — it runs no EC verification and adjudicates no
//! forks. So the witness re-derives the anchor's live chain and confirmed head **here**, from the
//! on-chain bytes, exactly as it already re-derives the directory's (`deriveLiveChain`). The op
//! *bodies* are content-addressed: the witness recomputes each on-chain op's CID from its bytes
//! and cross-references the op body it already fetches from the directory/mirror (a body whose
//! hash ≠ the on-chain CID simply doesn't match, so it can't be substituted). The anchor's
//! contribution is its **independent, block-time** stamp per op — the clock the confirmed-head
//! 72h window measures against (`createdAt` is not in the signed op; §1) — plus non-equivocation.
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

import { cidForBytes, cidForOp } from "./dagcbor.ts";
import { deriveLiveChain, RECOVERY_WINDOW_MS, type AuditEntry, type LiveChain } from "./directory.ts";
import type { AnchorOp } from "./starknet.ts";

// The four graduated statuses, plus `error`: an *unverifiable* input (e.g. the directory
// served a head with an unparseable `createdAt`), distinct from any of the four honest
// verdicts. It never asserts divergence, but it must not be silently absorbed into a
// non-alarming verdict — a malicious directory could otherwise use malformed data to suppress
// `diverged` indefinitely (SECURITY-TODO item 4).
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
 * Re-derive the anchor's confirmed + tentative heads from its on-chain op log. Reuses the exact
 * PLC chain validator `deriveLiveChain` (signatures, linkage, 72h recovery, recovery-of-imported)
 * over entries built from the on-chain bytes: each op's body is cross-referenced content-addressed
 * (`bodiesByCid`, keyed on the *recomputed* CID), stamped with the anchor's **block time**, and
 * flagged with its provenance. An op whose body isn't available truncates the validated chain
 * (linkage would break there anyway) — a strictly conservative, §0-safe degradation.
 */
export function deriveAnchorHeads(
  ops: readonly AnchorOp[],
  bodiesByCid: Map<string, unknown>,
  ctx: { now: number; did: string },
): AnchorHeads {
  const entries: { operation: unknown; createdAt: string; imported: boolean }[] = [];
  for (const op of ops) {
    const cid = cidForBytes(op.signed);
    const body = bodiesByCid.get(cid);
    if (body === undefined) break; // no content-addressed body → can't validate further; truncate
    entries.push({
      operation: body,
      createdAt: new Date(op.createdAt).toISOString(),
      imported: op.imported,
    });
  }

  const live = deriveLiveChain(entries, ctx.did);
  const liveOps = live.ops ?? [];
  // Confirmed head: the latest live op whose block-time 72h window has fully closed (immutable —
  // §4; the read-side mirror of `state::confirmed_head`).
  let confirmedHead = "";
  for (const o of liveOps) {
    if (ctx.now > Date.parse(o.createdAt) + RECOVERY_WINDOW_MS) confirmedHead = o.cid;
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
   * (`deriveAnchorHeads`) runs the real crypto re-derivation; tests that isolate the status ladder
   * inject one that returns chosen heads (the label is the test input, mirroring `deriveLive`).
   */
  deriveAnchor?: (
    ops: readonly AnchorOp[],
    bodiesByCid: Map<string, unknown>,
    ctx: { now: number; did: string },
  ) => AnchorHeads;
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

  // Content-addressed op bodies: recompute each directory entry's CID (never trust its `cid`
  // field) and index the op body by it, so the anchor's on-chain CIDs resolve to hash-pinned
  // bodies. A body whose hash ≠ its claimed CID simply won't be found by an anchor CID.
  const bodiesByCid = new Map<string, unknown>();
  for (const e of log) bodiesByCid.set(cidForOp(e.operation), e.operation);

  const { confirmedHead, tentativeHead } = deriveAnchor(anchorOps, bodiesByCid, { now: now(), did });
  const { liveCids, head: dirHead } = deriveLive(log, did);

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
