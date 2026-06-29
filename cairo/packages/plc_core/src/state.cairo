//! Per-DID anchored state + transitions (REFERENCE.md §3 component 3, §4).
//!
//! The storage-free core of the anchor: what the contract keeps per DID and how a new op
//! advances it. This first slice is the spine — genesis import and the `submit_op` *append*
//! path (prev == head). The confirmed/tentative tiers and the in-window recovery/fork path
//! (§4) build on this in P3.3; the DID→document commitment root in P3.2.
//!
//! Authorization is the op's embedded signature, verified against the head op's rotation
//! keys (REFERENCE.md §2): the Starknet tx signer is irrelevant — that is the permissionless
//! property. Timestamps (`now`) are externally supplied (§1), threaded for the later window
//! logic.

use drisl::cid::{CODEC_DAGCBOR, derive_cid_string, derive_did_fragment};
use super::op_decode::{OpType, PlcOp, decode_op};
use super::op_verify::verify_op_authorized;

/// The minimal per-DID head needed to validate the next append: the head op's CID (the
/// `prev` a successor must name), the rotation keys that authorize the successor, and
/// whether the head is a tombstone (a dead end — no successor allowed).
#[derive(Drop, Clone)]
pub struct DidHead {
    pub head_cid: ByteArray,
    pub authority: Array<ByteArray>,
    pub tombstoned: bool,
}

/// Verify a genesis op and produce the DID + initial head.
///
/// A genesis op is self-authorized: its embedded signature must be by one of its *own*
/// rotation keys, and the DID is `did:plc:` + base32(sha256(signed genesis))[..24]
/// (REFERENCE.md §5). Rejects non-genesis ops.
pub fn import_genesis(genesis_signed: @ByteArray) -> Result<(ByteArray, DidHead), felt252> {
    let op = decode_op(genesis_signed)?;
    let PlcOp { op_type, prev, rotation_keys, vm_count: _, sig: _ } = op;

    if prev.is_some() {
        return Result::Err('not-genesis');
    }
    // decode_op already rejects a genesis tombstone; genesis is plc_operation or create.
    let _ = op_type;

    // Self-authorized: signed by one of its own rotation keys.
    verify_op_authorized(genesis_signed, @rotation_keys)?;

    let mut did: ByteArray = "did:plc:";
    did.append(@derive_did_fragment(genesis_signed));

    let head = DidHead {
        head_cid: derive_cid_string(CODEC_DAGCBOR, genesis_signed),
        authority: rotation_keys,
        tombstoned: false,
    };
    Result::Ok((did, head))
}

/// Reconstruct a `DidHead` from a stored head op's signed DRISL bytes: its CID (for
/// linkage), its rotation keys (authority for the next op), and whether it is a tombstone.
pub fn head_from_signed(head_signed: @ByteArray) -> Result<DidHead, felt252> {
    let op = decode_op(head_signed)?;
    let PlcOp { op_type, prev: _, rotation_keys, vm_count: _, sig: _ } = op;
    Result::Ok(
        DidHead {
            head_cid: derive_cid_string(CODEC_DAGCBOR, head_signed),
            authority: rotation_keys,
            tombstoned: op_type == OpType::Tombstone,
        },
    )
}

/// Apply a proposed op to the current head along the append path (prev == head).
///
/// Enforces: the head is not a tombstone; the proposed op names the head as `prev`; and the
/// embedded signature is by one of the head's rotation keys. Returns the new head (the
/// proposed op becomes the head; its own rotation keys authorize the *next* op) and the
/// signer's priority index. The recovery/fork path (prev pointing earlier) is P3.3.
pub fn apply_append(
    head: @DidHead, proposed_signed: @ByteArray, _now: u64,
) -> Result<(DidHead, usize), felt252> {
    if *head.tombstoned {
        return Result::Err('did-tombstoned');
    }

    let op = decode_op(proposed_signed)?;
    let PlcOp { op_type, prev, rotation_keys, vm_count: _, sig: _ } = op;

    // Linkage: the proposed op must extend the current head.
    match prev {
        Option::Some(p) => { if @p != head.head_cid {
            return Result::Err('prev-not-head');
        } },
        Option::None => { return Result::Err('append-of-genesis'); },
    }

    // Authorization: signed by one of the head op's rotation keys.
    let signer_index = verify_op_authorized(proposed_signed, head.authority)?;

    let tombstoned = op_type == OpType::Tombstone;
    let new_head = DidHead {
        head_cid: derive_cid_string(CODEC_DAGCBOR, proposed_signed),
        authority: rotation_keys,
        tombstoned,
    };
    Result::Ok((new_head, signer_index))
}
