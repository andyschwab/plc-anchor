//! Integrated verify_next_op gate (REFERENCE.md §3 item 2).
//!
//! Ties decode + linkage + authorized-signer + recovery together on real reference ops: the
//! non-genesis corpus ops (update, tombstone) are clean appends, so verify_next_op must
//! accept them with class Append and the reference's signer index. Also: a wrong fork point
//! breaks linkage.

use plc_core::recovery::OpClass;
use plc_core::verify::verify_next_op;
use super::common::from_hex;
use super::op_verify_vectors_generated::op_verify_vectors;

#[test]
fn verify_next_op_append_path() {
    let vectors = op_verify_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        if !*v.is_genesis {
            let proposed = from_hex(v.signed_drisl_hex);
            let fork_point = from_hex(v.prev_signed_hex);
            let empty: ByteArray = "";

            let verdict = match verify_next_op(@proposed, @fork_point, 0, @empty, 0, 0) {
                Result::Ok(verdict) => verdict,
                Result::Err(e) => {
                    assert!(false, "vector {}: verify_next_op failed: {:?}", i, e);
                    panic!()
                },
            };
            assert!(verdict.signer_index == *v.signer_index, "vector {}: wrong signer index", i);
            assert!(verdict.class == OpClass::Append, "vector {}: expected Append", i);
        }
        i += 1;
    }
}

#[test]
fn verify_next_op_rejects_wrong_fork_point() {
    // Feed a non-genesis op a fork point that is not its predecessor → linkage breaks.
    let vectors = op_verify_vectors();
    let mut idx = 0;
    let mut j = 0;
    while j < vectors.len() {
        if !*vectors.at(j).is_genesis {
            idx = j;
        }
        j += 1;
    }
    let proposed = from_hex(vectors.at(idx).signed_drisl_hex);
    let wrong_fork = from_hex(vectors.at(0).signed_drisl_hex); // the genesis, not the prev
    let empty: ByteArray = "";
    match verify_next_op(@proposed, @wrong_fork, 0, @empty, 0, 0) {
        Result::Ok(_) => assert!(false, "accepted a wrong fork point"),
        Result::Err(e) => assert!(e == 'prev-cid-mismatch', "unexpected error: {:?}", e),
    }
}
