//! PLC 72h recovery state machine (REFERENCE.md §4, §5).
//!
//! Pure decision logic mirroring `@did-plc/lib`'s `assureValidNextOp`. Given how a proposed
//! op relates to the existing per-DID history — does it extend the head, or fork at an
//! earlier op and nullify what came after — decide whether it is valid and what it
//! nullifies. Signature verification and signer-index resolution are P2.3
//! (`op_verify::verify_op_authorized`); CID linkage is P2.4 (`link`). This module is the
//! priority + time-window arithmetic on top of those, kept storage-free so it is
//! differential-testable in isolation.
//!
//! The rule (`assureValidNextOp`):
//!   - **Append** — `prev` is the current head; nothing is nullified. Any rotation key of
//!     the head op may sign (checked by the caller). Always the normal write path.
//!   - **Recovery** — `prev` points to an *earlier* op, so the ops after it are nullified.
//!     Valid iff the proposed op is signed by a key of *strictly higher priority* (lower
//!     index) than the key that signed the **first** nullified op — both indices taken
//!     within the fork-point op's `rotationKeys` — AND the first nullified op's `createdAt`
//!     is within 72h of now. Only the first nullified op gates the decision; the rest are
//!     swept along.
//!
//! `now` / `createdAt` are externally supplied (the directory-assigned timestamp PLC's
//! window depends on — the narrow residual trust of §1), never a block clock.

/// 72 hours in milliseconds (`72 * HOUR`, matching `@did-plc/lib`; PLC timestamps are ms).
pub const RECOVERY_WINDOW_MS: u64 = 259200000;

/// How a valid proposed op relates to the history.
#[derive(Drop, PartialEq)]
pub enum OpClass {
    /// Extends the current head; nullifies nothing.
    Append,
    /// Forks at an earlier op; the ops after the fork point are nullified.
    Recovery,
}

/// Classify a proposed op against the history (`assureValidNextOp`'s decision).
///
/// `proposed_signer_index` — index of the proposed op's signer within the fork-point op's
///   rotation keys (from `verify_op_authorized`).
/// `nullified_count` — number of existing ops after the fork point: 0 ⇒ plain append.
/// `first_nullified_signer_index` — signer index (same key set) of the first nullified op.
/// `first_nullified_created_at`, `now` — ms timestamps; only consulted for a fork.
///
/// Returns the op class, or a short-string rejection matching a reference rejection.
pub fn classify_next_op(
    proposed_signer_index: usize,
    nullified_count: usize,
    first_nullified_signer_index: usize,
    first_nullified_created_at: u64,
    now: u64,
) -> Result<OpClass, felt252> {
    if nullified_count == 0 {
        return Result::Ok(OpClass::Append);
    }

    // Recovery: the proposed op must out-rank (lower index than) the disputed signer.
    // Equivalent to the reference's `assureValidSig(rotationKeys[0..disputedIndex],
    // proposed)` — succeeds iff the proposed signer is one of the higher-priority keys.
    if proposed_signer_index >= first_nullified_signer_index {
        return Result::Err('recovery-weaker-key');
    }

    // ...and within 72h of the first nullified op's createdAt.
    if now < first_nullified_created_at {
        return Result::Err('recovery-future-op');
    }
    if now - first_nullified_created_at > RECOVERY_WINDOW_MS {
        return Result::Err('late-recovery');
    }

    Result::Ok(OpClass::Recovery)
}
