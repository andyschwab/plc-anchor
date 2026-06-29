//! PLC Anchor on-chain core (REFERENCE.md §3, components 2–3).
//!
//! Build order (CLAUDE.md):
//!   op_verify  — secp256k1/r1 sig verification over the DRISL-encoded unsigned op
//!                + did:key parse + prev hash-linkage.  ← Phase 2 (current)
//!   recovery   — 72h higher-priority-key nullification state machine (§4, §5).
//!   state      — per-DID head + confirmed/tentative DID→document roots (§4).
//!   anchor     — the permissionless endpoint: `import`/`submit_op` (§2).
//!   governance — multisig + timelock + one-way freeze flag (§6b).

pub mod key_parse;
pub mod link;
pub mod op_decode;
pub mod op_verify;
pub mod sig_verify;
