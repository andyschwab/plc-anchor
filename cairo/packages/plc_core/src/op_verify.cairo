//! PLC op signature verification (REFERENCE.md §3, §5).
//!
//! Verifies that the `sig` field of a signed PLC op is a valid ECDSA signature
//! over the DRISL encoding of the unsigned op (op-without-sig), made by the
//! claimed signer key.
//!
//! Key invariants (REFERENCE.md §5):
//!   - Signature verification is over the *unsigned* op (sig removed, re-encoded).
//!   - DID/CID derivation uses the *signed* op (sig included).
//!   - `sig` is always the first map key in canonical CBOR (len 3 < all other PLC keys).

use core::sha256::compute_sha256_byte_array;
use super::key_parse::parse_did_key;
use super::sig_verify::verify_ecdsa;

/// Verify the signature in a signed PLC op DRISL encoding.
///
/// `signed_bytes` - canonical DRISL/dag-cbor bytes of the fully signed op
/// `signer_key_str` - did:key string of the expected signer
///
/// Returns Ok(()) if the signature is valid, Err on any failure.
pub fn verify_op_sig(signed_bytes: @ByteArray, signer_key_str: @ByteArray) -> Result<(), felt252> {
    // 1. Extract the base64url sig string and the unsigned DRISL bytes.
    let (sig_b64, unsigned_bytes) = extract_sig_and_unsigned_bytes(signed_bytes)?;

    // 2. sha256(unsigned bytes) → message hash (big-endian u256).
    let digest = compute_sha256_byte_array(@unsigned_bytes);
    let msg_hash = digest_words_to_u256(digest);

    // 3. Parse the signer's did:key → curve + pubkey.
    let key = parse_did_key(signer_key_str)?;

    // 4. Verify the ECDSA signature.
    verify_ecdsa(msg_hash, @sig_b64, @key)
}

/// Extract the base64url sig string and produce unsigned CBOR bytes (map without `sig`).
///
/// In canonical PLC op CBOR, `sig` is ALWAYS the first map entry because its key
/// ("sig", 3 bytes) is strictly shorter than every other PLC key. This lets us
/// strip it with a byte-level operation rather than a full decode/re-encode.
pub fn extract_sig_and_unsigned_bytes(
    signed: @ByteArray,
) -> Result<(ByteArray, ByteArray), felt252> {
    let len = signed.len();
    if len == 0 {
        return Result::Err('empty-op');
    }

    // Parse the map header: byte 0 must be major 5 (map).
    let ib = cbor_byte(signed, 0)?;
    if ib / 32 != 5 {
        return Result::Err('op-not-map');
    }
    let ai = ib % 32;
    let (count, p1) = cbor_read_arg(signed, 1, ai)?;
    if count == 0 {
        return Result::Err('empty-map');
    }

    // Parse the first key: must be text "sig".
    let (first_key, p2) = cbor_read_text(signed, p1)?;
    if first_key != "sig" {
        return Result::Err('first-key-not-sig');
    }

    // Parse the first value: must be a text string (the base64url sig).
    let (sig_b64, p3) = cbor_read_text(signed, p2)?;

    // Build the unsigned bytes: new map header with count-1, then remaining bytes.
    let unsigned_count = count - 1;
    let mut out: ByteArray = "";
    cbor_write_tiny_map_head(ref out, unsigned_count);
    let mut i = p3;
    while i < len {
        out.append_byte(signed.at(i).unwrap());
        i += 1;
    }

    Result::Ok((sig_b64, out))
}

// ── Minimal CBOR helpers (only what op_verify needs) ──

fn cbor_byte(data: @ByteArray, pos: usize) -> Result<u8, felt252> {
    match data.at(pos) {
        Option::Some(b) => Result::Ok(b),
        Option::None => Result::Err('truncated'),
    }
}

/// Read a CBOR argument with strict minimal-length enforcement.
fn cbor_read_arg(data: @ByteArray, pos: usize, ai: u8) -> Result<(u64, usize), felt252> {
    if ai < 24 {
        return Result::Ok((ai.into(), pos));
    }
    if ai == 24 {
        let b = cbor_byte(data, pos)?;
        if b < 24 {
            return Result::Err('non-minimal');
        }
        return Result::Ok((b.into(), pos + 1));
    }
    if ai == 25 {
        let hi: u64 = cbor_byte(data, pos)?.into();
        let lo: u64 = cbor_byte(data, pos + 1)?.into();
        let v = hi * 256 + lo;
        if v < 0x100 {
            return Result::Err('non-minimal');
        }
        return Result::Ok((v, pos + 2));
    }
    Result::Err('bad-ai')
}

/// Read a CBOR text string at `pos`, returning (content, next_pos).
fn cbor_read_text(data: @ByteArray, pos: usize) -> Result<(ByteArray, usize), felt252> {
    let ib = cbor_byte(data, pos)?;
    if ib / 32 != 3 {
        return Result::Err('not-text');
    }
    let (n, p) = cbor_read_arg(data, pos + 1, ib % 32)?;
    let n_sz: usize = n.try_into().unwrap();
    let mut out: ByteArray = "";
    let mut i: usize = 0;
    let mut err: felt252 = 0;
    while i < n_sz && err == 0 {
        match data.at(p + i) {
            Option::Some(b) => out.append_byte(b),
            Option::None => { err = 'truncated'; },
        }
        i += 1;
    }
    if err != 0 {
        return Result::Err(err);
    }
    Result::Ok((out, p + n_sz))
}

/// Write a CBOR map header for a count < 24 (always sufficient for PLC ops, max 7 fields).
fn cbor_write_tiny_map_head(ref out: ByteArray, count: u64) {
    out.append_byte(0xa0_u8 + count.try_into().unwrap());
}

// ── Digest → u256 ──

/// Convert a [u32; 8] sha-256 digest (big-endian words) to a big-endian u256.
fn digest_words_to_u256(digest: [u32; 8]) -> u256 {
    let words = digest.span();
    let w0: u128 = (*words.at(0)).into();
    let w1: u128 = (*words.at(1)).into();
    let w2: u128 = (*words.at(2)).into();
    let w3: u128 = (*words.at(3)).into();
    let w4: u128 = (*words.at(4)).into();
    let w5: u128 = (*words.at(5)).into();
    let w6: u128 = (*words.at(6)).into();
    let w7: u128 = (*words.at(7)).into();
    let high = ((w0 * 0x100000000_u128 + w1) * 0x100000000_u128 + w2) * 0x100000000_u128 + w3;
    let low = ((w4 * 0x100000000_u128 + w5) * 0x100000000_u128 + w6) * 0x100000000_u128 + w7;
    u256 { high, low }
}
