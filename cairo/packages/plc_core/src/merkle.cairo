//! DID→document commitment: a sha256 Merkle tree over the anchored DID→head map
//! (REFERENCE.md §3 component 3, §4; Phase 3 P3.2).
//!
//! The anchor commits a single root over `{ did → head_cid }` so a resolver can verify a
//! DID's current document against the on-chain root with a logarithmic inclusion proof —
//! the adoption surface (build order item 5). The contract exposes a **confirmed** root
//! (over heads whose 72h window has closed — immutable) and a **tentative** root (over the
//! live tips); see `anchor`.
//!
//! ## Format (pinned — resolvers depend on it; hard to change later)
//!
//! Hashing is sha2-256 (the corelib syscall — same hash the CID/DID stack uses), with
//! RFC 6962 domain separation so a leaf preimage can never be reinterpreted as an internal
//! node (second-preimage resistance):
//!
//!   - **leaf**:  `sha256( 0x00 ‖ did ‖ head_cid )`
//!   - **node**:  `sha256( 0x01 ‖ left ‖ right )`   over the two 32-byte child digests
//!   - **empty**: `sha256( "" )`   (no DIDs anchored)
//!
//! `did` is the `did:plc:` string (always 32 bytes: `did:plc:` + 24-char fragment) and
//! `head_cid` the base32 multibase CID string; the DID's fixed width makes the `did ‖
//! head_cid` boundary unambiguous without a separator.
//!
//! **Tree shape:** leaves are the map entries **sorted by `did` ascending** (a canonical,
//! insertion-order-independent commitment), paired up left-to-right; an odd node at any
//! level is **promoted** unchanged to the next level (RFC 6962), never duplicated — the
//! duplicate-the-last convention (Bitcoin) admits distinct trees with equal roots
//! (CVE-2012-2459).
//!
//! This module is pure (no storage): the contract supplies the live `{did, head}` set.
//! Inclusion-proof *verification* (`verify_proof`) is the resolver-library primitive but is
//! pinned and tested here alongside generation so both sides share one definition.

use core::sha256::compute_sha256_byte_array;

const LEAF_PREFIX: u8 = 0x00;
const NODE_PREFIX: u8 = 0x01;

/// A sibling on an inclusion path: its 32-byte digest and whether it sits on the *left* of
/// the node being recomputed (so the verifier hashes in the correct order).
#[derive(Drop, Clone)]
pub struct ProofStep {
    pub sibling: ByteArray,
    pub sibling_is_left: bool,
}

/// sha2-256 of `payload` as a 32-byte big-endian `ByteArray` (the digest form this tree
/// concatenates and commits). Wraps the corelib syscall.
pub fn sha256_bytes(payload: @ByteArray) -> ByteArray {
    let digest = compute_sha256_byte_array(payload);
    let words = digest.span();
    let mut out: ByteArray = "";
    let mut i = 0;
    while i < 8 {
        let w = *words.at(i);
        out.append_byte(((w / 0x1000000) % 0x100).try_into().unwrap());
        out.append_byte(((w / 0x10000) % 0x100).try_into().unwrap());
        out.append_byte(((w / 0x100) % 0x100).try_into().unwrap());
        out.append_byte((w % 0x100).try_into().unwrap());
        i += 1;
    }
    out
}

/// Leaf digest for one map entry: `sha256( 0x00 ‖ did ‖ head_cid )`.
pub fn leaf_hash(did: @ByteArray, head_cid: @ByteArray) -> ByteArray {
    let mut pre: ByteArray = "";
    pre.append_byte(LEAF_PREFIX);
    pre.append(did);
    pre.append(head_cid);
    sha256_bytes(@pre)
}

/// Internal-node digest: `sha256( 0x01 ‖ left ‖ right )`.
pub fn node_hash(left: @ByteArray, right: @ByteArray) -> ByteArray {
    let mut pre: ByteArray = "";
    pre.append_byte(NODE_PREFIX);
    pre.append(left);
    pre.append(right);
    sha256_bytes(@pre)
}

/// The root of the empty map: `sha256("")`.
pub fn empty_root() -> ByteArray {
    sha256_bytes(@"")
}

/// True iff `a < b` bytewise (shorter is smaller on a shared prefix) — the DID ordering the
/// canonical commitment sorts by. DIDs are distinct and fixed-width here, so this is a total
/// order over the entry set.
fn byte_lt(a: @ByteArray, b: @ByteArray) -> bool {
    let la = a.len();
    let lb = b.len();
    let n = if la < lb {
        la
    } else {
        lb
    };
    let mut i = 0;
    let mut result = la < lb; // tie on the shared prefix → shorter wins
    while i < n {
        let ca = a.at(i).unwrap();
        let cb = b.at(i).unwrap();
        if ca != cb {
            result = ca < cb;
            break;
        }
        i += 1;
    }
    result
}

/// Sort `entries` (`(did, head_cid)`) by `did` ascending and return their leaf digests in
/// that canonical order. **Merge sort, O(N log N)** — this runs in a read-time view over the
/// *whole* roster (every proof/root call rebuilds the tree), so the sort cost scales with the
/// anchored set; the asymptotics matter for adoption at scale. DIDs are distinct, so the
/// total order is strict and the result is insertion-order-independent — part of the pinned
/// format (a different order would fork the root).
pub fn sorted_leaves(entries: Array<(ByteArray, ByteArray)>) -> Array<ByteArray> {
    let ordered = merge_sort(entries);
    let mut leaves: Array<ByteArray> = array![];
    let mut k = 0;
    while k < ordered.len() {
        let (did, head) = ordered.at(k);
        leaves.append(leaf_hash(did, head));
        k += 1;
    }
    leaves
}

/// Top-down merge sort of `entries` by `did` ascending. Stable (left wins ties), though DIDs
/// are distinct so ties never occur; the canonical order is what the pinned root commits to.
fn merge_sort(entries: Array<(ByteArray, ByteArray)>) -> Array<(ByteArray, ByteArray)> {
    let n = entries.len();
    if n <= 1 {
        return entries;
    }
    let mid = n / 2;
    let mut left: Array<(ByteArray, ByteArray)> = array![];
    let mut right: Array<(ByteArray, ByteArray)> = array![];
    let mut i = 0;
    while i < n {
        let item = entries.at(i).clone();
        if i < mid {
            left.append(item);
        } else {
            right.append(item);
        }
        i += 1;
    }
    merge(merge_sort(left), merge_sort(right))
}

/// Merge two did-sorted runs into one, preserving the ascending order.
fn merge(
    left: Array<(ByteArray, ByteArray)>, right: Array<(ByteArray, ByteArray)>,
) -> Array<(ByteArray, ByteArray)> {
    let mut out: Array<(ByteArray, ByteArray)> = array![];
    let ln = left.len();
    let rn = right.len();
    let mut i = 0;
    let mut j = 0;
    while i < ln && j < rn {
        let (ld, lh) = left.at(i).clone();
        let (rd, rh) = right.at(j).clone();
        // Take the left entry unless the right did is strictly smaller (stable on ties).
        if !byte_lt(@rd, @ld) {
            out.append((ld, lh));
            i += 1;
        } else {
            out.append((rd, rh));
            j += 1;
        }
    }
    while i < ln {
        out.append(left.at(i).clone());
        i += 1;
    }
    while j < rn {
        out.append(right.at(j).clone());
        j += 1;
    }
    out
}

/// Merkle root over `leaves` (already in canonical order). Pairs left-to-right, promoting a
/// lone trailing node (RFC 6962). Empty → `empty_root()`; single leaf → that leaf.
pub fn merkle_root(leaves: @Array<ByteArray>) -> ByteArray {
    let n = leaves.len();
    if n == 0 {
        return empty_root();
    }
    let mut level: Array<ByteArray> = array![];
    let mut c = 0;
    while c < n {
        level.append(leaves.at(c).clone());
        c += 1;
    }
    while level.len() > 1 {
        let mut next: Array<ByteArray> = array![];
        let m = level.len();
        let mut i = 0;
        while i < m {
            if i + 1 < m {
                next.append(node_hash(level.at(i), level.at(i + 1)));
                i += 2;
            } else {
                next.append(level.at(i).clone()); // promote the odd node
                i += 1;
            }
        }
        level = next;
    }
    level.at(0).clone()
}

/// Build the inclusion path for `index` into `leaves`: the siblings (with side) needed to
/// recompute the root from leaf `index`. A promoted (odd) node contributes no step at its
/// level. Mirrors `merkle_root`'s pairing exactly.
pub fn merkle_proof(leaves: @Array<ByteArray>, index: usize) -> Array<ProofStep> {
    let mut proof: Array<ProofStep> = array![];
    let n = leaves.len();
    if n == 0 || index >= n {
        return proof;
    }
    let mut level: Array<ByteArray> = array![];
    let mut c = 0;
    while c < n {
        level.append(leaves.at(c).clone());
        c += 1;
    }
    let mut idx = index;
    while level.len() > 1 {
        let m = level.len();
        let is_right = idx % 2 == 1;
        if is_right {
            // sibling is the left node at idx-1
            proof.append(ProofStep { sibling: level.at(idx - 1).clone(), sibling_is_left: true });
        } else if idx + 1 < m {
            // sibling is the right node at idx+1
            proof.append(ProofStep { sibling: level.at(idx + 1).clone(), sibling_is_left: false });
        } // else: promoted node — no sibling at this level

        // Build the next level and advance idx to the parent position.
        let mut next: Array<ByteArray> = array![];
        let mut i = 0;
        while i < m {
            if i + 1 < m {
                next.append(node_hash(level.at(i), level.at(i + 1)));
                i += 2;
            } else {
                next.append(level.at(i).clone());
                i += 1;
            }
        }
        level = next;
        idx = idx / 2;
    }
    proof
}

/// Recompute the root from `leaf` and its inclusion `proof`, and compare to `root`. The
/// resolver-side primitive (pinned and tested here so generation and verification agree).
pub fn verify_proof(leaf: @ByteArray, proof: @Array<ProofStep>, root: @ByteArray) -> bool {
    let mut acc: ByteArray = leaf.clone();
    let mut i = 0;
    while i < proof.len() {
        let step = proof.at(i);
        if *step.sibling_is_left {
            acc = node_hash(step.sibling, @acc);
        } else {
            acc = node_hash(@acc, step.sibling);
        }
        i += 1;
    }
    @acc == root
}
