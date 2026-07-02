//! 72h recovery differential + boundary gate (REFERENCE.md §4, §5).
//!
//! Drives classify_next_op over scenarios ground-truthed against @did-plc/lib
//! assureValidNextOp (append, valid recovery, weaker-key reject, late reject), then pins the
//! exact window boundary with pure unit tests.

use drisl::cid::{CODEC_DAGCBOR, derive_cid_string};
use plc_core::recovery::{OpClass, RECOVERY_WINDOW_MS, classify_next_op};
use plc_core::state::{
    OpRecord, apply_op, confirmed_head, genesis_record, rebuild_chain, tentative_head,
};
use super::common::from_hex;
use super::recovery_vectors_generated::{recovery_scenario, recovery_vectors};

const HOUR_MS: u64 = 3600000;
const T: u64 = 1700000000000;

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

// ── End-to-end apply_op over a real forking chain (P3.3)
// ──────────────────────

#[test]
fn apply_op_recovery_scenario() {
    let s = recovery_scenario();
    let genesis = from_hex(@s.genesis_hex);
    let op_a = from_hex(@s.op_a_hex);
    let recovery_k0 = from_hex(@s.recovery_k0_hex);
    let recovery_k2 = from_hex(@s.recovery_k2_hex);

    // Import genesis (signed by index-0 key) → did + initial chain.
    let (did, g) = genesis_record(@genesis, T).expect('genesis');
    assert!(did == s.did.clone(), "did mismatch");
    let chain = array![g];

    // Append opA (signed by the index-1 key) at T.
    let outcome = apply_op(@chain, @op_a, T).expect('append opA');
    assert!(outcome.class == OpClass::Append, "opA should append");
    assert!(outcome.nullified_count == 0, "opA nullifies nothing");
    let chain = rebuild_chain(@chain, outcome); // [genesis, opA]
    assert!(chain.len() == 2, "chain should be [genesis, opA]");

    // Valid recovery within window: k0 (index 0) forks at genesis, nullifying opA.
    let within = T + HOUR_MS;
    let outcome = apply_op(@chain, @recovery_k0, within).expect('recovery k0');
    assert!(outcome.class == OpClass::Recovery, "k0 should recover");
    assert!(outcome.nullified_count == 1, "recovery nullifies opA");
    let recovered = rebuild_chain(@chain, outcome); // [genesis, recovery_k0]
    assert!(recovered.len() == 2, "chain replaced opA with recovery op");
    assert!(
        tentative_head(@recovered) == derive_cid_string(CODEC_DAGCBOR, @recovery_k0),
        "head is the recovery op",
    );

    // Weaker key (index 2) cannot nullify opA (signed by index 1).
    match apply_op(@chain, @recovery_k2, within) {
        Result::Ok(_) => assert!(false, "weaker key should not recover"),
        Result::Err(e) => assert!(e == 'recovery-weaker-key', "unexpected: {:?}", e),
    }

    // Late recovery: k0 but outside the 72h window of opA (created at T).
    let late = T + RECOVERY_WINDOW_MS + 1;
    match apply_op(@chain, @recovery_k0, late) {
        Result::Ok(_) => assert!(false, "late recovery should be rejected"),
        Result::Err(e) => assert!(e == 'late-recovery', "unexpected: {:?}", e),
    }
}

#[test]
fn apply_op_rejects_unknown_prev() {
    // A proposed op whose prev is in neither the chain → misordered.
    let s = recovery_scenario();
    let genesis = from_hex(@s.genesis_hex);
    let op_a = from_hex(@s.op_a_hex);
    let (_did, g) = genesis_record(@genesis, T).expect('genesis');
    // Chain holds only opA's predecessor-less view is wrong; build a chain WITHOUT genesis so
    // opA's prev (genesis cid) is absent.
    let bogus = OpRecord {
        cid: "bafyreibogus0000000000000000000000000000000000000000000000",
        rotation_keys: array![],
        created_at: T,
        signer_index: 0,
        tombstone: false,
        imported: false,
    };
    let _ = g;
    let chain = array![bogus];
    match apply_op(@chain, @op_a, T) {
        Result::Ok(_) => assert!(false, "accepted an op whose prev is not in the chain"),
        Result::Err(e) => assert!(e == 'prev-not-in-chain', "unexpected: {:?}", e),
    }
}

// ── Confirmed/tentative tiers (§4)
// ────────────────────────────────────────────

fn record(cid: ByteArray, created_at: u64) -> OpRecord {
    OpRecord {
        cid, rotation_keys: array![], created_at, signer_index: 0, tombstone: false,
        imported: false,
    }
}

#[test]
fn tiers_split_at_window() {
    // Ages at `now`: A = 101h (confirmed), B = 51h (tentative), C = 1h (tentative).
    let now = 101 * HOUR_MS;
    let chain = array![
        record("cidA", 0), record("cidB", 50 * HOUR_MS), record("cidC", 100 * HOUR_MS),
    ];
    assert!(confirmed_head(@chain, now) == "cidA", "confirmed head should be A");
    assert!(tentative_head(@chain) == "cidC", "tentative head should be C");
}

#[test]
fn tiers_all_tentative_when_fresh() {
    let chain = array![record("cidA", 0), record("cidB", HOUR_MS)];
    // now only 1h after the oldest: nothing past the window yet.
    assert!(confirmed_head(@chain, HOUR_MS) == "", "no confirmed ops yet");
    assert!(tentative_head(@chain) == "cidB", "tentative head is the tip");
}
