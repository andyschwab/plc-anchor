//! PLC op structural decode + constraint validation (REFERENCE.md §3 item 2, §5).
//!
//! Decodes a signed PLC op's DRISL bytes into a typed `PlcOp`, reusing the keystone
//! `drisl` decoder (which already enforces canonical dCBOR42: minimal ints, map-key
//! ordering, definite lengths, blessed simple values). On top of that canonical layer
//! this module applies the PLC schema and the §5 size/count constraints, and normalizes
//! the legacy `create` op into the modern shape so downstream verification has one
//! representation.
//!
//! What this does NOT do (later Phase 2 steps): authorized-signer derivation + signer
//! index (P2.3), `prev` linkage against the previous op's CID (P2.4), recovery (P2.5).
//! Here we only decode and structurally validate a single op in isolation.

use drisl::drisl::{Value, decode};

/// PLC op type (REFERENCE.md §5). `create` is the legacy genesis form; it is normalized
/// to the modern `rotationKeys`/`verificationMethods` shape at decode time, so callers
/// downstream treat it like a `plc_operation` genesis.
#[derive(Drop, PartialEq)]
pub enum OpType {
    PlcOperation,
    Create,
    Tombstone,
}

/// A structurally validated PLC op. `rotation_keys` is the op's *own* declared rotation
/// set (synthesized for legacy `create`); the *authorized signer* set for a non-genesis
/// op is the previous op's rotation keys, resolved in P2.3 — not here.
#[derive(Drop)]
pub struct PlcOp {
    pub op_type: OpType,
    /// The `prev` CID as the base32 multibase string PLC stores it (a CBOR text field,
    /// NOT a Tag-42 link). `None` == genesis (`prev: null`).
    pub prev: Option<ByteArray>,
    /// did:key strings, priority-ordered (index 0 = highest). Empty for a tombstone.
    pub rotation_keys: Array<ByteArray>,
    /// Count of `verificationMethods` entries (the §5 ≤10 constraint operand). 1 for a
    /// normalized legacy `create`; 0 for a tombstone.
    pub vm_count: usize,
    /// base64url-nopad signature string (the `sig` field).
    pub sig: ByteArray,
}

// §5 constraints.
pub const MAX_OP_SIZE: usize = 7500;
pub const MAX_ROTATION_KEYS: usize = 5;
pub const MAX_VERIFICATION_METHODS: usize = 10;

/// Decode + structurally validate a signed PLC op from its DRISL bytes.
pub fn decode_op(signed: @ByteArray) -> Result<PlcOp, felt252> {
    // §5: max op size 7500 bytes (dCBOR-encoded). Cheap pre-check before decoding.
    if signed.len() > MAX_OP_SIZE {
        return Result::Err('op-too-large');
    }

    let value = decode(signed)?;
    let mut entries = match value {
        Value::Map(e) => e,
        _ => { return Result::Err('op-not-map'); },
    };

    // Collected fields.
    let mut type_str: ByteArray = "";
    let mut have_type = false;
    let mut prev: Option<ByteArray> = Option::None;
    let mut prev_present = false;
    let mut rotation_keys: Array<ByteArray> = array![];
    let mut have_rotation = false;
    let mut vm_count: usize = 0;
    let mut sig: ByteArray = "";
    let mut have_sig = false;
    // Legacy `create` fields (normalized below).
    let mut signing_key: ByteArray = "";
    let mut have_signing = false;
    let mut recovery_key: ByteArray = "";
    let mut have_recovery = false;

    let mut err: felt252 = 0;
    loop {
        match entries.pop_front() {
            Option::Some((
                k, v,
            )) => {
                if k == "type" {
                    match v {
                        Value::Text(s) => {
                            type_str = s;
                            have_type = true;
                        },
                        _ => { err = 'type-not-text'; },
                    }
                } else if k == "prev" {
                    prev_present = true;
                    match v {
                        Value::Null => {},
                        Value::Text(s) => { prev = Option::Some(s); },
                        _ => { err = 'prev-bad-type'; },
                    }
                } else if k == "rotationKeys" {
                    match v {
                        Value::Array(items) => {
                            match extract_text_array(items) {
                                Result::Ok(keys) => {
                                    rotation_keys = keys;
                                    have_rotation = true;
                                },
                                Result::Err(e) => { err = e; },
                            }
                        },
                        _ => { err = 'rotkeys-not-array'; },
                    }
                } else if k == "verificationMethods" {
                    match v {
                        Value::Map(m) => { vm_count = m.len(); },
                        _ => { err = 'vmethods-not-map'; },
                    }
                } else if k == "sig" {
                    match v {
                        Value::Text(s) => {
                            sig = s;
                            have_sig = true;
                        },
                        _ => { err = 'sig-not-text'; },
                    }
                } else if k == "signingKey" {
                    match v {
                        Value::Text(s) => {
                            signing_key = s;
                            have_signing = true;
                        },
                        _ => { err = 'signingkey-not-text'; },
                    }
                } else if k == "recoveryKey" {
                    match v {
                        Value::Text(s) => {
                            recovery_key = s;
                            have_recovery = true;
                        },
                        _ => { err = 'recoverykey-not-text'; },
                    }
                }
                // Other keys (alsoKnownAs, services, handle, service) are not needed for
            // verification; `v` is dropped here.
            },
            Option::None => { break; },
        }
        if err != 0 {
            break;
        }
    }
    if err != 0 {
        return Result::Err(err);
    }

    if !have_sig {
        return Result::Err('missing-sig');
    }
    if !have_type {
        return Result::Err('missing-type');
    }
    // Every PLC op carries a `prev` field (genesis sets it to null).
    if !prev_present {
        return Result::Err('missing-prev');
    }

    let op_type = if type_str == "plc_operation" {
        OpType::PlcOperation
    } else if type_str == "plc_tombstone" {
        OpType::Tombstone
    } else if type_str == "create" {
        OpType::Create
    } else {
        return Result::Err('unknown-op-type');
    };

    // Normalize legacy `create` → modern shape: rotationKeys = [recoveryKey, signingKey]
    // (recovery key is higher priority, index 0), one verificationMethod (atproto =
    // signingKey). A `create` is always genesis (`prev: null`).
    if op_type == OpType::Create {
        if !have_recovery || !have_signing {
            return Result::Err('create-missing-keys');
        }
        if have_rotation {
            return Result::Err('create-has-rotationkeys');
        }
        rotation_keys = array![recovery_key, signing_key];
        have_rotation = true;
        vm_count = 1;
    }

    if vm_count > MAX_VERIFICATION_METHODS {
        return Result::Err('too-many-vmethods');
    }

    match @op_type {
        OpType::Tombstone => {
            // A tombstone has no rotation keys of its own and can never be genesis.
            if have_rotation {
                return Result::Err('tombstone-has-rotationkeys');
            }
            if prev.is_none() {
                return Result::Err('tombstone-is-genesis');
            }
        },
        _ => {
            if !have_rotation {
                return Result::Err('missing-rotationkeys');
            }
            let n = rotation_keys.len();
            if n < 1 || n > MAX_ROTATION_KEYS {
                return Result::Err('bad-rotationkey-count');
            }
        },
    }

    Result::Ok(PlcOp { op_type, prev, rotation_keys, vm_count, sig })
}

/// Move an `Array<Value>` of text strings into an `Array<ByteArray>`; error on any
/// non-text element.
fn extract_text_array(mut items: Array<Value>) -> Result<Array<ByteArray>, felt252> {
    let mut out: Array<ByteArray> = array![];
    let mut err: felt252 = 0;
    loop {
        match items.pop_front() {
            Option::Some(v) => {
                match v {
                    Value::Text(s) => { out.append(s); },
                    _ => {
                        err = 'array-elem-not-text';
                        break;
                    },
                }
            },
            Option::None => { break; },
        }
    }
    if err != 0 {
        return Result::Err(err);
    }
    Result::Ok(out)
}
