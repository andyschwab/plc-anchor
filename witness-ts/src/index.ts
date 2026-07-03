//! @plc-anchor/witness — the read-side witness ("atproto identity DMARC").
//!
//! V1 public surface. Verify-on-read: the anchor contract stores raw op bytes, and the witness
//! re-derives the live/confirmed head from them (`deriveLiveChain` over the on-chain log, the
//! same validator it runs on the directory) before comparing the two in `check(did)`.

export {
  type AuditEntry,
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
  decodeByteArray,
  decodeChain,
  encodeByteArray,
  encodeString,
  httpCall,
  type StarknetCall,
} from "./starknet.ts";
export { cidForBytes, cidForOp, decodeDagCbor, didForGenesisOp, encodeDagCbor } from "./dagcbor.ts";
export {
  type AnchorHeads,
  type AnchorView,
  check,
  type CheckOptions,
  type CheckResult,
  deriveAnchorHeads,
  type DirectorySource,
  type Status,
} from "./status.ts";
