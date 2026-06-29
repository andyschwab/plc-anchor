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
use super::recovery::{OpClass, RECOVERY_WINDOW_MS, classify_next_op};

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

// ── Recovery-aware chain model + confirmed/tentative tiers (REFERENCE.md §4) ──
//
// The append-only `DidHead` above is a fast path; recovery needs the recent chain so a
// proposed op can fork at an earlier op and nullify what followed. We keep an ordered list
// of op records; each op's `signer_index` is its signer's index within its predecessor's
// rotation keys — exactly the disputed-signer index a recovery decision needs (so the first
// nullified op never has to be re-verified). `created_at` is the externally-supplied
// timestamp (§1) recorded when the op was anchored; it drives the 72h window.

/// One op in a per-DID chain (the window the contract must keep to allow recovery).
#[derive(Drop, Clone)]
pub struct OpRecord {
    /// This op's base32 CID string (what a successor names as `prev`).
    pub cid: ByteArray,
    /// This op's rotation keys — the authority for any op that builds on (or forks at) it.
    pub rotation_keys: Array<ByteArray>,
    /// Anchored timestamp (ms); drives the 72h window.
    pub created_at: u64,
    /// Signer index within the *predecessor's* rotation keys (own keys for genesis).
    pub signer_index: usize,
    /// Whether this op is a tombstone (a dead end — nothing may build on it).
    pub tombstone: bool,
}

/// The result of applying a proposed op to a chain: how it relates to the history and the
/// record to splice in. The caller truncates the chain to `fork_index` and appends
/// `new_record` (see `rebuild_chain`).
#[derive(Drop)]
pub struct ApplyOutcome {
    pub class: OpClass,
    pub fork_index: usize,
    pub nullified_count: usize,
    pub new_record: OpRecord,
}

/// Verify a genesis op and produce the DID + its initial chain record (`created_at = now`).
pub fn genesis_record(
    genesis_signed: @ByteArray, now: u64,
) -> Result<(ByteArray, OpRecord), felt252> {
    let op = decode_op(genesis_signed)?;
    let PlcOp { op_type: _, prev, rotation_keys, vm_count: _, sig: _ } = op;
    if prev.is_some() {
        return Result::Err('not-genesis');
    }
    let signer_index = verify_op_authorized(genesis_signed, @rotation_keys)?;
    let mut did: ByteArray = "did:plc:";
    did.append(@derive_did_fragment(genesis_signed));
    let record = OpRecord {
        cid: derive_cid_string(CODEC_DAGCBOR, genesis_signed),
        rotation_keys,
        created_at: now,
        signer_index,
        tombstone: false,
    };
    Result::Ok((did, record))
}

/// Apply a proposed (non-genesis) op to `chain`, handling both the append and the
/// recovery/fork paths (`assureValidNextOp`). Finds the fork point by `prev`, verifies the
/// signature against that op's rotation keys, and — if the fork nullifies later ops —
/// applies the 72h higher-priority-key rule via `classify_next_op`.
pub fn apply_op(
    chain: @Array<OpRecord>, proposed_signed: @ByteArray, now: u64,
) -> Result<ApplyOutcome, felt252> {
    let op = decode_op(proposed_signed)?;
    let PlcOp { op_type, prev, rotation_keys, vm_count: _, sig: _ } = op;
    let prev_cid = match prev {
        Option::Some(p) => p,
        Option::None => { return Result::Err('append-of-genesis'); },
    };

    // Locate the fork point (the op named by `prev`).
    let n = chain.len();
    let mut fork_index: usize = 0;
    let mut found = false;
    let mut i = 0;
    while i < n {
        if chain.at(i).cid == @prev_cid {
            fork_index = i;
            found = true;
            break;
        }
        i += 1;
    }
    if !found {
        return Result::Err('prev-not-in-chain');
    }

    let fork_point = chain.at(fork_index);
    if *fork_point.tombstone {
        return Result::Err('build-on-tombstone');
    }

    let proposed_index = verify_op_authorized(proposed_signed, fork_point.rotation_keys)?;
    let nullified_count = n - 1 - fork_index;

    let class = if nullified_count == 0 {
        OpClass::Append
    } else {
        let first_nullified = chain.at(fork_index + 1);
        classify_next_op(
            proposed_index,
            nullified_count,
            *first_nullified.signer_index,
            *first_nullified.created_at,
            now,
        )?
    };

    let new_record = OpRecord {
        cid: derive_cid_string(CODEC_DAGCBOR, proposed_signed),
        rotation_keys,
        created_at: now,
        signer_index: proposed_index,
        tombstone: op_type == OpType::Tombstone,
    };
    Result::Ok(ApplyOutcome { class, fork_index, nullified_count, new_record })
}

/// Materialize the chain after an `apply_op`: keep ops up to and including the fork point,
/// then append the new record (dropping any nullified suffix).
pub fn rebuild_chain(chain: @Array<OpRecord>, outcome: ApplyOutcome) -> Array<OpRecord> {
    let mut new_chain: Array<OpRecord> = array![];
    let mut i = 0;
    while i <= outcome.fork_index {
        new_chain.append(chain.at(i).clone());
        i += 1;
    }
    new_chain.append(outcome.new_record);
    new_chain
}

/// The confirmed head: the CID of the latest op whose 72h window has fully closed (it can no
/// longer be the first-nullified of any valid recovery, so it is immutable — §4). "" if every
/// op is still tentative. Resolvers treat this as final.
pub fn confirmed_head(chain: @Array<OpRecord>, now: u64) -> ByteArray {
    let mut result: ByteArray = "";
    let mut i = 0;
    while i < chain.len() {
        let op = chain.at(i);
        if now > *op.created_at + RECOVERY_WINDOW_MS {
            result = op.cid.clone();
        }
        i += 1;
    }
    result
}

/// The tentative tip: the current head CID (still nullifiable if within the window). "" for
/// an empty chain.
pub fn tentative_head(chain: @Array<OpRecord>) -> ByteArray {
    let n = chain.len();
    if n == 0 {
        return "";
    }
    chain.at(n - 1).cid.clone()
}
