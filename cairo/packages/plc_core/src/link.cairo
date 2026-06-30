//! PLC op `prev` linkage (REFERENCE.md §3 item 2, §5).
//!
//! Per-DID linearization: every non-genesis op must name its predecessor by CID in `prev`.
//! PLC stores `prev` as the base32 multibase CID *string* (a CBOR text field, not a Tag-42
//! link), so the check derives the previous signed op's CID string and compares.
//!
//! This is the residual-trust "ordering" primitive (§1): given a candidate ordered chain it
//! is fully proven; choosing the order (the head a new op extends) is Phase 3's on-chain
//! state, not here.

use drisl::cid::{CODEC_DAGCBOR, derive_cid_string};
use super::op_decode::PlcOp;

/// Check that `cur`'s `prev` equals the CID of `prev_signed` (the predecessor's signed DRISL
/// bytes). Errors if `cur` is genesis (no predecessor to link) or the CIDs differ.
pub fn check_prev_link(prev_signed: @ByteArray, cur: @PlcOp) -> Result<(), felt252> {
    match cur.prev {
        Option::Some(prev_str) => {
            let expected = derive_cid_string(CODEC_DAGCBOR, prev_signed);
            if prev_str == @expected {
                Result::Ok(())
            } else {
                Result::Err('prev-cid-mismatch')
            }
        },
        Option::None => Result::Err('cur-is-genesis'),
    }
}
