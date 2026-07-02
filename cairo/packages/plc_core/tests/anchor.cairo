//! Anchor contract gate — verify-on-read (REFERENCE.md §1/§2; docs/ONCHAIN-REARCH-PLAN.md).
//!
//! The v2 contract is a store-only, block-timestamped, append-only op log: it runs NO signature
//! or CID verification and adjudicates NO forks — the witness re-derives all of that read-side
//! (`witness-ts`; the read-side recovery/imported-guard tests live in
//! witness-ts/test/nullified.test.ts). So these tests assert the storage contract: bytes are
//! kept verbatim (non-equivocation), stamped with block time + provenance, and exposed via
//! `chain`; unverified/garbage ops are STORED (not rejected — that is the read side's job); and
//! the only reverts are the structural ones (empty chain, re-anchor, unknown DID).
//! Corpus indices: 0 = alice genesis, 4 = alice update, 5 = alice tombstone (same DID).

use plc_core::anchor::OpEntry;
use plc_core::anchor::anchor::{AnchorImpl, contract_state_for_testing};
use starknet::testing::set_block_timestamp;
use super::common::from_hex;
use super::op_verify_vectors_generated::op_verify_vectors;

const ALICE_GENESIS: usize = 0;
const ALICE_UPDATE: usize = 4;
const ALICE_TOMBSTONE: usize = 5;

/// Byte-equality helper for a stored op's `signed` field against expected bytes.
fn stored_signed_eq(entry: @OpEntry, expected: @ByteArray) -> bool {
    entry.signed.clone() == expected.clone()
}

#[test]
fn import_genesis_stores_bytes_verbatim() {
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let expected_did = vectors.at(ALICE_GENESIS).did.clone();

    let mut state = contract_state_for_testing();
    set_block_timestamp(1234); // seconds; the contract stamps ms (× 1000)
    let did = AnchorImpl::import_genesis(ref state, genesis.clone());
    assert!(did == expected_did, "derived did mismatch");
    assert!(AnchorImpl::is_anchored(@state, did.clone()), "anchored after import_genesis");

    let chain = AnchorImpl::chain(@state, did.clone());
    assert!(chain.len() == 1, "one op stored");
    assert!(stored_signed_eq(chain.at(0), @genesis), "genesis bytes stored byte-identical");
    assert!(*chain.at(0).imported, "genesis is settled (imported)");
    assert!(*chain.at(0).created_at == 1234 * 1000, "block-time stamp is ms");
}

#[test]
fn submit_op_appends_live_ops() {
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let update = from_hex(vectors.at(ALICE_UPDATE).signed_drisl_hex);

    let mut state = contract_state_for_testing();
    let did = AnchorImpl::import_genesis(ref state, genesis.clone());
    AnchorImpl::submit_op(ref state, did.clone(), update.clone());

    let chain = AnchorImpl::chain(@state, did.clone());
    assert!(chain.len() == 2, "genesis + appended op");
    assert!(stored_signed_eq(chain.at(1), @update), "appended bytes stored verbatim");
    // Provenance: genesis/import are settled; submit_op is observed live.
    assert!(*chain.at(0).imported, "genesis imported");
    assert!(!*chain.at(1).imported, "submit_op is live (not imported)");
}

#[test]
fn import_stores_the_whole_chain_settled() {
    let vectors = op_verify_vectors();
    let expected_did = vectors.at(ALICE_GENESIS).did.clone();
    let chain_in = array![
        from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex),
        from_hex(vectors.at(ALICE_UPDATE).signed_drisl_hex),
        from_hex(vectors.at(ALICE_TOMBSTONE).signed_drisl_hex),
    ];

    let mut state = contract_state_for_testing();
    let did = AnchorImpl::import(ref state, chain_in);
    assert!(did == expected_did, "derived did mismatch");

    let stored = AnchorImpl::chain(@state, did.clone());
    assert!(stored.len() == 3, "all three ops stored");
    let mut i = 0;
    while i < stored.len() {
        assert!(*stored.at(i).imported, "every imported op is settled");
        i += 1;
    }
}

#[test]
fn store_only_accepts_unverified_bytes() {
    // The defining v2 behavior: the contract does NOT validate. An op that would fail signature /
    // linkage checks is still STORED (the witness rejects it read-side; it never becomes a live
    // head). Here a genuine genesis is anchored, then arbitrary non-op bytes are appended — no
    // revert, and they land in the log verbatim.
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let garbage: ByteArray = "not-a-valid-plc-op";

    let mut state = contract_state_for_testing();
    let did = AnchorImpl::import_genesis(ref state, genesis.clone());
    AnchorImpl::submit_op(ref state, did.clone(), garbage.clone());

    let chain = AnchorImpl::chain(@state, did.clone());
    assert!(chain.len() == 2, "unverified op is stored, not rejected");
    assert!(stored_signed_eq(chain.at(1), @garbage), "garbage bytes stored verbatim");
}

#[test]
fn unknown_did_reads_empty() {
    let state = contract_state_for_testing();
    assert!(!AnchorImpl::is_anchored(@state, "did:plc:doesnotexist000000000"), "not anchored");
    assert!(
        AnchorImpl::chain(@state, "did:plc:doesnotexist000000000").len() == 0, "empty chain",
    );
}

#[test]
#[should_panic(expected: 'already-anchored')]
fn reimport_is_rejected() {
    let vectors = op_verify_vectors();
    let genesis = from_hex(vectors.at(ALICE_GENESIS).signed_drisl_hex);
    let mut state = contract_state_for_testing();
    let _ = AnchorImpl::import_genesis(ref state, genesis.clone());
    let _ = AnchorImpl::import_genesis(ref state, genesis.clone());
}

#[test]
#[should_panic(expected: 'empty-chain')]
fn import_rejects_empty_chain() {
    let mut state = contract_state_for_testing();
    let _ = AnchorImpl::import(ref state, array![]);
}

#[test]
#[should_panic(expected: 'did-not-anchored')]
fn submit_to_unknown_did_is_rejected() {
    let vectors = op_verify_vectors();
    let update = from_hex(vectors.at(ALICE_UPDATE).signed_drisl_hex);
    let mut state = contract_state_for_testing();
    AnchorImpl::submit_op(ref state, "did:plc:doesnotexist000000000", update);
}
