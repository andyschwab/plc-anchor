//! Anchor contract gate (REFERENCE.md §2, §3 component 3).
//!
//! Exercises the contract entrypoints directly via contract_state_for_testing (no deploy):
//! import a genesis, append its real successor ops, read the head back, and confirm the
//! permissionless invariants (re-import rejected, unknown DID rejected). Corpus indices:
//! 0 = alice genesis, 4 = alice update, 5 = alice tombstone (same DID).

use drisl::cid::{CODEC_DAGCBOR, derive_cid_string};
use plc_core::anchor::IAnchor;
use plc_core::anchor::anchor::{AnchorImpl, contract_state_for_testing};
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
#[should_panic(expected: 'did-not-anchored')]
fn submit_to_unknown_did_is_rejected() {
    let vectors = op_verify_vectors();
    let update = from_hex(vectors.at(ALICE_UPDATE).signed_drisl_hex);
    let mut state = contract_state_for_testing();
    AnchorImpl::submit_op(ref state, "did:plc:doesnotexist000000000", update);
}
