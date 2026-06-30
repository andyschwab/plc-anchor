//! Status refresher — pulls the §4 graduated status for each anchored DID and records it.
//!
//! Depends only on the `StatusChecker` interface, so it's testable with a mock (the real binding
//! to `@plc-anchor/witness` lives in `witness.ts`, isolated). The never-false-`diverged`
//! invariant lives in the witness library; here we only persist what it returns and surface
//! `diverged` as the alarm (`RosterStore.diverged()`).

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
}

export class RefreshService {
  readonly #store: RosterStore;
  readonly #checker: StatusChecker;

  constructor(store: RosterStore, checker: StatusChecker) {
    this.#store = store;
    this.#checker = checker;
  }

  /** Refresh one DID; records the status, or an error if the check throws. */
  async refresh(did: string): Promise<void> {
    try {
      const outcome = await this.#checker.check(did);
      this.#store.setStatus(did, outcome);
    } catch (err) {
      this.#store.setError(did, err instanceof Error ? err.message : String(err));
    }
  }

  /** Refresh every anchored DID. Returns the count of DIDs now reported `diverged`. */
  async refreshAll(): Promise<number> {
    const anchored = this.#store.list("anchored");
    for (const entry of anchored) {
      await this.refresh(entry.did);
    }
    return this.#store.diverged().length;
  }
}
