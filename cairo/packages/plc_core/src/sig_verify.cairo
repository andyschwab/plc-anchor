//! ECDSA signature verification for PLC ops (REFERENCE.md §5).
//!
//! Verifies a low-S secp256k1 or secp256r1 signature over a sha-256 message hash.
//! The sig is base64url-nopad encoded (64 bytes = r‖s); decoding is also here.

use starknet::secp256k1::Secp256k1Point;
use starknet::secp256r1::Secp256r1Point;
use starknet::secp256_trait::{Secp256Trait, is_valid_signature};
use starknet::SyscallResultTrait;

use super::key_parse::{KeyType, ParsedKey, read_u256_be};

/// Verify an ECDSA signature produced by `key` over `msg_hash`.
///
/// `sig_b64` - base64url-nopad encoded signature (86 chars → 64 bytes → r‖s)
/// Returns Ok(()) on success, Err on any structural or cryptographic failure.
pub fn verify_ecdsa(
    msg_hash: u256, sig_b64: @ByteArray, key: @ParsedKey,
) -> Result<(), felt252> {
    let sig_bytes = decode_base64url(sig_b64)?;
    if sig_bytes.len() != 64 {
        return Result::Err('sig-wrong-length');
    }
    let r = read_u256_be(@sig_bytes, 0);
    let s = read_u256_be(@sig_bytes, 32);

    let valid = match key.key_type {
        KeyType::Secp256k1 => {
            let point =
                Secp256Trait::<Secp256k1Point>::secp256_ec_get_point_from_x_syscall(*key.x, *key.y_parity)
                .unwrap_syscall()
                .expect('invalid-pubkey-k256');
            is_valid_signature::<Secp256k1Point>(msg_hash, r, s, point)
        },
        KeyType::Secp256r1 => {
            let point =
                Secp256Trait::<Secp256r1Point>::secp256_ec_get_point_from_x_syscall(*key.x, *key.y_parity)
                .unwrap_syscall()
                .expect('invalid-pubkey-r256');
            is_valid_signature::<Secp256r1Point>(msg_hash, r, s, point)
        },
    };

    if valid {
        Result::Ok(())
    } else {
        Result::Err('invalid-sig')
    }
}

// ── Base64url decode ──────────────────────────────────────────────────────────

/// Decode a base64url-nopad string to raw bytes.
/// Valid lengths: 0 mod 4, 2 mod 4, or 3 mod 4 (1 mod 4 is invalid).
pub fn decode_base64url(s: @ByteArray) -> Result<ByteArray, felt252> {
    let len = s.len();
    if len % 4 == 1 {
        return Result::Err('bad-b64-len');
    }
    let mut out: ByteArray = "";
    let mut i: usize = 0;
    let mut err: felt252 = 0;

    // Full 4-char groups → 3 bytes each.
    while i + 4 <= len && err == 0 {
        let v0: u32 = match b64_char_to_val(s.at(i).unwrap()) {
            Result::Ok(v) => v.into(),
            Result::Err(e) => {
                err = e;
                break;
            },
        };
        let v1: u32 = match b64_char_to_val(s.at(i + 1).unwrap()) {
            Result::Ok(v) => v.into(),
            Result::Err(e) => {
                err = e;
                break;
            },
        };
        let v2: u32 = match b64_char_to_val(s.at(i + 2).unwrap()) {
            Result::Ok(v) => v.into(),
            Result::Err(e) => {
                err = e;
                break;
            },
        };
        let v3: u32 = match b64_char_to_val(s.at(i + 3).unwrap()) {
            Result::Ok(v) => v.into(),
            Result::Err(e) => {
                err = e;
                break;
            },
        };
        out.append_byte((v0 * 4 + v1 / 16).try_into().unwrap());
        out.append_byte(((v1 % 16) * 16 + v2 / 4).try_into().unwrap());
        out.append_byte(((v2 % 4) * 64 + v3).try_into().unwrap());
        i += 4;
    }

    if err != 0 {
        return Result::Err(err);
    }

    // Trailing 2 chars → 1 byte, or 3 chars → 2 bytes.
    let rem = len % 4;
    if rem == 2 {
        let v0: u32 = b64_char_to_val(s.at(i).unwrap())?.into();
        let v1: u32 = b64_char_to_val(s.at(i + 1).unwrap())?.into();
        out.append_byte((v0 * 4 + v1 / 16).try_into().unwrap());
    } else if rem == 3 {
        let v0: u32 = b64_char_to_val(s.at(i).unwrap())?.into();
        let v1: u32 = b64_char_to_val(s.at(i + 1).unwrap())?.into();
        let v2: u32 = b64_char_to_val(s.at(i + 2).unwrap())?.into();
        out.append_byte((v0 * 4 + v1 / 16).try_into().unwrap());
        out.append_byte(((v1 % 16) * 16 + v2 / 4).try_into().unwrap());
    }

    Result::Ok(out)
}

/// Map a base64url character to its 0–63 value.
///
/// Alphabet: A–Z (0–25), a–z (26–51), 0–9 (52–61), '-' (62), '_' (63).
fn b64_char_to_val(c: u8) -> Result<u8, felt252> {
    if c >= 0x41 && c <= 0x5a {
        // 'A'–'Z' → 0–25
        Result::Ok(c - 0x41)
    } else if c >= 0x61 && c <= 0x7a {
        // 'a'–'z' → 26–51  ('a'=97, 97−71=26)
        Result::Ok(c - 0x47)
    } else if c >= 0x30 && c <= 0x39 {
        // '0'–'9' → 52–61  ('0'=48, 48+4=52)
        Result::Ok(c + 0x04)
    } else if c == 0x2d {
        // '-' → 62
        Result::Ok(62)
    } else if c == 0x5f {
        // '_' → 63
        Result::Ok(63)
    } else {
        Result::Err('invalid-b64url-char')
    }
}
