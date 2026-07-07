//! Status refresher — pulls the §4 graduated status for each anchored DID and records it.
//!
//! Depends only on the `StatusChecker` interface, so it's testable with a mock (the real binding
//! to `@plc-anchor/witness` lives in `witness.ts`, isolated). The never-false-`diverged`
//! invariant lives in the witness library; here we only persist what it returns and surface
//! `diverged` as the alarm (`RosterStore.diverged()`).
//!
//! ## RPC cost — the event-gated cache lives below this seam
//!
//! Every active DID is still `check()`ed every cycle: status can shift purely from the directory
//! changing (a new un-anchored op) or the 72h window rolling over, neither of which touches the
//! anchor — so skipping a DID here could miss a real divergence. The RPC saving instead lives in
//! the checker's `AnchorView`: `beginCycle()` probes whether *any* anchor op log changed since last
//! cycle and, if not, serves every DID's on-chain log from cache (`witness.ts` /
//! `EventCachingAnchorView`). So the per-DID `check()` still runs, but its anchor read costs nothing
//! when the chain is unchanged. `cycleStats()` reports how many logs were actually re-read.

import type { RosterStore } from "./roster.ts";
import type { WitnessStatus } from "./types.ts";

/** The witness check, reduced to what the store records. */
export interface CheckOutcome {
  status: WitnessStatus;
  reason: string;
  headCid: string | null;
}

/** Per-cycle cost accounting from the checker's caches. */
export interface RefreshCycleStats {
  /** On-chain op logs actually re-read from RPC this cycle (the network-cost metric). */
  refetched: number;
  /** Op chains actually re-validated — signature verification ran — this cycle (the CPU-cost
   * metric; the rest were served from the derivation memo). */
  verified: number;
}

/** Anything that can resolve a DID to its graduated status. `witness.ts` provides the real one. */
export interface StatusChecker {
  check(did: string): Promise<CheckOutcome>;
  /** Called once at the start of a `refreshAll()` pass, before any `check()` — lets the checker
   * prime its per-cycle cache (probe the anchor's events, decide what to refetch). Optional and may
   * be async; a mock that doesn't implement it just gets no gating. */
  beginCycle?(): void | Promise<void>;
  /** Per-cycle RPC stats, read after the pass. Optional (mocks may omit it). */
  cycleStats?(): RefreshCycleStats;
}

export interface RefreshResult {
  diverged: number;
  /** DIDs `check()`ed this cycle (every active DID). */
  checked: number;
  /** On-chain logs actually re-read from RPC (the rest were served from cache). */
  refetched: number;
  /** Op chains actually re-validated — crypto ran — (the rest were served from the derivation memo). */
  verified: number;
}

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

  /** Refresh every active (non-removed) DID against the anchor. Returns the `diverged` alarm count
   * plus how many DIDs were checked and how many on-chain logs were actually re-read (the rest came
   * from the event-gated cache), so the gate's real hit rate is observable rather than assumed. */
  async refreshAll(): Promise<RefreshResult> {
    await this.#checker.beginCycle?.();
    let checked = 0;
    for (const entry of this.#store.listActive()) {
      checked += 1;
      await this.refresh(entry.did);
    }
    const stats = this.#checker.cycleStats?.();
    const refetched = stats?.refetched ?? checked;
    const verified = stats?.verified ?? checked;
    return { diverged: this.#store.diverged().length, checked, refetched, verified };
  }
}
