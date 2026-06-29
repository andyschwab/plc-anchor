//! CID derivation + blessed-set policy (REFERENCE.md §5). The conformance vectors carry no
//! preimages, so the sha2-256 derivation is pinned here against known digests, and the
//! blessed-set narrowing (sha2-256 only, BLAKE3 excluded) is checked against the structural
//! validator.

use drisl::cid::{
    CODEC_DAGCBOR, CODEC_RAW, derive_cid, derive_cid_string, is_blessed_cid_bytes,
    is_valid_cid_bytes,
};
use super::common::from_hex;

#[test]
fn derive_cid_empty() {
    // sha256("") = e3b0c442...b855 -> CIDv1 raw: 01 55 12 20 <digest>.
    let payload: ByteArray = "";
    let cid = derive_cid(CODEC_RAW, @payload);
    let expected = from_hex(
        @"01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert!(cid == expected, "derive_cid(raw, \"\") mismatch");
}

#[test]
fn derive_cid_abc() {
    // sha256("abc") = ba7816bf...015ad.
    let payload: ByteArray = "abc";
    let cid = derive_cid(CODEC_RAW, @payload);
    let expected = from_hex(
        @"01551220ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert!(cid == expected, "derive_cid(raw, \"abc\") mismatch");
}

#[test]
fn derive_cid_string_base32() {
    // Multibase base32 CID strings (the PLC `prev` text form), pinned against multiformats.
    let abc: ByteArray = "abc";
    assert!(
        derive_cid_string(
            CODEC_DAGCBOR, @abc,
        ) == "bafyreif2pall7dybz7vecqka3zo24irdwabwdi4wc55jznaq75q7eaavvu",
        "dag-cbor base32 CID string mismatch",
    );
    assert!(
        derive_cid_string(
            CODEC_RAW, @abc,
        ) == "bafkreif2pall7dybz7vecqka3zo24irdwabwdi4wc55jznaq75q7eaavvu",
        "raw base32 CID string mismatch",
    );
}

#[test]
fn blessed_excludes_blake3() {
    // The "Big DASL" Tag-42 content (BLAKE3): structurally valid, but not blessed.
    let blake3 = from_hex(
        @"0001551e208e4c7c1b99dbfd50e7a95185fead5ee1448fa904a2fdd778eaf5f2dbfd629a99",
    );
    assert!(is_valid_cid_bytes(@blake3), "BLAKE3 CID should be structurally valid");
    assert!(!is_blessed_cid_bytes(@blake3), "BLAKE3 CID must not be blessed");

    // A sha2-256 Tag-42 content is both valid and blessed.
    let sha256 = from_hex(
        @"00015512205891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
    assert!(is_blessed_cid_bytes(@sha256), "sha2-256 CID must be blessed");
}
