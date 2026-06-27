//! PLC Anchor on-chain core (REFERENCE.md §3, components 2–3). STUB.
//!
//! Modules to build, in build order, after the DRISL keystone is conformance-green:
//!   - op_verify:  secp256k1/r1 sig (corelib syscall) over the DRISL-encoded unsigned op
//!                 + did:key parse + prev hash-linkage
//!   - recovery:   72h higher-priority-key nullification state machine (§4, §5)
//!   - state:      per-DID head + confirmed/tentative DID→document roots (§4)
//!   - anchor:     the permissionless endpoint — `import(did, chain)` verifies a DID's
//!                 history from genesis; `submit_op(op)` appends, authorized by the
//!                 owner's rotation key via native AA (§2)
//!   - governance: multisig + timelock + one-way freeze flag (§6)
//!
//! Each consensus-critical module is differential-tested against @did-plc/lib
//! (the authoritative TS reference) before merge — see CLAUDE.md guardrails.

/// Placeholder so the package compiles as part of the workspace.
pub fn version() -> felt252 {
    'plc_core-0.1.0'
}
