//! @plc-anchor/witness — the read-side witness ("atproto identity DMARC").
//!
//! V1 public surface. P5.2 ships the pinned Merkle verification primitive; the data path
//! (directory + Starknet reads) and the graduated-status `check(did)` land in P5.3–P5.4.

export { emptyRoot, leafHash, nodeHash, verifyProof, type ProofStep } from "./merkle.ts";
