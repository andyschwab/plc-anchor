//! Where ops come from — the directory-export seam.
//!
//! [`OpSource::fetch`] returns the next page of [`ExportEntry`] after a cursor, mirroring the
//! directory's `?after=<createdAt>&count=<n>` contract. [`HttpExportSource`] is the live path
//! (any `plc.directory`-compatible mirror — Eurosky / microcosm, REFERENCE.md §7);
//! [`FixtureSource`] serves entries from memory so the pipeline is testable without a network.

use crate::export::{parse_jsonl, ExportEntry};
use anyhow::{Context, Result};

/// Upper bound on an HTTP response body we will buffer, in bytes. A single-DID audit log or one
/// `?count=` export page is far smaller; this only exists so a malicious mirror can't stream an
/// unbounded body to exhaust memory in the long-running indexer (SECURITY-TODO item 3). 32 MiB.
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// Fetch one DID's complete operation log from the directory's `/<did>/log/audit` endpoint — a
/// JSON array (not JSONL), ordered genesis-first, each element sharing the [`ExportEntry`] shape
/// (`did`/`operation`/`cid`/`nullified`/`createdAt`). This is the per-DID onboarding path: it
/// pulls exactly one DID's history in a single request instead of scanning the whole `/export`
/// firehose. Feed the result straight to [`crate::pipeline::process_batch`].
pub fn fetch_audit_log(base_url: &str, did: &str) -> Result<Vec<ExportEntry>> {
    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/{did}/log/audit");
    let body = ureq::Agent::new_with_defaults()
        .get(&url)
        .call()
        .with_context(|| format!("GET {url}"))?
        .body_mut()
        .with_config()
        .limit(MAX_BODY_BYTES)
        .read_to_string()
        .with_context(|| format!("read body of {url}"))?;
    serde_json::from_str(&body).with_context(|| format!("parse audit log for {did}"))
}

/// A paginated source of export entries, ordered by `createdAt` ascending.
pub trait OpSource {
    /// Fetch up to `count` entries with `createdAt` strictly after `after` (or from the start
    /// when `after` is `None`). An empty result means "caught up".
    fn fetch(&mut self, after: Option<&str>, count: usize) -> Result<Vec<ExportEntry>>;
}

/// The live directory/mirror source over `/export`.
pub struct HttpExportSource {
    base_url: String,
    agent: ureq::Agent,
}

impl HttpExportSource {
    /// Point at a mirror base URL, e.g. `https://plc.directory`.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            agent: ureq::Agent::new_with_defaults(),
        }
    }
}

impl OpSource for HttpExportSource {
    fn fetch(&mut self, after: Option<&str>, count: usize) -> Result<Vec<ExportEntry>> {
        let mut url = format!("{}/export?count={count}", self.base_url);
        if let Some(after) = after {
            // `after` is an ISO timestamp; percent-encoding the colons keeps the query valid.
            url.push_str("&after=");
            url.push_str(&encode_query_value(after));
        }
        let body = self
            .agent
            .get(&url)
            .call()
            .with_context(|| format!("GET {url}"))?
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_string()
            .with_context(|| format!("read body of {url}"))?;
        parse_jsonl(&body)
    }
}

/// Minimal percent-encoding for a query value (RFC 3986 unreserved kept; everything else
/// `%XX`). Enough for ISO-8601 `createdAt` cursors without pulling a URL crate.
fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// An in-memory source for tests and offline replay. Entries must be sorted by `createdAt`
/// ascending (as the directory serves them).
pub struct FixtureSource {
    entries: Vec<ExportEntry>,
}

impl FixtureSource {
    /// Build from entries already in `createdAt` order.
    pub fn new(entries: Vec<ExportEntry>) -> Self {
        Self { entries }
    }

    /// Build from a JSONL export body.
    pub fn from_jsonl(body: &str) -> Result<Self> {
        Ok(Self::new(parse_jsonl(body)?))
    }
}

impl OpSource for FixtureSource {
    fn fetch(&mut self, after: Option<&str>, count: usize) -> Result<Vec<ExportEntry>> {
        let page = self
            .entries
            .iter()
            .filter(|e| match after {
                Some(a) => e.created_at.as_str() > a,
                None => true,
            })
            .take(count)
            .cloned()
            .collect();
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(did: &str, created_at: &str) -> ExportEntry {
        ExportEntry {
            did: did.to_string(),
            operation: serde_json::json!({ "type": "plc_operation", "prev": null }),
            cid: "bafy".to_string(),
            nullified: false,
            created_at: created_at.to_string(),
        }
    }

    #[test]
    fn fixture_paginates_after_cursor() {
        let mut src = FixtureSource::new(vec![
            entry("did:plc:a", "2023-01-01T00:00:00Z"),
            entry("did:plc:b", "2023-01-02T00:00:00Z"),
            entry("did:plc:c", "2023-01-03T00:00:00Z"),
        ]);

        let first = src.fetch(None, 2).unwrap();
        assert_eq!(first.len(), 2);
        let last = first.last().unwrap().created_at.clone();

        let next = src.fetch(Some(&last), 2).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].did, "did:plc:c");

        let done = src.fetch(Some(&next[0].created_at), 2).unwrap();
        assert!(done.is_empty());
    }

    #[test]
    fn query_encoding_escapes_colons() {
        assert_eq!(
            encode_query_value("2023-01-01T00:00:00.000Z"),
            "2023-01-01T00%3A00%3A00.000Z"
        );
    }
}
