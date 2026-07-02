//! Re-encode a directory-served PLC operation to its canonical DRISL signed-op bytes.
//!
//! **Consensus-critical (REFERENCE.md §5).** The contract verifies the *bytes* of the signed
//! op; the directory serves *JSON*. To submit a delta we must reproduce the exact dCBOR42
//! bytes whose sha-256 is the directory's published CID — byte-for-byte, or the CID self-check
//! in [`crate::pipeline`] rejects the op. The encoding authority is `atproto-dasl` (the same
//! Rust DRISL reference the `oracle` differential check uses); this module only maps PLC's
//! JSON shape onto it and is gated against the vendored corpus (7 real ops, genesis through
//! tombstone + legacy create).
//!
//! **PLC has no IPLD links.** Although DRISL supports dCBOR tag-42 CID links, a PLC op does
//! not use them: `prev` is encoded as the **base32 CID string** (or null for genesis), the
//! same form the directory serves — verified byte-for-byte by the corpus gate below. So an op
//! is a plain JSON→IPLD mapping. (`prev` linkage is then a string-equality check the contract
//! does separately, REFERENCE.md §5 / `plc_core::link`.) The mapping is strict: PLC ops carry
//! only strings, maps, arrays, and null, so a number means the input is not a PLC op.

use anyhow::{bail, Context, Result};
use atproto_dasl::cid::{compute_cid, Cid};
use atproto_dasl::{to_vec, Ipld};
use std::collections::BTreeMap;

/// Maximum JSON nesting depth accepted by [`json_to_ipld`]. A legitimate PLC op nests only a
/// few levels (op → `services`/`verificationMethods` map → string values); 64 is far above any
/// real op but low enough that a maliciously deep payload from a mirror cannot stack-overflow
/// the long-running indexer before we reject it (SECURITY-TODO item 3).
const MAX_DEPTH: usize = 64;

/// Re-encode a PLC operation (directory JSON) to its canonical DRISL signed-op bytes.
pub fn signed_op_bytes(operation: &serde_json::Value) -> Result<Vec<u8>> {
    if !operation.is_object() {
        bail!("operation must be a JSON object");
    }
    let ipld = json_to_ipld(operation, MAX_DEPTH)?;
    to_vec(&ipld).context("DRISL encoding failed")
}

/// The CIDv1 / dag-cbor / sha2-256 base32 string for signed-op bytes — the blessed set
/// (REFERENCE.md §5). This is what the directory publishes per op; the pipeline asserts it
/// matches before submitting.
pub fn op_cid(signed_bytes: &[u8]) -> String {
    Cid::new(compute_cid(signed_bytes)).to_string()
}

/// Whether an operation is a genesis (creates the DID) vs. an append. Genesis ⇔ `prev` is
/// null/absent (REFERENCE.md §5); routes the delta to `import_genesis` vs. `submit_op`.
pub fn is_genesis(operation: &serde_json::Value) -> bool {
    matches!(operation.get("prev"), None | Some(serde_json::Value::Null))
}

/// JSON→IPLD for a PLC op. Strict: PLC ops carry only strings, maps, arrays, and null (no
/// numbers/floats — `prev` is a base32 string, not a link), so a number is a sign the input is
/// not a PLC op.
fn json_to_ipld(value: &serde_json::Value, depth_budget: usize) -> Result<Ipld> {
    use serde_json::Value;
    // Charge one level for every container we descend into; refuse before recursing deeper so a
    // pathologically nested payload can't blow the stack (SECURITY-TODO item 3).
    let child_budget = match value {
        Value::Array(_) | Value::Object(_) => depth_budget
            .checked_sub(1)
            .ok_or_else(|| anyhow::anyhow!("PLC operation nests deeper than {MAX_DEPTH} levels"))?,
        _ => depth_budget,
    };
    Ok(match value {
        Value::Null => Ipld::Null,
        Value::Bool(b) => Ipld::Bool(*b),
        Value::String(s) => Ipld::String(s.clone()),
        Value::Array(items) => Ipld::List(
            items
                .iter()
                .map(|v| json_to_ipld(v, child_budget))
                .collect::<Result<_>>()?,
        ),
        Value::Object(obj) => {
            let mut map = BTreeMap::new();
            for (k, v) in obj {
                map.insert(k.clone(), json_to_ipld(v, child_budget)?);
            }
            Ipld::Map(map)
        }
        Value::Number(n) => bail!("unexpected number {n} in PLC operation (no numeric fields)"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(serde::Deserialize)]
    struct CorpusEntry {
        label: String,
        did: String,
        operation: serde_json::Value,
        cid: String,
        drisl_hex: String,
    }

    fn corpus() -> Vec<CorpusEntry> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/vectors/plc-ops/corpus.json"
        );
        let raw = std::fs::read_to_string(path).expect("read corpus.json");
        serde_json::from_str(&raw).expect("parse corpus.json")
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Differential gate: every real-structure corpus op must re-encode to the byte-identical
    /// signed DRISL `@did-plc/lib` / `@ipld/dag-cbor` produced, and to the same CID. Covers
    /// genesis (k256, p256-high-S, mixed-key, two-rotation), update, tombstone, legacy create
    /// — including the `prev`-as-string path.
    #[test]
    fn reencodes_corpus_byte_identical() {
        let corpus = corpus();
        assert!(corpus.len() >= 7, "corpus should have the 7-op set");
        for entry in corpus {
            let bytes = signed_op_bytes(&entry.operation)
                .unwrap_or_else(|e| panic!("encode {}: {e}", entry.label));
            assert_eq!(
                to_hex(&bytes),
                entry.drisl_hex,
                "DRISL bytes mismatch for {}",
                entry.label
            );
            assert_eq!(
                op_cid(&bytes),
                entry.cid,
                "CID mismatch for {} ({})",
                entry.label,
                entry.did
            );
        }
    }

    #[test]
    fn classifies_genesis_vs_append() {
        for entry in corpus() {
            let prev = entry.operation.get("prev");
            let expect_genesis = matches!(prev, None | Some(serde_json::Value::Null));
            assert_eq!(
                is_genesis(&entry.operation),
                expect_genesis,
                "genesis classification for {}",
                entry.label
            );
        }
    }

    #[test]
    fn rejects_numeric_fields() {
        let op = json!({ "type": "plc_operation", "prev": null, "weird": 7 });
        assert!(signed_op_bytes(&op).is_err());
    }

    #[test]
    fn rejects_non_object() {
        assert!(signed_op_bytes(&json!("just a string")).is_err());
    }

    #[test]
    fn rejects_pathologically_deep_nesting() {
        // Nest arrays well past MAX_DEPTH — must be rejected, not stack-overflow.
        let mut deep = json!("leaf");
        for _ in 0..(MAX_DEPTH + 10) {
            deep = serde_json::Value::Array(vec![deep]);
        }
        let op = json!({ "type": "plc_operation", "prev": null, "deep": deep });
        let err = signed_op_bytes(&op).expect_err("deep nesting must be rejected");
        assert!(err.to_string().contains("nests deeper"), "got: {err}");
    }

    #[test]
    fn accepts_nesting_within_limit() {
        // A handful of levels (realistic PLC shape) must still encode fine.
        let mut ok = json!("leaf");
        for _ in 0..8 {
            ok = serde_json::Value::Array(vec![ok]);
        }
        let op = json!({ "type": "plc_operation", "prev": null, "nested": ok });
        assert!(signed_op_bytes(&op).is_ok());
    }
}
