//! The PLC directory export record.
//!
//! `plc.directory/export` (and Eurosky / microcosm mirrors) serve the operation log as
//! newline-delimited JSON, ordered by `createdAt` ascending and paginated with
//! `?after=<createdAt>&count=<n>`. Each line is one [`ExportEntry`].

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// One operation as served by the directory's `/export` endpoint.
///
/// `operation` is kept as raw JSON: it is the directory's representation, re-encoded to
/// canonical DRISL only at submission time (see [`crate::reencode`]). `cid` is the
/// directory's published CID for the signed op — the ground truth the re-encoding is checked
/// against before anything is submitted.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ExportEntry {
    /// The DID this operation belongs to (`did:plc:...`).
    pub did: String,
    /// The signed PLC operation as directory-served JSON (includes the `sig` field).
    pub operation: serde_json::Value,
    /// The directory's CIDv1 (base32) for the signed op.
    pub cid: String,
    /// Whether the directory has marked this op nullified by a later recovery.
    #[serde(default)]
    pub nullified: bool,
    /// Directory-assigned timestamp; also the pagination cursor. Not part of the signed op
    /// (REFERENCE.md §1) — used only for ordering and resumption, never for verification.
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Parse the directory export's JSONL body into entries, skipping blank lines.
pub fn parse_jsonl(body: &str) -> Result<Vec<ExportEntry>> {
    body.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(i, line)| {
            serde_json::from_str::<ExportEntry>(line)
                .with_context(|| format!("malformed export entry on line {}", i + 1))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_jsonl_and_skips_blanks() {
        let body = "\
{\"did\":\"did:plc:aaa\",\"operation\":{\"type\":\"plc_operation\",\"prev\":null},\"cid\":\"bafy1\",\"createdAt\":\"2023-01-01T00:00:00Z\"}

{\"did\":\"did:plc:bbb\",\"operation\":{\"type\":\"plc_tombstone\",\"prev\":\"bafyx\"},\"cid\":\"bafy2\",\"nullified\":true,\"createdAt\":\"2023-01-02T00:00:00Z\"}
";
        let entries = parse_jsonl(body).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].did, "did:plc:aaa");
        assert!(!entries[0].nullified);
        assert_eq!(entries[1].did, "did:plc:bbb");
        assert!(entries[1].nullified);
        assert_eq!(entries[1].created_at, "2023-01-02T00:00:00Z");
    }

    #[test]
    fn reports_the_offending_line() {
        let body = "{\"did\":\"did:plc:aaa\",\"operation\":{},\"cid\":\"c\",\"createdAt\":\"t\"}\nnot json\n";
        let err = parse_jsonl(body).unwrap_err().to_string();
        assert!(err.contains("line 2"), "got: {err}");
    }
}
