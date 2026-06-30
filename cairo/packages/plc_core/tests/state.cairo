//! Per-DID state transition gate (REFERENCE.md §3 component 3, §4).
//!
//! Drives import_genesis + apply_append over real reference ops: every genesis op imports to
//! its corpus did:plc; every non-genesis op appends onto its predecessor's head with the
//! reference signer index. Plus rejections: wrong prev, appending to a tombstone, importing
//! a non-genesis, appending a genesis.

use drisl::cid::{CODEC_DAGCBOR, derive_cid_string};
use plc_core::state::{DidHead, apply_append, import_genesis};
use super::common::from_hex;
use super::op_verify_vectors_generated::op_verify_vectors;

/// Build the head a non-genesis vector appends onto: its predecessor's CID is the vector's
/// `prev`, and the authorizing rotation keys are the vector's `allowed_keys` (= the prev
/// op's rotation keys, by construction in the generator).
fn head_for(v: @super::op_verify_vectors_generated::OpVerifyVector) -> DidHead {
    let mut authority: Array<ByteArray> = array![];
    let mut k = 0;
    while k < v.allowed_keys.len() {
        authority.append(v.allowed_keys.at(k).clone());
        k += 1;
    }
    DidHead { head_cid: v.prev.clone(), authority, tombstoned: false }
}

#[test]
fn import_genesis_derives_did() {
    let vectors = op_verify_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        if *v.is_genesis {
            let signed = from_hex(v.signed_drisl_hex);
            let (did, head) = match import_genesis(@signed) {
                Result::Ok(r) => r,
                Result::Err(e) => {
                    assert!(false, "vector {}: import_genesis failed: {:?}", i, e);
                    panic!()
                },
            };
            assert!(did == v.did.clone(), "vector {}: derived did != corpus did", i);
            assert!(!head.tombstoned, "vector {}: fresh genesis must not be tombstoned", i);
            assert!(
                head.head_cid == derive_cid_string(CODEC_DAGCBOR, @signed),
                "vector {}: head cid mismatch",
                i,
            );
        }
        i += 1;
    }
}

#[test]
fn apply_append_advances_head() {
    let vectors = op_verify_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        if !*v.is_genesis {
            let head = head_for(v);
            let proposed = from_hex(v.signed_drisl_hex);
            let (new_head, signer_index) = match apply_append(@head, @proposed, 0) {
                Result::Ok(r) => r,
                Result::Err(e) => {
                    assert!(false, "vector {}: apply_append failed: {:?}", i, e);
                    panic!()
                },
            };
            assert!(signer_index == *v.signer_index, "vector {}: wrong signer index", i);
            assert!(
                new_head.head_cid == derive_cid_string(CODEC_DAGCBOR, @proposed),
                "vector {}: new head cid mismatch",
                i,
            );
        }
        i += 1;
    }
}

#[test]
fn apply_append_rejects_wrong_prev() {
    // Take a non-genesis op but give it a head whose cid is not its prev.
    let vectors = op_verify_vectors();
    let mut idx = 0;
    let mut j = 0;
    while j < vectors.len() {
        if !*vectors.at(j).is_genesis {
            idx = j;
        }
        j += 1;
    }
    let v = vectors.at(idx);
    let mut head = head_for(v);
    head.head_cid = "bafyreiwrongwrongwrongwrongwrongwrongwrongwrongwrongwro"; // not its prev
    let proposed = from_hex(v.signed_drisl_hex);
    match apply_append(@head, @proposed, 0) {
        Result::Ok(_) => assert!(false, "accepted a wrong prev"),
        Result::Err(e) => assert!(e == 'prev-not-head', "unexpected error: {:?}", e),
    }
}

#[test]
fn apply_append_rejects_tombstoned_head() {
    let vectors = op_verify_vectors();
    let mut idx = 0;
    let mut j = 0;
    while j < vectors.len() {
        if !*vectors.at(j).is_genesis {
            idx = j;
        }
        j += 1;
    }
    let v = vectors.at(idx);
    let mut head = head_for(v);
    head.tombstoned = true;
    let proposed = from_hex(v.signed_drisl_hex);
    match apply_append(@head, @proposed, 0) {
        Result::Ok(_) => assert!(false, "accepted an op onto a tombstone"),
        Result::Err(e) => assert!(e == 'did-tombstoned', "unexpected error: {:?}", e),
    }
}

#[test]
fn import_genesis_rejects_non_genesis() {
    // A non-genesis op (has prev) must not import as a genesis.
    let vectors = op_verify_vectors();
    let mut idx = 0;
    let mut j = 0;
    while j < vectors.len() {
        if !*vectors.at(j).is_genesis {
            idx = j;
        }
        j += 1;
    }
    let signed = from_hex(vectors.at(idx).signed_drisl_hex);
    match import_genesis(@signed) {
        Result::Ok(_) => assert!(false, "imported a non-genesis op"),
        Result::Err(e) => assert!(e == 'not-genesis', "unexpected error: {:?}", e),
    }
}
