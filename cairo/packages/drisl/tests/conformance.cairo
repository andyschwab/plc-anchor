//! DASL / dCBOR42 conformance — the keystone acceptance gate (REFERENCE.md §3, §5).
//!
//! Drives the codec over every in-scope vector (generated from conformance/vectors by
//! `make gen-vectors`). The contract per case:
//!   - `roundtrip`  : decode succeeds AND encode(decode(x)) == x  (canonical form preserved).
//!   - `invalid_in` : decode rejects the bytes (non-canonical / out-of-subset).
//!   - `invalid_out`: decode also rejects — every forbidden-to-emit value (NaN, Inf,
//!                    undefined, datetime, bignum, integer map key) is unrepresentable in
//!                    `Value` and additionally refused on decode, so it can never be encoded.

use drisl::drisl::{decode, encode};
use super::common::from_hex;
use super::vectors_generated::vectors;

#[test]
fn dasl_conformance() {
    let cases = vectors();
    let mut i = 0;
    while i < cases.len() {
        let (expected, hex) = cases.at(i);
        let bytes = from_hex(hex);
        match decode(@bytes) {
            Result::Ok(value) => {
                assert!(*expected == 'roundtrip', "case {}: decoded a non-roundtrip vector", i);
                let reencoded = encode(@value);
                assert!(reencoded == bytes, "case {}: re-encoding is not canonical", i);
            },
            Result::Err(_) => {
                assert!(*expected != 'roundtrip', "case {}: rejected a valid roundtrip vector", i);
            },
        }
        i += 1;
    }
}
