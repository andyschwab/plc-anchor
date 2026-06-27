//! DASL CID: structural validation (for the DRISL decoder), canonical derivation
//! (sha2-256 over DRISL bytes), and the blessed-set policy (REFERENCE.md §5).
//!
//! Two layers, deliberately separate:
//!   - `is_valid_cid_bytes` accepts any *structurally* valid DASL CID — including BLAKE3
//!     ("Big DASL") — because that is what the DASL/dag-cbor conformance suite requires of
//!     a generic codec. It is called by `drisl::parse_value` when decoding a Tag-42 link.
//!   - `is_blessed_cid_bytes` is the PLC-anchor narrowing: sha2-256 only. Op verification
//!     applies this; the codec does not. Widening it is a governance decision (§5/§6).
//!
//! Verification runs in a Starknet contract, so hashing is the corelib `sha256` syscall —
//! a library call, never a hand-rolled hash.

use core::sha256::compute_sha256_byte_array;

/// Tag-42 link content: the multibase identity prefix (0x00) followed by a binary CID.
/// Layout we accept: 0x00 | 0x01 (CIDv1) | codec | multihash-code | 0x20 (32) | 32-byte digest.
const CID_CONTENT_LEN: usize = 37;
const MULTIBASE_IDENTITY: u8 = 0x00;
const CID_V1: u8 = 0x01;
pub const CODEC_DAGCBOR: u8 = 0x71;
pub const CODEC_RAW: u8 = 0x55;
const MH_SHA2_256: u8 = 0x12;
const MH_BLAKE3: u8 = 0x1e;
const DIGEST_LEN_32: u8 = 0x20;

/// Structural DASL-CID check over the Tag-42 byte-string content (with the leading 0x00).
/// Accepts sha2-256 and BLAKE3 (the DASL CID set); rejects CIDv0, wrong codecs, wrong hash
/// types, and any length mismatch. Used by the generic DRISL codec.
pub fn is_valid_cid_bytes(content: @ByteArray) -> bool {
    if content.len() != CID_CONTENT_LEN {
        return false;
    }
    if content.at(0).unwrap() != MULTIBASE_IDENTITY {
        return false;
    }
    if content.at(1).unwrap() != CID_V1 {
        return false;
    }
    let codec = content.at(2).unwrap();
    if codec != CODEC_DAGCBOR && codec != CODEC_RAW {
        return false;
    }
    let mh = content.at(3).unwrap();
    if mh != MH_SHA2_256 && mh != MH_BLAKE3 {
        return false;
    }
    content.at(4).unwrap() == DIGEST_LEN_32
}

/// PLC-anchor blessed set (REFERENCE.md §5): a structurally valid CID that is sha2-256.
/// BLAKE3 is rejected here even though the codec accepts it.
pub fn is_blessed_cid_bytes(content: @ByteArray) -> bool {
    is_valid_cid_bytes(content) && content.at(3).unwrap() == MH_SHA2_256
}

/// Derive the canonical binary CID (no multibase prefix) for `payload` under `codec`,
/// using sha2-256: 0x01 | codec | 0x12 | 0x20 | <32-byte digest>. This is the 36-byte form
/// we commit/compare; the Tag-42 CBOR form prepends the 0x00 identity byte.
pub fn derive_cid(codec: u8, payload: @ByteArray) -> ByteArray {
    let digest = compute_sha256_byte_array(payload);
    let mut cid: ByteArray = "";
    cid.append_byte(CID_V1);
    cid.append_byte(codec);
    cid.append_byte(MH_SHA2_256);
    cid.append_byte(DIGEST_LEN_32);
    append_digest(ref cid, digest);
    cid
}

/// Append the 8 big-endian u32 words of a sha-256 digest as 32 bytes.
fn append_digest(ref out: ByteArray, digest: [u32; 8]) {
    let words = digest.span();
    let mut i = 0;
    while i < 8 {
        let w = *words.at(i);
        out.append_byte(((w / 0x1000000) % 0x100).try_into().unwrap());
        out.append_byte(((w / 0x10000) % 0x100).try_into().unwrap());
        out.append_byte(((w / 0x100) % 0x100).try_into().unwrap());
        out.append_byte((w % 0x100).try_into().unwrap());
        i += 1;
    }
}
