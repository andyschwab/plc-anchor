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
  /** How it entered: `"explicit"`, `"pds:<host>"` (enumerate/tail match), or `"filter:<id>"`. */
  source: string;
  /** Current PDS host, when known (populated by the PDS-host parser / enrichment). */
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

  // --- Enrichment (PLC-derivable identity context; §MVP stage 4). All nullable. ---
  /** Primary handle (`alsoKnownAs[0]` minus `at://`). */
  handle: string | null;
  /** Rotation-key count from the latest audit op. */
  keyCount: number | null;
  /** Epoch ms of the DID's last PLC op (from the audit log). */
  lastOpAt: number | null;
  /** Whether the DID is tombstoned (last op is a `plc_tombstone`). */
  tombstoned: boolean | null;
  /** Epoch ms of the last successful enrichment (drives the throttled re-enrich cadence). */
  enrichedAt: number | null;

  // --- Anchoring provenance + cost (§MVP stage 5). ---
  /** Epoch ms the DID was first observed/marked anchored on-chain. */
  anchoredAt: number | null;
  /** The (tip) Starknet tx hash that anchored the DID. */
  anchorTx: string | null;
  /** Cumulative on-chain fee for anchoring this DID, as a raw decimal felt string (STRK wei). */
  anchorFee: string | null;

  /** Epoch ms the DID was first added to the roster (candidate). */
  discoveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Server-side query for the roster grid (all optional). */
export interface RosterQuery {
  state?: RosterState;
  status?: WitnessStatus;
  /** Substring over DID + handle. */
  q?: string;
  /** Substring over the PDS host. */
  pdsHost?: string;
  /** Sort key (a whitelisted column alias); defaults to most-recently-updated. */
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** Dashboard rollup over the whole roster. */
export interface Aggregates {
  total: number;
  byState: Record<string, number>;
  byStatus: Record<string, number>;
  /** Approved-but-not-yet-anchored count (the onboarder's queue). */
  backlog: number;
  anchored: number;
  diverged: number;
  /** Cumulative on-chain fee across anchored DIDs, raw decimal felt string (STRK wei). */
  feeTotal: string;
  /** Mean fee per anchored-with-fee DID, raw decimal felt string. */
  feeAverage: string;
  /** How many anchored DIDs carry a recorded fee (the average's denominator). */
  anchoredWithFee: number;
}

/** Deployment-wide settings, persisted in the store so they survive restarts. */
export interface Settings {
  /** Master gate for the on-chain spend (onboarding). Default off at boot. */
  active: boolean;
  /** Max on-chain imports per onboard tick (overrides the env default when set). */
  importBudget: number | null;
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
