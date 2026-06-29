//! PLC prev-linkage differential gate (REFERENCE.md §3 item 2, §5).
//!
//! For each non-genesis corpus op, the Cairo-derived base32 CID string of its predecessor's
//! signed bytes must equal the `prev` field @did-plc/lib wrote into the op — validating both
//! `derive_cid_string` (cid_to_base32 over derive_cid) and the linkage check. A tampered
//! predecessor must break the link. Genesis ops have no predecessor.

use drisl::cid::{CODEC_DAGCBOR, derive_cid_string};
use plc_core::link::check_prev_link;
use plc_core::op_decode::decode_op;
use super::common::from_hex;
use super::op_verify_vectors_generated::op_verify_vectors;

#[test]
fn prev_linkage_acceptance() {
    let vectors = op_verify_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        if !*v.is_genesis {
            let prev_signed = from_hex(v.prev_signed_hex);

            // The derived CID string of the predecessor equals the op's prev field.
            let derived = derive_cid_string(CODEC_DAGCBOR, @prev_signed);
            assert!(derived == v.prev.clone(), "vector {}: derived prev CID != op.prev", i);

            // The link check accepts the real predecessor.
            let signed = from_hex(v.signed_drisl_hex);
            let op = decode_op(@signed).expect('decode failed');
            assert!(
                check_prev_link(@prev_signed, @op).is_ok(),
                "vector {}: link check rejected the true predecessor",
                i,
            );
        }
        i += 1;
    }
}

#[test]
fn prev_linkage_rejects_wrong_predecessor() {
    // Use the tombstone (last vector) whose predecessor is the update; feed it the WRONG
    // predecessor (the genesis, vector 0) and assert the link breaks.
    let vectors = op_verify_vectors();
    // Find a non-genesis op and a different op to stand in as a bad predecessor.
    let mut tomb_idx = 0;
    let mut j = 0;
    while j < vectors.len() {
        if !*vectors.at(j).is_genesis {
            tomb_idx = j;
        }
        j += 1;
    }
    let cur = vectors.at(tomb_idx);
    let signed = from_hex(cur.signed_drisl_hex);
    let op = decode_op(@signed).expect('decode failed');

    // Wrong predecessor: the genesis op (vector 0) is not this op's prev.
    let wrong_prev = from_hex(vectors.at(0).signed_drisl_hex);
    match check_prev_link(@wrong_prev, @op) {
        Result::Ok(_) => assert!(false, "link check accepted a wrong predecessor"),
        Result::Err(e) => assert!(e == 'prev-cid-mismatch', "unexpected error: {:?}", e),
    }
}

#[test]
fn prev_linkage_rejects_genesis() {
    // A genesis op has no predecessor to link.
    let vectors = op_verify_vectors();
    let genesis = vectors.at(0);
    assert!(*genesis.is_genesis, "vector 0 expected to be genesis");
    let signed = from_hex(genesis.signed_drisl_hex);
    let op = decode_op(@signed).expect('decode failed');
    let any_bytes = from_hex(genesis.signed_drisl_hex);
    match check_prev_link(@any_bytes, @op) {
        Result::Ok(_) => assert!(false, "link check accepted a genesis op"),
        Result::Err(e) => assert!(e == 'cur-is-genesis', "unexpected error: {:?}", e),
    }
}
