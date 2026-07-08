//! @plc-anchor/witness — the read-side witness ("atproto identity DMARC").
//!
//! V1 public surface. Verify-on-read: the anchor contract stores raw op bytes, and the witness
//! re-derives the live/confirmed head from them (`deriveLiveChain` over the on-chain log, the
//! same validator it runs on the directory) before comparing the two in `check(did)`.

export {
  type AuditEntry,
  type DeriveLiveChainOptions,
  deriveLiveChain,
  deriveNullified,
  DirectoryClient,
  type DirectoryHead,
  directoryHead,
  type Fetcher,
  type LiveChain,
  parseAuditLog,
  RECOVERY_WINDOW_MS,
  type ReplayEntry,
} from "./directory.ts";
export {
  type AnchorOp,
  AnchorReader,
  type BlockNumberCall,
  decodeByteArray,
  decodeChain,
  encodeByteArray,
  encodeString,
  httpBlockNumber,
  httpCall,
  httpStoredEventProbe,
  type StarknetCall,
  type StoredEventProbe,
} from "./starknet.ts";
export { cidForBytes, cidForOp, decodeDagCbor, didForGenesisOp, encodeDagCbor } from "./dagcbor.ts";
export {
  type AnchorHeads,
  AnchorLogOverflowError,
  type AnchorView,
  check,
  type CheckOptions,
  type CheckResult,
  deriveAnchorHeads,
  deriveAnchorLive,
  type DirectorySource,
  headsFromLive,
  MAX_ANCHOR_LOG_BYTES,
  MAX_ANCHOR_OPS,
  type Status,
} from "./status.ts";
export { DerivationCache, type DerivationStats } from "./derivation-cache.ts";
export {
  type AnchorEventView,
  type ChainCache,
  type CycleStats,
  EventCachingAnchorView,
} from "./event-cache.ts";
