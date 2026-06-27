//! PLC-op CID/DID acceptance gate (REFERENCE.md §3, §5).
//!
//! Drives the codec over the committed corpus of real-structure PLC operations
//! (generated from @did-plc/lib / @ipld/dag-cbor via `make gen-plc-vectors`).
//! Per vector:
//!   - Decode succeeds (valid canonical CBOR).
//!   - Encode(decode(bytes)) == bytes (round-trip: our encoder is canonical).
//!   - derive_cid(dag-cbor, bytes) == expected CIDv1 binary (sha2-256 agreement).
//!   - For genesis ops: derive_did_fragment(bytes) == expected 24-char fragment.
//!
//! This is the acceptance test that DASL conformance vectors alone cannot provide:
//! DRISL ≠ strict dCBOR42, so byte-identical agreement with the real PLC encoder
//! on real op shapes is required before §3.

use drisl::cid::{CODEC_DAGCBOR, derive_cid, derive_did_fragment};
use drisl::drisl::{decode, encode};
use super::common::from_hex;
use super::plc_vectors_generated::plc_vectors;

#[test]
fn plc_op_cid_did_acceptance() {
    let vectors = plc_vectors();
    let mut i = 0;
    while i < vectors.len() {
        let v = vectors.at(i);
        let bytes = from_hex(v.drisl_hex);

        // 1. Canonical decode must succeed.
        let value = decode(@bytes).expect('decode failed');

        // 2. Re-encode must be byte-identical (round-trip).
        let reencoded = encode(@value);
        assert!(reencoded == bytes, "vector {}: encode(decode(x)) != x", i);

        // 3. CID derivation must match the expected binary CIDv1.
        let expected_cid = from_hex(v.cid_hex);
        let derived_cid = derive_cid(CODEC_DAGCBOR, @bytes);
        assert!(derived_cid == expected_cid, "vector {}: CID mismatch", i);

        // 4. Genesis ops: DID fragment derivation must match.
        if *v.is_genesis {
            let expected_frag = v.did_fragment.clone();
            let derived_frag = derive_did_fragment(@bytes);
            assert!(derived_frag == expected_frag, "vector {}: DID fragment mismatch", i);
        }

        i += 1;
    }
}
