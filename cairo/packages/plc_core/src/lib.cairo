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
//!
//! Phase 3 — anchor endpoint (VERIFY-ON-READ, docs/ONCHAIN-REARCH-PLAN.md):
//!   anchor     — the permissionless **store-only** endpoint: `import`/`submit_op`/`chain`. It
//!                stores raw op bytes (block-time + provenance) and runs NO verification; the
//!                witness re-derives validity read-side (`witness-ts`). Uses only `drisl` for DID
//!                derivation.
//!   state / merkle / op_verify / recovery / sig_verify / key_parse / op_decode — retained as the
//!                differential-green PLC **reference** the read side mirrors; no longer on the
//!                contract's write path.
//!   governance — multisig + timelock + one-way freeze flag (§6b).

pub mod anchor;
pub mod key_parse;
pub mod link;
pub mod merkle;
pub mod op_decode;
pub mod op_verify;
pub mod recovery;
pub mod sig_verify;
pub mod state;
