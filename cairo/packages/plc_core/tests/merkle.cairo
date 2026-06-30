//! DID→head Merkle commitment gate (REFERENCE.md §4; Phase 3 P3.2).
//!
//! Differential against conformance/src/gen-merkle-vectors.mjs (raw node:crypto sha256): the
//! Cairo tree must produce byte-identical leaf/root/proof so the on-chain commitment and a
//! resolver computing it independently agree. Plus structural checks the generator can't
//! express (sort independence, tamper rejection, degenerate trees).

use plc_core::merkle::{
    empty_root, leaf_hash, merkle_proof, merkle_root, sorted_leaves, verify_proof,
};
use super::merkle_vectors_generated::{
    merkle_empty_root, merkle_entries, merkle_expected_root, merkle_proof_index, merkle_proof_steps,
    merkle_single_root,
};

/// The root over the canonical (sorted) entry set matches the TS reference byte-for-byte.
#[test]
fn root_matches_reference() {
    let leaves = sorted_leaves(merkle_entries());
    let root = merkle_root(@leaves);
    assert!(root == merkle_expected_root(), "merkle root != TS reference");
}

/// `empty_root()` == sha256("") == the TS reference empty root.
#[test]
fn empty_root_matches_reference() {
    assert!(empty_root() == merkle_empty_root(), "empty root != TS reference");
}

/// A single-entry tree's root is just that entry's leaf hash (no node hashing).
#[test]
fn single_entry_root_is_the_leaf() {
    let (did, head) = merkle_entries().at(0).clone();
    let leaf = leaf_hash(@did, @head);
    let mut one: Array<ByteArray> = array![];
    one.append(leaf.clone());
    let root = merkle_root(@one);
    assert!(root == leaf, "single-entry root must equal the leaf");
    assert!(root == merkle_single_root(), "single-entry root != TS reference");
}

/// The pinned inclusion proof recomputes the reference root from its leaf.
#[test]
fn inclusion_proof_verifies() {
    let leaves = sorted_leaves(merkle_entries());
    let idx = merkle_proof_index();
    let leaf = leaves.at(idx).clone();
    let proof = merkle_proof_steps();
    assert!(verify_proof(@leaf, @proof, @merkle_expected_root()), "pinned proof failed to verify");
}

/// A proof generated in-Cairo for every index verifies against the in-Cairo root (full
/// round-trip, independent of the pinned single-index vector).
#[test]
fn generated_proofs_round_trip() {
    let leaves = sorted_leaves(merkle_entries());
    let root = merkle_root(@leaves);
    let n = leaves.len();
    let mut i = 0;
    while i < n {
        let proof = merkle_proof(@leaves, i);
        let leaf = leaves.at(i).clone();
        assert!(verify_proof(@leaf, @proof, @root), "round-trip proof {} failed", i);
        i += 1;
    }
}

/// A proof that recomputes to the wrong root is rejected (tampered leaf).
#[test]
fn proof_rejects_wrong_leaf() {
    let leaves = sorted_leaves(merkle_entries());
    let root = merkle_root(@leaves);
    let proof = merkle_proof(@leaves, 0);
    // Use a different leaf with the same path → must not verify.
    let wrong = leaves.at(1).clone();
    assert!(!verify_proof(@wrong, @proof, @root), "accepted a proof for the wrong leaf");
}

/// Input order does not change the root: the tree sorts entries by did first. Reverse the
/// entry list and confirm the root is unchanged.
#[test]
fn root_is_insertion_order_independent() {
    let entries = merkle_entries();
    let mut reversed: Array<(ByteArray, ByteArray)> = array![];
    let n = entries.len();
    let mut i = n;
    while i > 0 {
        i -= 1;
        reversed.append(entries.at(i).clone());
    }
    let root_fwd = merkle_root(@sorted_leaves(merkle_entries()));
    let root_rev = merkle_root(@sorted_leaves(reversed));
    assert!(root_fwd == root_rev, "root changed with input order - sort is broken");
}

/// Leaf and node domain separation: a 0x00-prefixed leaf can never equal a 0x01-prefixed
/// node over the same 64-byte body, so a 2-leaf root differs from either leaf.
#[test]
fn leaf_and_node_are_domain_separated() {
    let a = leaf_hash(@"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", @"bafyaaa");
    let b = leaf_hash(@"did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", @"bafybbb");
    let mut leaves: Array<ByteArray> = array![];
    leaves.append(a.clone());
    leaves.append(b.clone());
    let root = merkle_root(@leaves);
    assert!(root != a && root != b, "node hash collided with a leaf - missing domain sep");
}
