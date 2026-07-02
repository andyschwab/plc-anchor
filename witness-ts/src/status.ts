//! The graduated status — the V1 product (REFERENCE.md §1a Mode 1, §4; Phase 5 plan §4).
//!
//! `check(did)` compares the directory's served head against the anchor's proven head and
//! returns `confirmed` / `tentative-consistent` / `diverged` / `absent`, the status a
//! resolver/PDS enforces unilaterally like DMARC's none/quarantine/reject.
//!
//! ## Governing invariant — never a false `diverged` (Phase 5 plan §0)
//!
//! The anchor mitigates a *systemic* risk; a false `diverged` turns that into an *immediate*
//! operational failure on one resolver, whose rational response is to disable the check —
//! removing the mitigation entirely. So every ambiguous edge resolves to a non-alarming
//! status. Concretely, the hard case (window-edge recovery skew) is indistinguishable from a
//! real omission without the anchor's per-op observation time, which no view exposes; so
//! `diverged` fires only when the anchor's **confirmed** head is absent from the directory's
//! live chain AND the directory's head is older than a conservative skew horizon (no near-edge
//! recovery + anchor lag could explain it). The horizon is V1's stand-in for the precise skew
//! bound deferred in the plan — generous on purpose.

import { leafHash, verifyProof, type ProofStep } from "./merkle.ts";
import { deriveLiveChain, type AuditEntry, type LiveChain } from "./directory.ts";

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
    anchorConfirmedHead: string;
    anchorTentativeHead: string;
    /** Whether the anchor's confirmed-head inclusion proof verified against its confirmed root. */
    confirmedProofVerified: boolean;
  };
}

/** The anchor reads `check` needs (a subset of `AnchorReader`, so it's fakeable in tests). */
export interface AnchorView {
  isAnchored(did: string): Promise<boolean>;
  confirmedProof(did: string): Promise<{ head: string; proof: ProofStep[] }>;
  tentativeProof(did: string): Promise<{ head: string; proof: ProofStep[] }>;
  confirmedRoot(): Promise<Uint8Array>;
  tentativeRoot(): Promise<Uint8Array>;
}

/** The directory read `check` needs. */
export interface DirectorySource {
  auditLog(did: string): Promise<AuditEntry[]>;
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

  if (!(await anchor.isAnchored(did))) {
    return result("absent", "not-anchored", {
      directoryHead: null,
      anchorConfirmedHead: "",
      anchorTentativeHead: "",
      confirmedProofVerified: false,
    });
  }

  const [cProof, tProof, cRoot, log] = await Promise.all([
    anchor.confirmedProof(did),
    anchor.tentativeProof(did),
    anchor.confirmedRoot(),
    directory.auditLog(did),
  ]);

  const confirmedProofVerified =
    cProof.head !== "" && verifyProof(leafHash(did, cProof.head), cProof.proof, cRoot);
  const { liveCids, head: dirHead } = deriveLive(log, did);

  const ev: CheckResult["evidence"] = {
    directoryHead: dirHead?.cid ?? null,
    anchorConfirmedHead: cProof.head,
    anchorTentativeHead: tProof.head,
    confirmedProofVerified,
  };

  // Nothing immutable yet: every op is within the 72h window and still nullifiable. There is no
  // confirmed history to contradict, so the strongest honest answer is tentative-consistent —
  // never an alarm (REFERENCE.md §4: no hard "reject unless confirmed" gate).
  if (cProof.head === "") {
    return result("tentative-consistent", "within-window-uncommitted", ev);
  }

  // The anchor claims a confirmed head but its own inclusion proof doesn't reconstruct its
  // confirmed root: an anchor-side integrity problem, not a directory divergence. Don't alarm,
  // but don't assert `confirmed` on an unproven head.
  if (!confirmedProofVerified) {
    return result("tentative-consistent", "anchor-proof-unverified", ev);
  }

  // Strongest assertion: the directory serves exactly the head the anchor has made immutable.
  if (dirHead?.cid === cProof.head) {
    return result("confirmed", "confirmed-head-match", ev);
  }

  // The anchor's confirmed point is still in the directory's live chain — the histories agree on
  // everything proven; the difference is only un-anchored-yet newer ops (ingest lag) or the
  // anchor's tentative tip. Subsumes the expected clock lag (REFERENCE.md §4).
  if (liveCids.has(cProof.head)) {
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
