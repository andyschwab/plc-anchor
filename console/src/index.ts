//! @plc-anchor/console — Layer-2 admin tool (build item 6).
//!
//! Public surface: the roster store + state machine, the PDS-host filter primitive, the status
//! refresher, and the HTTP API. Glue over `ingest` (writes) and `@plc-anchor/witness` (reads);
//! no consensus logic lives here (CLAUDE.md guardrail).

export { ALLOWED_TRANSITIONS, RosterStore, TransitionError } from "./roster.ts";
export type {
  Aggregates,
  Filter,
  RosterEntry,
  RosterQuery,
  RosterState,
  Settings,
  WitnessStatus,
} from "./types.ts";
export {
  hostOf,
  opMatchesPdsHost,
  pdsHostFromDidDoc,
  pdsHostFromOp,
} from "./pdshost.ts";
export { type Criterion, parseCriterion } from "./criterion.ts";
export { type CheckOutcome, RefreshService, type StatusChecker } from "./refresh.ts";
export {
  type AnchorLine,
  type CommandRunner,
  type FeeResolver,
  Onboarder,
  type OnboardConfig,
  type OnboardResult,
  parseAnchorLines,
  type RunResult,
  SpawnRunner,
} from "./onboard.ts";
export { feeToDecimal, starknetFeeResolver } from "./fees.ts";
export {
  type EnumerateResult,
  EnumerationService,
  type ExportEntry,
  ExportClient,
  TailService,
  type TailResult,
} from "./discover.ts";
export {
  type ListReposPage,
  PdsClient,
  type RepoEntry,
} from "./pds.ts";
export {
  type AuditEntry,
  type EnrichConfig,
  type EnrichResult,
  EnrichmentService,
  type Identity,
  identityFromLog,
  type IdentityResolver,
} from "./enrich.ts";
export { createConsoleServer, type ServerConfig, type WorkerActions } from "./server.ts";
export { type Authenticator, type Session, SharedSecretAuth } from "./auth.ts";
