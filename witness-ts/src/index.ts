//! @plc-anchor/witness — the read-side witness ("atproto identity DMARC").
//!
//! V1 public surface. P5.2 ships the pinned Merkle verification primitive; P5.3 adds the data
//! path (directory audit log + Starknet anchor reads). The graduated-status `check(did)` lands
//! in P5.4.

export { emptyRoot, leafHash, nodeHash, verifyProof, type ProofStep } from "./merkle.ts";
export {
  type AuditEntry,
  DirectoryClient,
  type DirectoryHead,
  directoryHead,
  type Fetcher,
} from "./directory.ts";
export {
  AnchorReader,
  decodeByteArray,
  decodeProof,
  encodeByteArray,
  encodeString,
  httpCall,
  type StarknetCall,
} from "./starknet.ts";
export {
  type AnchorView,
  check,
  type CheckOptions,
  type CheckResult,
  type DirectorySource,
  type Status,
} from "./status.ts";
