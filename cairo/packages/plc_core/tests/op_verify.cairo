//! PLC op-verify differential gate (REFERENCE.md §3, §5).
//!
//! Drives verify_op_sig over the 6-op PLC corpus validated by @did-plc/lib.
//! Per vector:
//!   - extract_sig_and_unsigned_bytes produces the correct unsigned CBOR.
//!   - verify_op_sig accepts the signature with the correct signer did:key.
//!   - verify_op_sig rejects the signature with a wrong (flipped-bit) signer key.
//!
//! This is the Cairo half of the Phase 2 differential gate; the TS oracle
//! (conformance/src/check.mjs phase 3) is the reference.

use plc_core::op_verify::{extract_sig_and_unsigned_bytes, verify_op_sig};
use super::common::from_hex;
use super::op_verify_vectors_generated::{op_verify_reject_vectors, op_verify_vectors};

#[test]
fn op_verify_sig_acceptance() {
    let vectors = op_verify_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        let signed_bytes = from_hex(v.signed_drisl_hex);
        let result = verify_op_sig(@signed_bytes, v.signer_did_key);
        assert!(result.is_ok(), "vector {}: verify_op_sig failed: {:?}", i, result);
        i += 1;
    }
}

/// Signatures the reference rejects must be rejected here too. Currently: high-S k256
/// (low-S is required for k256, unlike p256 which is malleable — see sig_verify header).
#[test]
fn op_verify_rejects_reference_rejects() {
    let vectors = op_verify_reject_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        let signed_bytes = from_hex(v.signed_drisl_hex);
        let result = verify_op_sig(@signed_bytes, v.signer_did_key);
        assert!(result.is_err(), "reject vector {}: expected rejection but verify succeeded", i);
        i += 1;
    }
}

#[test]
fn op_verify_unsigned_bytes_match() {
    let vectors = op_verify_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        let signed_bytes = from_hex(v.signed_drisl_hex);
        let expected_unsigned = from_hex(v.unsigned_drisl_hex);

        let result: Result<(ByteArray, ByteArray), felt252> = extract_sig_and_unsigned_bytes(
            @signed_bytes,
        );
        let (_, unsigned_bytes) = result.expect('extract failed');
        assert!(unsigned_bytes == expected_unsigned, "vector {}: unsigned bytes mismatch", i);
        i += 1;
    }
}
