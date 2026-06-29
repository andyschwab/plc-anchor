//! PLC Anchor on-chain core (REFERENCE.md §3, components 2–3).
//!
//! Phase 2 — PLC op verification + recovery (done; differential vs @did-plc/lib):
//!   key_parse — did:key → curve + pubkey.
//!   sig_verify — secp256k1/r1 ECDSA over the DRISL-encoded unsigned op (k256 low-S;
//!                p256 malleable, matching the reference).
//!   op_decode — DRISL → typed PlcOp + §5 constraints; legacy `create` normalization.
//!   op_verify — unsigned-op extraction + authorized-signer resolution (returns signer
//!               index within a rotation-key set).
//!   link      — `prev` linkage via the predecessor's base32 CID string.
//!   recovery  — 72h higher-priority-key nullification decision (§4, §5).
//!   verify    — the integrated non-genesis `verify_next_op` seam (the four above).
//!
//! Phase 3 (next) — state commitment + anchor endpoint:
//!   state      — per-DID head + confirmed/tentative DID→document roots (§4).
//!   anchor     — the permissionless endpoint: `import`/`submit_op` (§2).
//!   governance — multisig + timelock + one-way freeze flag (§6b).

pub mod key_parse;
pub mod link;
pub mod op_decode;
pub mod op_verify;
pub mod recovery;
pub mod sig_verify;
pub mod verify;
