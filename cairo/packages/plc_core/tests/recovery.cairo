//! 72h recovery differential + boundary gate (REFERENCE.md §4, §5).
//!
//! Drives classify_next_op over scenarios ground-truthed against @did-plc/lib
//! assureValidNextOp (append, valid recovery, weaker-key reject, late reject), then pins the
//! exact window boundary with pure unit tests.

use plc_core::recovery::{OpClass, RECOVERY_WINDOW_MS, classify_next_op};
use super::recovery_vectors_generated::recovery_vectors;

fn class_str(c: OpClass) -> ByteArray {
    match c {
        OpClass::Append => "append",
        OpClass::Recovery => "recovery",
    }
}

#[test]
fn recovery_differential() {
    let vectors = recovery_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        let result = classify_next_op(
            *v.proposed_signer_index,
            *v.nullified_count,
            *v.first_nullified_signer_index,
            *v.created_at,
            *v.now,
        );
        match result {
            Result::Ok(class) => {
                assert!(*v.expect_ok, "vector {}: accepted but reference rejected", i);
                assert!(class_str(class) == v.expect_class.clone(), "vector {}: wrong op class", i);
            },
            Result::Err(_) => {
                assert!(!*v.expect_ok, "vector {}: rejected but reference accepted", i);
            },
        }
        i += 1;
    }
}

// ── Window boundary (pure; the constant is what must match 72 * HOUR) ──

#[test]
fn recovery_at_exact_window_is_accepted() {
    // elapsed == RECOVERY_WINDOW_MS: the reference rejects only when `> window`, so equal is
    // still inside.
    let now: u64 = 1700000000000;
    let created = now - RECOVERY_WINDOW_MS;
    let r = classify_next_op(0, 1, 1, created, now);
    assert!(r == Result::Ok(OpClass::Recovery), "exact-window recovery should be accepted");
}

#[test]
fn recovery_one_ms_late_is_rejected() {
    let now: u64 = 1700000000000;
    let created = now - RECOVERY_WINDOW_MS - 1;
    match classify_next_op(0, 1, 1, created, now) {
        Result::Ok(_) => assert!(false, "1ms-late recovery should be rejected"),
        Result::Err(e) => assert!(e == 'late-recovery', "wrong error: {:?}", e),
    }
}

#[test]
fn recovery_equal_priority_is_rejected() {
    // Same index is not strictly higher priority.
    match classify_next_op(1, 1, 1, 0, 0) {
        Result::Ok(_) => assert!(false, "equal-priority recovery should be rejected"),
        Result::Err(e) => assert!(e == 'recovery-weaker-key', "wrong error: {:?}", e),
    }
}

#[test]
fn append_ignores_priority_and_time() {
    // nullified_count == 0 is always an append regardless of the other fields.
    let r = classify_next_op(4, 0, 0, 0, 0);
    assert!(r == Result::Ok(OpClass::Append), "append should not depend on priority/time");
}
