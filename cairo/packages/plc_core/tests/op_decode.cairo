//! PLC op-decode differential + constraint gate (REFERENCE.md §3 item 2, §5).
//!
//! Acceptance: decode every corpus op and assert the structural view (type, genesis flag,
//! prev string, own rotation keys, vm count) matches what @did-plc/lib / the canonical
//! JSON reports (carried in the generated vector table).
//! Rejection: hand-built malformed ops exercise each §5 constraint branch.

use plc_core::op_decode::{OpType, PlcOp, decode_op};
use super::common::from_hex;
use super::op_verify_vectors_generated::op_verify_vectors;

fn type_string(op_type: OpType) -> ByteArray {
    match op_type {
        OpType::PlcOperation => "plc_operation",
        OpType::Create => "create",
        OpType::Tombstone => "plc_tombstone",
    }
}

#[test]
fn op_decode_acceptance() {
    let vectors = op_verify_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        let signed = from_hex(v.signed_drisl_hex);

        let op: PlcOp = match decode_op(@signed) {
            Result::Ok(o) => o,
            Result::Err(e) => {
                assert!(false, "vector {}: decode_op failed: {:?}", i, e);
                panic!()
            },
        };
        let PlcOp { op_type, prev, rotation_keys, vm_count, sig: _ } = op;

        // type
        assert!(type_string(op_type) == v.op_type.clone(), "vector {}: op_type mismatch", i);

        // genesis ⇔ prev == null
        let is_genesis = prev.is_none();
        assert!(is_genesis == *v.is_genesis, "vector {}: genesis flag mismatch", i);
        if !is_genesis {
            assert!(prev.unwrap() == v.prev.clone(), "vector {}: prev string mismatch", i);
        }

        // own rotation keys
        assert!(
            rotation_keys.len() == v.rotation_keys.len(),
            "vector {}: rotation key count mismatch",
            i,
        );
        let mut j = 0;
        while j < rotation_keys.len() {
            assert!(
                rotation_keys.at(j).clone() == v.rotation_keys.at(j).clone(),
                "vector {}: rotation key {} mismatch",
                i,
                j,
            );
            j += 1;
        }

        // verificationMethods count
        assert!(vm_count == *v.vm_count, "vector {}: vm_count mismatch", i);

        i += 1;
    }
}

/// Assert that `decode_op` rejects `hex` with the expected short-string error.
fn assert_reject(hex: ByteArray, expected: felt252) {
    let bytes = from_hex(@hex);
    match decode_op(@bytes) {
        Result::Ok(_) => assert!(false, "expected reject ({:?}) but decode succeeded", expected),
        Result::Err(e) => assert!(e == expected, "wrong error: got {:?} want {:?}", e, expected),
    }
}

#[test]
fn op_decode_rejects_non_map() {
    // A bare integer (0) is canonical CBOR but not a map.
    assert_reject("00", 'op-not-map');
}

#[test]
fn op_decode_rejects_missing_sig() {
    // map(1){ "type": "plc_operation" } — no sig field.
    assert_reject("a16474797065" + "6d706c635f6f7065726174696f6e", 'missing-sig');
}

#[test]
fn op_decode_rejects_unknown_type() {
    // map(3){ "sig":"", "prev":null, "type":"bogus" }.  "bogus" = text5 (0x65) 626f677573.
    assert_reject(
        "a3" + "63736967" + "60" + "6470726576" + "f6" + "6474797065" + "65626f677573",
        'unknown-op-type',
    );
}

#[test]
fn op_decode_rejects_genesis_tombstone() {
    // map(3){ "sig":"", "prev":null, "type":"plc_tombstone" } — a tombstone may not be genesis.
    assert_reject(
        "a3"
            + "63736967"
            + "60"
            + "6470726576"
            + "f6"
            + "6474797065"
            + "6d706c635f746f6d6273746f6e65",
        'tombstone-is-genesis',
    );
}

#[test]
fn op_decode_rejects_op_without_rotationkeys() {
    // map(3){ "sig":"", "prev":null, "type":"plc_operation" } — genesis op with no keys.
    assert_reject(
        "a3"
            + "63736967"
            + "60"
            + "6470726576"
            + "f6"
            + "6474797065"
            + "6d706c635f6f7065726174696f6e",
        'missing-rotationkeys',
    );
}

#[test]
fn op_decode_rejects_oversize() {
    // 7501 bytes > MAX_OP_SIZE (7500): rejected before decoding.
    let mut big: ByteArray = "";
    let mut i: usize = 0;
    while i < 7501 {
        big.append_byte(0);
        i += 1;
    }
    match decode_op(@big) {
        Result::Ok(_) => assert!(false, "expected op-too-large"),
        Result::Err(e) => assert!(e == 'op-too-large', "wrong error: {:?}", e),
    }
}
