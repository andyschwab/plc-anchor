//! Anchor contract gate (REFERENCE.md §2, §3 component 3).
//!
//! Exercises the contract entrypoints directly via contract_state_for_testing (no deploy):
//! import a genesis, append its real successor ops, read the head back, and confirm the
//! permissionless invariants (re-import rejected, unknown DID rejected). Corpus indices:
//! 0 = alice genesis, 4 = alice update, 5 = alice tombstone (same DID).

use drisl::cid::{CODEC_DAGCBOR, derive_cid_string};
use plc_core::anchor::anchor::{AnchorImpl, contract_state_for_testing};
use plc_core::merkle::{
    empty_root, leaf_hash, merkle_proof, merkle_root, sorted_leaves, verify_proof,
};
use starknet::testing::set_block_timestamp;
use super::common::from_hex;
use super::op_verify_vectors_generated::op_verify_vectors;
use super::recovery_vectors_generated::recovery_scenario;

const ALICE_GENESIS: usize = 0;
const ALICE_UPDATE: usize = 4;
const ALICE_TOMBSTONE: usize = 5;

#[test]
fn import_then_append_chain() {
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let update = from_hex(vectors.at(ALICE_UPDATE).signed_drisl_hex);
    let tombstone = from_hex(vectors.at(ALICE_TOMBSTONE).signed_drisl_hex);
    let expected_did = vectors.at(ALICE_GENESIS).did.clone();

    let mut state = contract_state_for_testing();

    // Import genesis → did, anchored, head == genesis cid.
    let did = AnchorImpl::import_genesis(ref state, genesis.clone());
    assert!(did == expected_did, "imported did mismatch");
    assert!(AnchorImpl::is_anchored(@state, did.clone()), "should be anchored after import");
    // The genesis head cid == the update's prev (the update links to the genesis).
    assert!(
        AnchorImpl::head_cid(@state, did.clone()) == vectors.at(ALICE_UPDATE).prev.clone(),
        "genesis head cid should equal update.prev",
    );

    // Append update → head advances to the update's cid.
    AnchorImpl::submit_op(ref state, did.clone(), update.clone());
    assert!(
        AnchorImpl::head_cid(@state, did.clone()) == vectors.at(ALICE_TOMBSTONE).prev.clone(),
        "head should be the update cid (== tombstone.prev)",
    );

    // Append tombstone → head advances; the update's prev was the genesis cid.
    AnchorImpl::submit_op(ref state, did.clone(), tombstone.clone());
    assert!(AnchorImpl::is_anchored(@state, did.clone()), "still anchored after tombstone");
}

#[test]
fn recovery_through_contract() {
    // Import genesis, append opA (index-1 key), then recover with the index-0 key within the
    // window. The head must become the recovery op and the chain re-link to genesis.
    let s = recovery_scenario();
    let genesis = from_hex(@s.genesis_hex);
    let op_a = from_hex(@s.op_a_hex);
    let recovery_k0 = from_hex(@s.recovery_k0_hex);

    let mut state = contract_state_for_testing();

    set_block_timestamp(1000);
    let did = AnchorImpl::import_genesis(ref state, genesis);
    assert!(did == s.did.clone(), "did mismatch");

    set_block_timestamp(1001); // opA anchored ~1s after genesis
    AnchorImpl::submit_op(ref state, did.clone(), op_a.clone());

    // Recover well within the 72h window (a few seconds later).
    set_block_timestamp(1100);
    AnchorImpl::submit_op(ref state, did.clone(), recovery_k0.clone());
    assert!(
        AnchorImpl::head_cid(@state, did.clone()) == derive_cid_string(CODEC_DAGCBOR, @recovery_k0),
        "head should be the recovery op after recovery",
    );

    // Far in the future, every op's window has closed → confirmed head == the tip.
    set_block_timestamp(1000000);
    assert!(
        AnchorImpl::confirmed_head(
            @state, did.clone(),
        ) == derive_cid_string(CODEC_DAGCBOR, @recovery_k0),
        "confirmed head should be the recovery op once its window closes",
    );
}

#[test]
fn unknown_did_is_not_anchored() {
    let state = contract_state_for_testing();
    assert!(!AnchorImpl::is_anchored(@state, "did:plc:doesnotexist000000000"), "not anchored");
    assert!(AnchorImpl::head_cid(@state, "did:plc:doesnotexist000000000") == "", "empty head");
}

#[test]
#[should_panic(expected: 'already-anchored')]
fn reimport_is_rejected() {
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let mut state = contract_state_for_testing();
    let _ = AnchorImpl::import_genesis(ref state, genesis.clone());
    // Second import of the same genesis must revert.
    let _ = AnchorImpl::import_genesis(ref state, genesis.clone());
}

#[test]
fn empty_commitment_is_sha256_empty() {
    // No DIDs anchored → both roots are the empty-map commitment sha256("").
    let state = contract_state_for_testing();
    assert!(AnchorImpl::tentative_root(@state) == empty_root(), "empty tentative root");
    assert!(AnchorImpl::confirmed_root(@state) == empty_root(), "empty confirmed root");
}

#[test]
fn tentative_root_tracks_the_head_and_proves_inclusion() {
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let update = from_hex(vectors.at(ALICE_UPDATE).signed_drisl_hex);
    let mut state = contract_state_for_testing();

    let did = AnchorImpl::import_genesis(ref state, genesis.clone());

    // One DID → the root is exactly its leaf (single-leaf tree). The head is the genesis cid.
    let genesis_head = derive_cid_string(CODEC_DAGCBOR, @genesis);
    let root1 = AnchorImpl::tentative_root(@state);
    assert!(root1 == leaf_hash(@did, @genesis_head), "root != single leaf for one DID");

    // After an append the root follows the new tip.
    AnchorImpl::submit_op(ref state, did.clone(), update.clone());
    let update_head = derive_cid_string(CODEC_DAGCBOR, @update);
    let root2 = AnchorImpl::tentative_root(@state);
    assert!(root2 == leaf_hash(@did, @update_head), "root did not follow the new head");
    assert!(root2 != root1, "root unchanged after the head advanced");

    // An inclusion proof for this DID verifies against the contract's root.
    let mut entries: Array<(ByteArray, ByteArray)> = array![];
    entries.append((did.clone(), update_head.clone()));
    let leaves = sorted_leaves(entries);
    let proof = merkle_proof(@leaves, 0);
    assert!(
        verify_proof(leaves.at(0), @proof, @root2), "inclusion proof failed against contract root",
    );
}

#[test]
fn confirmed_root_lags_then_matches_tentative() {
    // Before any window closes the confirmed map is empty; once it closes the confirmed root
    // equals the tentative root (the head is now immutable).
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let mut state = contract_state_for_testing();

    set_block_timestamp(1000); // genesis createdAt = 1_000_000 ms
    let _did = AnchorImpl::import_genesis(ref state, genesis.clone());

    // Still inside the window → nothing confirmed yet.
    set_block_timestamp(1001);
    assert!(
        AnchorImpl::confirmed_root(@state) == empty_root(), "confirmed must be empty in-window",
    );

    // Far past the 72h window → the head is confirmed; roots agree.
    set_block_timestamp(1000000);
    assert!(
        AnchorImpl::confirmed_root(@state) == AnchorImpl::tentative_root(@state),
        "confirmed root should equal tentative once the window closes",
    );
}

#[test]
fn commitment_root_spans_multiple_dids() {
    // Two independent DIDs → the root is the 2-leaf tree over both heads, order-independent.
    let vectors = op_verify_vectors();
    let alice_genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    // A second, distinct genesis from the corpus (different DID).
    let mut bob_idx = 0;
    let mut j = 0;
    while j < vectors.len() {
        let v = vectors.at(j);
        if *v.is_genesis && v.did != vectors.at(ALICE_GENESIS).did {
            bob_idx = j;
            break;
        }
        j += 1;
    }
    let bob_genesis = from_hex(vectors.at(bob_idx).signed_drisl_hex);

    let mut state = contract_state_for_testing();
    let alice = AnchorImpl::import_genesis(ref state, alice_genesis.clone());
    let bob = AnchorImpl::import_genesis(ref state, bob_genesis.clone());

    let mut entries: Array<(ByteArray, ByteArray)> = array![];
    entries.append((alice.clone(), derive_cid_string(CODEC_DAGCBOR, @alice_genesis)));
    entries.append((bob.clone(), derive_cid_string(CODEC_DAGCBOR, @bob_genesis)));
    let expected = merkle_root(@sorted_leaves(entries));
    assert!(AnchorImpl::tentative_root(@state) == expected, "two-DID root mismatch");
}

#[test]
#[should_panic(expected: 'did-not-anchored')]
fn submit_to_unknown_did_is_rejected() {
    let vectors = op_verify_vectors();
    let update = from_hex(vectors.at(ALICE_UPDATE).signed_drisl_hex);
    let mut state = contract_state_for_testing();
    AnchorImpl::submit_op(ref state, "did:plc:doesnotexist000000000", update);
}
