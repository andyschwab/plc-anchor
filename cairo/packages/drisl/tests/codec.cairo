//! Structural codec tests beyond the (mostly flat) DASL vectors: nested maps/arrays, a CID
//! link inside a map, and recursive validation. These exercise the recursion and map-key
//! ordering the way real PLC operations (a map of fields, some of them CID links) will.

use drisl::drisl::{decode, encode};
use super::common::from_hex;

/// A canonical map shaped like an operation: keys ordered length-first then bytewise
/// (a, d, bb, ccc), mixing uint / CID link / array / nested map / null.
///   a4
///     "a"  : 1
///     "d"  : <Tag-42 CID, raw sha2-256>
///     "bb" : [1, 2]
///     "ccc": { "x": null }
#[test]
fn nested_roundtrip() {
    // Spaces sit only on byte boundaries (stripped before decoding) to keep tokens legible.
    let nested: ByteArray =
        "a4 616101 6164 d82a5825 00015512205891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03 626262 820102 63636363 a16178f6";
    let bytes = from_hex(@strip_ws(@nested));
    let value = match decode(@bytes) {
        Result::Ok(v) => v,
        Result::Err(e) => panic!("nested decode rejected: {}", e),
    };
    assert!(encode(@value) == bytes, "nested re-encoding is not canonical");
}

/// A well-formed outer array whose inner element is a non-minimal integer (0x1801 == uint 1
/// in two bytes). Recursion must reject it, not just top-level values.
#[test]
fn nested_non_minimal_is_rejected() {
    let bytes = from_hex(@"82011801"); // [1, <non-minimal 1>]
    assert!(decode(@bytes).is_err(), "nested non-minimal int must be rejected");
}

/// An inner map with mis-ordered keys ("b" before "a") inside a valid outer array. Map
/// validation must run at every depth.
#[test]
fn nested_bad_map_order_is_rejected() {
    let bytes = from_hex(@"81a2616201616100"); // [ {"b":1, "a":0} ]
    assert!(decode(@bytes).is_err(), "nested mis-ordered map must be rejected");
}

/// Remove ASCII spaces so long hex constants can be wrapped for readability.
fn strip_ws(s: @ByteArray) -> ByteArray {
    let mut out: ByteArray = "";
    let len = s.len();
    let mut i = 0;
    while i < len {
        let c = s.at(i).unwrap();
        if c != 0x20 {
            out.append_byte(c);
        }
        i += 1;
    }
    out
}
