//! Integrated next-op verification (REFERENCE.md §3 item 2) — the seam Phase 3 consumes.
//!
//! Composes the Phase 2 primitives into one decision for a *non-genesis* op (the
//! `submit_op` append/recovery path): structural decode (P2.1), `prev` linkage (P2.4),
//! authorized-signer resolution against the fork-point op's rotation keys (P2.3), and the
//! 72h recovery classification (P2.5). Genesis import is a separate path (verify against the
//! op's own rotation keys + DID derivation) and is not handled here.
//!
//! Storage-free: the caller (Phase 3 state) resolves the fork-point op at `prev`, how many
//! ops follow it (`nullified_count`), and — for a fork — the first such op and its
//! `createdAt`; `now` is the externally-supplied timestamp (§1).

use super::link::check_prev_link;
use super::op_decode::decode_op;
use super::op_verify::verify_op_authorized;
use super::recovery::{OpClass, classify_next_op};

/// The verdict for a verified next op: which rotation key (by priority index) signed it, and
/// whether it extends the head or recovers (forks).
#[derive(Drop)]
pub struct OpVerdict {
    pub signer_index: usize,
    pub class: OpClass,
}

/// Verify a proposed non-genesis op against its predecessor.
///
/// `proposed_signed`  — the new op's signed DRISL bytes.
/// `fork_point_signed`— the op named by `proposed.prev` (authority + linkage target).
/// `nullified_count`  — existing ops after the fork point: 0 ⇒ plain append.
/// `first_nullified_signed`, `first_nullified_created_at` — the first nullified op and its
///   timestamp; consulted only when `nullified_count > 0`.
/// `now` — external current time (ms).
pub fn verify_next_op(
    proposed_signed: @ByteArray,
    fork_point_signed: @ByteArray,
    nullified_count: usize,
    first_nullified_signed: @ByteArray,
    first_nullified_created_at: u64,
    now: u64,
) -> Result<OpVerdict, felt252> {
    // Structural decode + prev linkage against the fork point.
    let proposed = decode_op(proposed_signed)?;
    check_prev_link(fork_point_signed, @proposed)?;

    // Authority = the fork-point op's rotation keys.
    let fork_point = decode_op(fork_point_signed)?;
    let proposed_idx = verify_op_authorized(proposed_signed, @fork_point.rotation_keys)?;

    if nullified_count == 0 {
        return Result::Ok(OpVerdict { signer_index: proposed_idx, class: OpClass::Append });
    }

    // Fork: resolve the disputed signer (first nullified op) in the same authority, then
    // apply the priority + 72h window rule.
    let disputed_idx = verify_op_authorized(first_nullified_signed, @fork_point.rotation_keys)?;
    let class = classify_next_op(
        proposed_idx, nullified_count, disputed_idx, first_nullified_created_at, now,
    )?;
    Result::Ok(OpVerdict { signer_index: proposed_idx, class })
}
