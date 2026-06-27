//! DRISL / dag-cbor (dCBOR42) canonical codec (REFERENCE.md §5).
//!
//! There is exactly one valid encoding for any value, and the decoder rejects everything
//! outside that blessed, deterministic subset. The two halves are mutually checking:
//! `decode` accepts only canonical bytes; `encode` is total over the (closed) `Value` type
//! and emits canonical bytes — so `encode(decode(x)) == x` for every accepted `x`.
//!
//! Blessed subset (dag-cbor): minimal-length integer/length encoding only; 64-bit floats
//! only and no NaN/Inf; definite lengths only; map keys are text strings, unique, ordered
//! by (length, then bytewise); the only tag is 42 (CID link); the only "simple" values are
//! true / false / null. Bignums, datetimes, undefined, and every other tag are rejected.
//!
//! `invalid_out` conformance cases (NaN, Inf, undefined, datetime, bignum, integer map
//! keys) are unrepresentable in `Value` *by construction* — there is no constructor for
//! them — and are additionally rejected on decode, so the encoder can never emit one.

use super::cid::is_valid_cid_bytes;

/// The blessed dag-cbor value domain. Closed by design: no variant can hold a NaN/Inf
/// float, an `undefined`, a non-text map key, or a non-42 tag.
#[derive(Drop)]
pub enum Value {
    /// (is_negative, argument). Mirrors CBOR major types 0/1: a positive integer is
    /// `(false, n)`; a negative integer with value `-1 - n` is `(true, n)`. `n` spans the
    /// full 64-bit CBOR argument range, so 2^64-1 and -(2^64) are exact.
    Int: (bool, u64),
    Bytes: ByteArray,
    Text: ByteArray,
    Bool: bool,
    Null,
    /// Raw IEEE-754 float64 bits (never a NaN/Inf encoding).
    Float: u64,
    /// Tag-42 CID link: the byte-string content including the leading 0x00 identity prefix.
    Cid: ByteArray,
    Array: Array<Value>,
    Map: Array<(ByteArray, Value)>,
}

// ---- Decode ------------------------------------------------------------------------------

/// Decode one canonical dag-cbor value from `data`, requiring that it consumes the entire
/// input (no trailing bytes / CBOR sequences). Returns a short-string error on any
/// non-canonical or out-of-subset input.
pub fn decode(data: @ByteArray) -> Result<Value, felt252> {
    let (value, pos) = parse_value(data, 0)?;
    if pos != data.len() {
        return Result::Err('trailing-bytes');
    }
    Result::Ok(value)
}

fn parse_value(data: @ByteArray, pos: usize) -> Result<(Value, usize), felt252> {
    let ib = byte(data, pos)?;
    let major = ib / 32;
    let ai = ib % 32;
    let p0 = pos + 1;

    if major == 0 {
        let (arg, p) = read_arg(data, p0, ai)?;
        return Result::Ok((Value::Int((false, arg)), p));
    }
    if major == 1 {
        let (arg, p) = read_arg(data, p0, ai)?;
        return Result::Ok((Value::Int((true, arg)), p));
    }
    if major == 2 {
        let (n, p) = read_arg(data, p0, ai)?;
        let (bytes, p2) = read_bytes(data, p, n)?;
        return Result::Ok((Value::Bytes(bytes), p2));
    }
    if major == 3 {
        let (n, p) = read_arg(data, p0, ai)?;
        let (s, p2) = read_bytes(data, p, n)?;
        if !is_valid_utf8(@s) {
            return Result::Err('invalid-utf8');
        }
        return Result::Ok((Value::Text(s), p2));
    }
    if major == 4 {
        let (count, p) = read_arg(data, p0, ai)?;
        let mut items: Array<Value> = array![];
        let mut cur = p;
        let mut i: u64 = 0;
        let mut err: felt252 = 0;
        while i < count {
            match parse_value(data, cur) {
                Result::Ok((v, np)) => {
                    items.append(v);
                    cur = np;
                },
                Result::Err(e) => {
                    err = e;
                    break;
                },
            }
            i += 1;
        }
        if err != 0 {
            return Result::Err(err);
        }
        return Result::Ok((Value::Array(items), cur));
    }
    if major == 5 {
        let (count, p) = read_arg(data, p0, ai)?;
        let mut entries: Array<(ByteArray, Value)> = array![];
        let mut cur = p;
        let mut i: u64 = 0;
        let mut prev_key: ByteArray = "";
        let mut err: felt252 = 0;
        while i < count {
            // Key.
            let key = match parse_value(data, cur) {
                Result::Ok((
                    kv, np,
                )) => {
                    cur = np;
                    match kv {
                        Value::Text(s) => s,
                        _ => {
                            err = 'map-key-not-text';
                            ""
                        },
                    }
                },
                Result::Err(e) => {
                    err = e;
                    ""
                },
            };
            if err != 0 {
                break;
            }
            if i != 0 && !key_gt(@key, @prev_key) {
                err = 'map-key-order';
                break;
            }
            // Value.
            match parse_value(data, cur) {
                Result::Ok((
                    val, np,
                )) => {
                    cur = np;
                    prev_key = key.clone();
                    entries.append((key, val));
                },
                Result::Err(e) => {
                    err = e;
                    break;
                },
            }
            i += 1;
        }
        if err != 0 {
            return Result::Err(err);
        }
        return Result::Ok((Value::Map(entries), cur));
    }
    if major == 6 {
        let (tag, p) = read_arg(data, p0, ai)?;
        if tag != 42 {
            return Result::Err('tag-not-42');
        }
        let inner = byte(data, p)?;
        if inner / 32 != 2 {
            return Result::Err('cid-not-bytes');
        }
        let (n, pp) = read_arg(data, p + 1, inner % 32)?;
        let (content, p2) = read_bytes(data, pp, n)?;
        if !is_valid_cid_bytes(@content) {
            return Result::Err('invalid-cid');
        }
        return Result::Ok((Value::Cid(content), p2));
    }

    // major == 7: simple values and floats.
    if ai == 20 {
        return Result::Ok((Value::Bool(false), p0));
    }
    if ai == 21 {
        return Result::Ok((Value::Bool(true), p0));
    }
    if ai == 22 {
        return Result::Ok((Value::Null, p0));
    }
    if ai == 27 {
        let (bits, p) = read_be(data, p0, 8)?;
        let bits64: u64 = bits.try_into().unwrap();
        // Reject NaN / +-Inf: float64 exponent field (11 bits) all ones.
        let exponent = (bits64 / 0x10000000000000) % 0x800;
        if exponent == 0x7ff {
            return Result::Err('float-nan-or-inf');
        }
        return Result::Ok((Value::Float(bits64), p));
    }
    // ai 23 (undefined), 24 (one-byte simple), 25/26 (float16/32), 0..19 (simple), 28..31.
    Result::Err('bad-simple-or-float')
}

/// Read a major-type argument with strict minimal-length enforcement. `ai` is the low 5
/// bits of the initial byte; rejects non-minimal encodings, reserved 28..30, and the
/// indefinite-length marker 31.
fn read_arg(data: @ByteArray, pos: usize, ai: u8) -> Result<(u64, usize), felt252> {
    if ai < 24 {
        return Result::Ok((ai.into(), pos));
    }
    if ai == 24 {
        let b = byte(data, pos)?;
        if b < 24 {
            return Result::Err('non-minimal');
        }
        return Result::Ok((b.into(), pos + 1));
    }
    if ai == 25 {
        let (v, p) = read_be(data, pos, 2)?;
        if v < 0x100 {
            return Result::Err('non-minimal');
        }
        return Result::Ok((v.try_into().unwrap(), p));
    }
    if ai == 26 {
        let (v, p) = read_be(data, pos, 4)?;
        if v < 0x10000 {
            return Result::Err('non-minimal');
        }
        return Result::Ok((v.try_into().unwrap(), p));
    }
    if ai == 27 {
        let (v, p) = read_be(data, pos, 8)?;
        if v < 0x100000000 {
            return Result::Err('non-minimal');
        }
        return Result::Ok((v.try_into().unwrap(), p));
    }
    Result::Err('bad-additional-info')
}

/// Read `n` big-endian bytes into a u128 (n <= 8 for our subset). Bounds-checked.
fn read_be(data: @ByteArray, pos: usize, n: usize) -> Result<(u128, usize), felt252> {
    let mut acc: u128 = 0;
    let mut p = pos;
    let mut i = 0;
    let mut err: felt252 = 0;
    while i < n {
        match data.at(p) {
            Option::Some(b) => { acc = acc * 256 + b.into(); },
            Option::None => {
                err = 'truncated';
                break;
            },
        }
        p += 1;
        i += 1;
    }
    if err != 0 {
        return Result::Err(err);
    }
    Result::Ok((acc, p))
}

fn read_bytes(data: @ByteArray, pos: usize, n: u64) -> Result<(ByteArray, usize), felt252> {
    let mut out: ByteArray = "";
    let mut p = pos;
    let mut i: u64 = 0;
    let mut err: felt252 = 0;
    while i < n {
        match data.at(p) {
            Option::Some(b) => { out.append_byte(b); },
            Option::None => {
                err = 'truncated';
                break;
            },
        }
        p += 1;
        i += 1;
    }
    if err != 0 {
        return Result::Err(err);
    }
    Result::Ok((out, p))
}

fn byte(data: @ByteArray, pos: usize) -> Result<u8, felt252> {
    match data.at(pos) {
        Option::Some(b) => Result::Ok(b),
        Option::None => Result::Err('truncated'),
    }
}

/// Strict map-key ordering: `a > b` by length first, then bytewise. Equality returns false,
/// so the decoder rejects duplicate keys as well as misordered ones.
fn key_gt(a: @ByteArray, b: @ByteArray) -> bool {
    if a.len() != b.len() {
        return a.len() > b.len();
    }
    let len = a.len();
    let mut i = 0;
    let mut result = false; // equal -> false
    while i < len {
        let ai = a.at(i).unwrap();
        let bi = b.at(i).unwrap();
        if ai != bi {
            result = ai > bi;
            break;
        }
        i += 1;
    }
    result
}

/// Reject any text string that is not well-formed UTF-8 (RFC 3629). dag-cbor does NOT
/// normalize (that is a dCBOR-only rule), so bytes are otherwise preserved verbatim.
fn is_valid_utf8(s: @ByteArray) -> bool {
    let len = s.len();
    let mut i = 0;
    let mut ok = true;
    while i < len {
        let b0 = s.at(i).unwrap();
        if b0 < 0x80 {
            i += 1;
        } else if b0 < 0xc2 {
            // 0x80..0xBF stray continuation; 0xC0/0xC1 overlong two-byte leads.
            ok = false;
            break;
        } else if b0 < 0xe0 {
            if !cont(s, i + 1, len) {
                ok = false;
                break;
            }
            i += 2;
        } else if b0 < 0xf0 {
            // Three-byte; constrain the second byte to exclude overlongs and surrogates.
            let lo = if b0 == 0xe0 {
                0xa0
            } else if b0 == 0xed {
                0x80
            } else {
                0x80
            };
            let hi = if b0 == 0xed {
                0x9f
            } else {
                0xbf
            };
            if !in_range(s, i + 1, len, lo, hi) || !cont(s, i + 2, len) {
                ok = false;
                break;
            }
            i += 3;
        } else if b0 < 0xf5 {
            // Four-byte; constrain the second byte to the valid U+10000..U+10FFFF window.
            let lo = if b0 == 0xf0 {
                0x90
            } else {
                0x80
            };
            let hi = if b0 == 0xf4 {
                0x8f
            } else {
                0xbf
            };
            if !in_range(s, i + 1, len, lo, hi) || !cont(s, i + 2, len) || !cont(s, i + 3, len) {
                ok = false;
                break;
            }
            i += 4;
        } else {
            ok = false;
            break;
        }
    }
    ok
}

/// `s[idx]` exists and is a UTF-8 continuation byte (0x80..0xBF).
fn cont(s: @ByteArray, idx: usize, len: usize) -> bool {
    in_range(s, idx, len, 0x80, 0xbf)
}

/// `s[idx]` exists and lies in `lo..=hi`.
fn in_range(s: @ByteArray, idx: usize, len: usize, lo: u8, hi: u8) -> bool {
    if idx >= len {
        return false;
    }
    let b = s.at(idx).unwrap();
    lo <= b && b <= hi
}

// ---- Encode ------------------------------------------------------------------------------

/// Canonically encode a `Value` to dag-cbor bytes.
pub fn encode(value: @Value) -> ByteArray {
    let mut out: ByteArray = "";
    encode_into(ref out, value);
    out
}

fn encode_into(ref out: ByteArray, value: @Value) {
    match value {
        Value::Int((
            neg, arg,
        )) => {
            let major = if *neg {
                1_u8
            } else {
                0_u8
            };
            encode_head(ref out, major, *arg);
        },
        Value::Bytes(b) => {
            encode_head(ref out, 2, (*b).len().into());
            out.append(b);
        },
        Value::Text(s) => {
            encode_head(ref out, 3, (*s).len().into());
            out.append(s);
        },
        Value::Bool(x) => { out.append_byte(if *x {
            0xf5
        } else {
            0xf4
        }); },
        Value::Null => { out.append_byte(0xf6); },
        Value::Float(bits) => {
            out.append_byte(0xfb);
            append_be(ref out, *bits, 8);
        },
        Value::Cid(content) => {
            out.append_byte(0xd8);
            out.append_byte(0x2a);
            encode_head(ref out, 2, (*content).len().into());
            out.append(content);
        },
        Value::Array(items) => {
            encode_head(ref out, 4, (*items).len().into());
            let mut i = 0;
            while i < items.len() {
                encode_into(ref out, items.at(i));
                i += 1;
            }
        },
        Value::Map(entries) => {
            encode_head(ref out, 5, (*entries).len().into());
            let mut i = 0;
            while i < entries.len() {
                let (k, v) = entries.at(i);
                encode_head(ref out, 3, k.len().into());
                out.append(k);
                encode_into(ref out, v);
                i += 1;
            }
        },
    }
}

/// Emit a major-type head with the minimal-length argument encoding.
fn encode_head(ref out: ByteArray, major: u8, arg: u64) {
    let mt = major * 32;
    if arg < 24 {
        out.append_byte(mt + arg.try_into().unwrap());
    } else if arg < 0x100 {
        out.append_byte(mt + 24);
        append_be(ref out, arg, 1);
    } else if arg < 0x10000 {
        out.append_byte(mt + 25);
        append_be(ref out, arg, 2);
    } else if arg < 0x100000000 {
        out.append_byte(mt + 26);
        append_be(ref out, arg, 4);
    } else {
        out.append_byte(mt + 27);
        append_be(ref out, arg, 8);
    }
}

/// Append the low `n` bytes of `value`, big-endian.
fn append_be(ref out: ByteArray, value: u64, n: usize) {
    let mut i = n;
    while i > 0 {
        i -= 1;
        let shift = pow256(i);
        let b: u64 = (value / shift) % 256;
        out.append_byte(b.try_into().unwrap());
    }
}

fn pow256(exp: usize) -> u64 {
    let mut acc: u64 = 1;
    let mut i = 0;
    while i < exp {
        acc *= 256;
        i += 1;
    }
    acc
}
