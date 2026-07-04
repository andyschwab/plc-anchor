//! Status refresher — pulls the §4 graduated status for each anchored DID and records it.
//!
//! Depends only on the `StatusChecker` interface, so it's testable with a mock (the real binding
//! to `@plc-anchor/witness` lives in `witness.ts`, isolated). The never-false-`diverged`
//! invariant lives in the witness library; here we only persist what it returns and surface
//! `diverged` as the alarm (`RosterStore.diverged()`).
//!
//! ## Root-change gate (RPC cost) — never a false skip
//!
//! `confirmedRoot`/`tentativeRoot` are a single commitment over *every* tracked DID; if both are
//! byte-identical to the last cycle's, the entire committed state is provably unchanged (a Merkle
//! root is sensitive to any leaf), so no previously-checked DID's on-chain evidence could have
//! changed either — skipping its RPC re-check is safe, not a heuristic. `confirmed_root` is also a
//! read-time view (recomputed against the current block timestamp, not a stored value bumped by a
//! transaction — see `anchor.cairo`), so comparing consecutive reads catches a pure 72h-window
//! rollover too, not just new ops. A DID never checked before (`statusCheckedAt === null`) is
//! always checked regardless — the gate only skips *re*-checks, never a first check. When the
//! roots did move, every active DID is re-checked (the gate can't tell *which* DID changed, only
//! that at least one did) — conservative, but only as often as the chain actually changes.

import type { RosterStore } from "./roster.ts";
import type { WitnessStatus } from "./types.ts";

/** The witness check, reduced to what the store records. */
export interface CheckOutcome {
  status: WitnessStatus;
  reason: string;
  headCid: string | null;
}

/** Anything that can resolve a DID to its graduated status. `witness.ts` provides the real one. */
export interface StatusChecker {
  check(did: string): Promise<CheckOutcome>;
  /** Called once at the start of a `refreshAll()` pass, before any `check()` — lets the checker
   * reset any per-cycle caching (e.g. the shared confirmed/tentative root reads). Optional so
   * mocks in tests don't need to implement it. */
  beginCycle?(): void;
  /** The two commitment roots as opaque, comparable strings (e.g. hex). Optional: a checker that
   * doesn't implement it just gets no root-change gate (every DID is re-checked every cycle, the
   * pre-existing behavior). */
  currentRoots?(): Promise<{ confirmedRoot: string; tentativeRoot: string }>;
}

export interface RefreshResult {
  diverged: number;
  /** DIDs actually re-checked against the anchor this cycle. */
  checked: number;
  /** Already-checked DIDs skipped because the roots proved nothing could have changed. */
  skipped: number;
}

const LAST_ROOTS_META_KEY = "refresh:last_roots";

export class RefreshService {
  readonly #store: RosterStore;
  readonly #checker: StatusChecker;

  constructor(store: RosterStore, checker: StatusChecker) {
    this.#store = store;
    this.#checker = checker;
  }

  /** Refresh one DID against the anchor; records the status, or an error if the check throws.
   * Any status other than `absent` means the anchor knows the DID, so we reflect it as
   * `anchored` (the observation path) — this is what makes a DID anchored *anywhere* (e.g. via
   * `ingest` directly) show its real §4 status once added to the roster. */
  async refresh(did: string): Promise<void> {
    try {
      const outcome = await this.#checker.check(did);
      this.#store.setStatus(did, outcome);
      if (outcome.status !== "absent") this.#store.markObservedAnchored(did);
    } catch (err) {
      this.#store.setError(did, err instanceof Error ? err.message : String(err));
    }
  }

  /** Refresh every active (non-removed) DID against the anchor — skipping already-checked DIDs
   * when the root-change gate proves nothing could have changed since last cycle. Returns the
   * `diverged` alarm count plus how many DIDs were actually checked vs. skipped, so the gate's
   * real hit rate is observable (worker status) rather than assumed. */
  async refreshAll(): Promise<RefreshResult> {
    this.#checker.beginCycle?.();

    const roots = await this.#checker.currentRoots?.();
    let unchanged = false;
    if (roots) {
      const key = `${roots.confirmedRoot}:${roots.tentativeRoot}`;
      unchanged = this.#store.getMeta(LAST_ROOTS_META_KEY) === key;
      this.#store.setMeta(LAST_ROOTS_META_KEY, key);
    }

    let checked = 0;
    let skipped = 0;
    for (const entry of this.#store.listActive()) {
      if (unchanged && entry.statusCheckedAt !== null) {
        skipped += 1;
        continue;
      }
      checked += 1;
      await this.refresh(entry.did);
    }
    return { diverged: this.#store.diverged().length, checked, skipped };
  }
}
