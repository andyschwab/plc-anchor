//! Shared types for the admin console.
//!
//! The roster is *the* product of this layer: membership is off-chain policy (REFERENCE.md §2),
//! so the contract has no roster getter and this store owns it. A DID moves through an explicit
//! state machine; the witness status (the §4 graduated status) is carried as a sub-field once a
//! DID is `anchored`, refreshed independently of the lifecycle state.

/** Lifecycle state of a DID in the roster.
 *
 * - `candidate`  — proposed (explicit add, or a filter match); no on-chain effect yet.
 * - `approved`   — an operator has cleared it to be anchored (the cost guardrail: dynamic
 *                  filters only ever *propose*, a human approves before any write).
 * - `onboarding` — handed to `ingest --did --submit`; awaiting on-chain acceptance.
 * - `anchored`   — present on-chain; its witness `status` is then refreshed periodically.
 * - `removed`    — withdrawn from the roster (kept as a tombstone; can be revived).
 */
export type RosterState = "candidate" | "approved" | "onboarding" | "anchored" | "removed";

/** The §4 graduated witness status, as returned by `@plc-anchor/witness`. */
export type WitnessStatus = "confirmed" | "tentative-consistent" | "diverged" | "absent";

/** A DID's row in the roster. */
export interface RosterEntry {
  did: string;
  state: RosterState;
  /** How it entered: `"explicit"` or `"filter:<id>"`. */
  source: string;
  /** Current PDS host, when known (populated by the PDS-host parser). */
  pdsHost: string | null;
  /** Last witness status (only meaningful while `state === "anchored"`). */
  status: WitnessStatus | null;
  /** Machine-readable reason tag from the witness check. */
  statusReason: string | null;
  /** Epoch ms of the last status refresh. */
  statusCheckedAt: number | null;
  /** Head CID last seen (directory head, or the anchor tip). */
  headCid: string | null;
  /** Last onboarding/refresh error, if any. */
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A dynamic roster-membership predicate. MVP ships one type: `pds_host`. */
export interface Filter {
  id: number;
  type: "pds_host";
  /** For `pds_host`: the host to match (e.g. `pds.example.eu`). */
  value: string;
  enabled: boolean;
  createdAt: number;
}
