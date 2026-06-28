//! did:key parsing for secp256k1 and secp256r1 compressed public keys.
//!
//! Decodes `did:key:z<base58btc>` strings to (curve type, x coordinate, y parity).
//! Supports exactly the two curves used in PLC ops (REFERENCE.md §5).

use core::dict::Felt252Dict;

/// The curve a parsed key lives on.
#[derive(Drop, PartialEq)]
pub enum KeyType {
    Secp256k1,
    Secp256r1,
}

/// A parsed, decoded public key from a did:key string.
#[derive(Drop)]
pub struct ParsedKey {
    pub key_type: KeyType,
    /// x coordinate of the compressed public key (big-endian u256).
    pub x: u256,
    /// True if y is odd (compressed-key parity byte == 0x03).
    pub y_parity: bool,
}

// Multicodec varint prefixes (2 bytes each):
//   secp256k1: 0xE7 → varint [0xE7, 0x01]
//   secp256r1 / P-256: 0x1200 → varint [0x80, 0x24]
const SECP256K1_B0: u8 = 0xe7;
const SECP256K1_B1: u8 = 0x01;
const SECP256R1_B0: u8 = 0x80;
const SECP256R1_B1: u8 = 0x24;

// Compressed-pubkey parity bytes.
const EVEN_Y: u8 = 0x02;
const ODD_Y: u8 = 0x03;

// Decoded byte length: 2 bytes varint + 33 bytes compressed pubkey.
const DECODED_LEN: usize = 35;

/// Parse a `did:key:z<base58btc>` string into a `ParsedKey`.
///
/// Accepts secp256k1 (`zQ3...`) and secp256r1 / P-256 (`zDna...`) keys.
/// Rejects everything else.
pub fn parse_did_key(s: @ByteArray) -> Result<ParsedKey, felt252> {
    // Strip the 8-byte "did:key:" prefix + 1-byte 'z' multibase prefix.
    if s.len() < 10 {
        return Result::Err('did-key-too-short');
    }
    if !starts_with_did_key(s) {
        return Result::Err('not-did-key');
    }
    if s.at(8).unwrap() != 'z' {
        return Result::Err('not-base58btc');
    }

    // Extract the base58btc portion (after the 'z').
    let b58_start = 9;
    let mut b58: ByteArray = "";
    let mut i = b58_start;
    while i < s.len() {
        b58.append_byte(s.at(i).unwrap());
        i += 1;
    }

    // Decode base58btc → 35 bytes.
    let decoded = decode_base58btc(@b58, DECODED_LEN)?;

    // Parse the 2-byte multicodec varint prefix.
    let mc0 = decoded.at(0).unwrap();
    let mc1 = decoded.at(1).unwrap();
    let key_type = if mc0 == SECP256K1_B0 && mc1 == SECP256K1_B1 {
        KeyType::Secp256k1
    } else if mc0 == SECP256R1_B0 && mc1 == SECP256R1_B1 {
        KeyType::Secp256r1
    } else {
        return Result::Err('unknown-key-curve');
    };

    // Parse the 33-byte compressed pubkey (bytes 2–34).
    let parity_byte = decoded.at(2).unwrap();
    if parity_byte != EVEN_Y && parity_byte != ODD_Y {
        return Result::Err('bad-pubkey-prefix');
    }
    let y_parity = parity_byte == ODD_Y;
    let x = read_u256_be(@decoded, 3);

    Result::Ok(ParsedKey { key_type, x, y_parity })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Decode a base58btc string into exactly `out_len` bytes (big-endian).
/// Uses the standard carry-propagation algorithm with a Felt252Dict accumulator.
fn decode_base58btc(s: @ByteArray, out_len: usize) -> Result<ByteArray, felt252> {
    let slen = s.len();
    let mut result: Felt252Dict<u8> = Default::default();

    let mut i: usize = 0;
    let mut err: felt252 = 0;
    while i < slen && err == 0 {
        let c = s.at(i).unwrap();
        let base_val: u32 = match b58_char_to_val(c) {
            Result::Ok(v) => v.into(),
            Result::Err(e) => {
                err = e;
                break;
            },
        };
        let mut carry: u32 = base_val;
        let mut j = out_len;
        while j > 0 {
            j -= 1;
            let cur: u32 = result.get(j.into()).into();
            carry += 58_u32 * cur;
            result.insert(j.into(), (carry % 256_u32).try_into().unwrap());
            carry /= 256_u32;
        }
        if carry != 0 {
            err = 'b58-overflow';
        }
        i += 1;
    }

    if err != 0 {
        return Result::Err(err);
    }

    let mut out: ByteArray = "";
    let mut k: usize = 0;
    while k < out_len {
        out.append_byte(result.get(k.into()));
        k += 1;
    }
    Result::Ok(out)
}

/// Map a base58btc character to its 0–57 value.
///
/// Alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
/// (excludes 0, I, O, l)
fn b58_char_to_val(c: u8) -> Result<u8, felt252> {
    if c >= 0x31 && c <= 0x39 {
        // '1'–'9' → 0–8
        Result::Ok(c - 0x31)
    } else if c >= 0x41 && c <= 0x5a {
        // 'A'–'Z', skipping 'I' (0x49) and 'O' (0x4f)
        if c == 0x49 || c == 0x4f {
            Result::Err('invalid-b58-char')
        } else if c < 0x49 {
            // 'A'–'H' → 9–16
            Result::Ok(c - 0x41 + 9)
        } else if c < 0x4f {
            // 'J'–'N' → 17–21 (skipping 'I')
            Result::Ok(c - 0x41 + 8)
        } else {
            // 'P'–'Z' → 22–32 (skipping 'I', 'O')
            Result::Ok(c - 0x41 + 7)
        }
    } else if c >= 0x61 && c <= 0x7a {
        // 'a'–'z', skipping 'l' (0x6c)
        if c == 0x6c {
            Result::Err('invalid-b58-char')
        } else if c < 0x6c {
            // 'a'–'k' → 33–43
            Result::Ok(c - 0x61 + 33)
        } else {
            // 'm'–'z' → 44–57 (skipping 'l')
            Result::Ok(c - 0x61 + 32)
        }
    } else {
        Result::Err('invalid-b58-char')
    }
}

/// Check that `s` starts with the literal "did:key:" (8 bytes).
fn starts_with_did_key(s: @ByteArray) -> bool {
    // "did:key:" as byte values
    let prefix: [u8; 8] = [0x64, 0x69, 0x64, 0x3a, 0x6b, 0x65, 0x79, 0x3a];
    let mut ok = true;
    let mut i: usize = 0;
    while i < 8 {
        if s.at(i).unwrap() != *prefix.span().at(i) {
            ok = false;
            break;
        }
        i += 1;
    }
    ok
}

/// Read 32 big-endian bytes starting at `offset` in `data` as a u256.
pub fn read_u256_be(data: @ByteArray, offset: usize) -> u256 {
    let high = read_u128_be(data, offset);
    let low = read_u128_be(data, offset + 16);
    u256 { high, low }
}

fn read_u128_be(data: @ByteArray, offset: usize) -> u128 {
    let mut acc: u128 = 0;
    let mut i: usize = 0;
    while i < 16 {
        acc = acc * 256_u128 + data.at(offset + i).unwrap().into();
        i += 1;
    }
    acc
}
