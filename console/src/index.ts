//! @plc-anchor/console — Layer-2 admin tool (build item 6).
//!
//! Public surface: the roster store + state machine, the PDS-host filter primitive, the status
//! refresher, and the HTTP API. Glue over `ingest` (writes) and `@plc-anchor/witness` (reads);
//! no consensus logic lives here (CLAUDE.md guardrail).

export { ALLOWED_TRANSITIONS, RosterStore, TransitionError } from "./roster.ts";
export type { Filter, RosterEntry, RosterState, WitnessStatus } from "./types.ts";
export {
  hostOf,
  opMatchesPdsHost,
  pdsHostFromDidDoc,
  pdsHostFromOp,
} from "./pdshost.ts";
export { type CheckOutcome, RefreshService, type StatusChecker } from "./refresh.ts";
export {
  type CommandRunner,
  Onboarder,
  type OnboardConfig,
  type RunResult,
  SpawnRunner,
} from "./onboard.ts";
export {
  DiscoverService,
  type ExportEntry,
  ExportClient,
  type ScanResult,
} from "./discover.ts";
export { createConsoleServer, type ServerConfig, type WorkerActions } from "./server.ts";
