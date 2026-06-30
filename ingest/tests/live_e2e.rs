//! End-to-end test against a live `anchor` contract on Starknet.
//!
//! Drives a real genesis op from the conformance corpus through [`StarknetSink`] into the deployed
//! contract, then reads it back via the on-chain views. Proves the full off-chain → on-chain path:
//! canonical DRISL bytes → `ByteArray` calldata → `import_genesis` → state + commitment root.
//!
//! Gated by the `live` feature and `#[ignore]` — it needs network + a funded account. Run with:
//!
//! ```sh
//! source ~/.plc-anchor-rpc                       # STARKNET_RPC
//! export ANCHOR_CONTRACT_ADDRESS=0x...           # deployed anchor
//! export STARKNET_ACCOUNT_ADDRESS=0x...          # fee payer
//! export STARKNET_ACCOUNT_PRIVATE_KEY=0x...      # fee payer key (gas only, not PLC auth)
//! cargo test -p ingest --features live --test live_e2e -- --ignored --nocapture
//! ```
//!
//! Idempotent: if the corpus DID is already anchored (a prior run), it skips the submit and just
//! asserts the on-chain state.

#![cfg(feature = "live")]

use ingest::{Delta, StarknetConfig, StarknetSink};
use std::time::Duration;

const CORPUS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../conformance/vectors/plc-ops/corpus.json"
);

/// sha256("") — the empty-roster commitment root the contract returns before anything is anchored.
const EMPTY_ROOT_HEX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[test]
#[ignore = "needs a live contract + funded account (see module docs)"]
fn genesis_anchors_on_chain() {
    let raw = std::fs::read_to_string(CORPUS).expect("read corpus.json");
    let corpus: serde_json::Value = serde_json::from_str(&raw).expect("parse corpus.json");
    let entries = corpus.as_array().expect("corpus is an array");

    // The first genesis op (prev == null).
    let genesis = entries
        .iter()
        .find(|e| e["operation"]["prev"].is_null())
        .expect("a genesis entry");
    let did = genesis["did"].as_str().expect("did").to_string();
    let signed =
        hex::decode(genesis["drisl_hex"].as_str().expect("drisl_hex")).expect("decode drisl_hex");
    eprintln!("e2e: target DID {did} ({} signed bytes)", signed.len());

    let mut sink = StarknetSink::new(StarknetConfig::from_env().expect("env config"))
        .expect("connect to chain")
        .with_receipt_timeout(Duration::from_secs(300));

    if sink.is_anchored(&did).expect("is_anchored view") {
        eprintln!("e2e: {did} already anchored (prior run) — skipping submit, asserting state");
    } else {
        use ingest::AnchorSink;
        sink.apply(&Delta::Genesis {
            did: did.clone(),
            signed,
        })
        .expect("import_genesis");
    }

    // Assert the on-chain effects.
    assert!(
        sink.is_anchored(&did).expect("is_anchored view"),
        "DID must be anchored after import_genesis"
    );

    let head = sink
        .call_byte_array_view("head_cid", did.as_bytes())
        .expect("head_cid view");
    let head_cid = String::from_utf8(head).expect("head_cid is utf8");
    let expected_cid = genesis["cid"].as_str().expect("corpus cid");
    assert_eq!(
        head_cid, expected_cid,
        "head CID must match the corpus genesis CID"
    );
    eprintln!("e2e: head_cid = {head_cid} ✓ (matches corpus)");

    let root = sink
        .call_byte_array_view("tentative_root", &[])
        .expect("tentative_root view");
    assert_eq!(root.len(), 32, "root is a 32-byte sha256 digest");
    let root_hex = hex::encode(&root);
    assert_ne!(
        root_hex, EMPTY_ROOT_HEX,
        "tentative_root must change from sha256(\"\") once a DID is anchored"
    );
    eprintln!("e2e: tentative_root = {root_hex} ✓ (non-empty)");
}
