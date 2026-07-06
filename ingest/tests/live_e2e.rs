//! End-to-end test against a live `anchor` contract on Starknet.
//!
//! Drives a real genesis op from the conformance corpus through [`StarknetSink`] into the deployed
//! contract, then reads the raw op log back via the `chain` view. Proves the full off-chain →
//! on-chain path under verify-on-read: canonical DRISL bytes → `ByteArray` calldata →
//! `import_genesis` → stored **byte-identical** on-chain (the non-equivocation the witness then
//! validates read-side).
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
    let expected = signed.clone();
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

    // Verify-on-read: read the raw op log and confirm the stored genesis bytes are byte-identical
    // to what we submitted (non-equivocation), settled (imported), and block-time stamped.
    let chain = sink.call_chain(&did).expect("chain view");
    assert_eq!(chain.len(), 1, "exactly one op stored after genesis import");
    assert_eq!(
        chain[0].signed, expected,
        "stored genesis bytes must be byte-identical to the submitted DRISL"
    );
    assert!(
        chain[0].imported,
        "genesis import is settled (imported: true)"
    );
    assert!(chain[0].created_at > 0, "op carries a block-time stamp");
    eprintln!(
        "e2e: chain[0] {} bytes, imported={}, created_at={} ✓ (byte-identical to corpus)",
        chain[0].signed.len(),
        chain[0].imported,
        chain[0].created_at
    );
}
