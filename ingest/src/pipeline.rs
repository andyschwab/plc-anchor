//! The indexing pipeline: export entries in, anchor deltas out.
//!
//! For each entry the pipeline: skips DIDs not in the anchor set; skips ops the directory
//! already marked nullified (the contract reconstructs recovery itself from the nullifying op,
//! REFERENCE.md §4 — replaying a nullified branch is needless work); re-encodes the op to
//! canonical DRISL and **asserts the result hashes to the directory's published CID** before
//! submitting; classifies genesis vs. append; and advances the cursor. The CID self-check is
//! the integrity gate — we never anchor bytes that disagree with the directory.

use crate::anchored::AnchorSet;
use crate::cursor::Cursor;
use crate::export::ExportEntry;
use crate::reencode::{is_genesis, op_cid, signed_op_bytes};
use crate::sink::{AnchorSink, Delta};
use crate::source::OpSource;
use anyhow::{bail, Result};

/// Per-run counters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    /// Entries examined.
    pub scanned: usize,
    /// Entries belonging to an anchored DID.
    pub matched: usize,
    /// Genesis deltas submitted.
    pub genesis: usize,
    /// Append deltas submitted.
    pub appends: usize,
    /// Anchored entries skipped because the directory marked them nullified.
    pub skipped_nullified: usize,
}

impl Stats {
    /// Total deltas submitted this run.
    pub fn submitted(&self) -> usize {
        self.genesis + self.appends
    }

    fn merge(&mut self, other: &Stats) {
        self.scanned += other.scanned;
        self.matched += other.matched;
        self.genesis += other.genesis;
        self.appends += other.appends;
        self.skipped_nullified += other.skipped_nullified;
    }
}

/// Process one batch of (already-fetched) entries against the anchor set, submitting deltas to
/// the sink and advancing `cursor` past every entry examined. Returns this batch's stats.
///
/// The cursor advances over *all* entries (anchored or not) so resumption never re-scans, but
/// it advances only after an entry is fully handled — a re-encode/CID failure stops the batch
/// at the offending op so it can be investigated, not silently skipped.
pub fn process_batch(
    entries: &[ExportEntry],
    anchor_set: &AnchorSet,
    sink: &mut dyn AnchorSink,
    cursor: &mut Cursor,
) -> Result<Stats> {
    let mut stats = Stats::default();
    for entry in entries {
        stats.scanned += 1;

        if anchor_set.contains(&entry.did) {
            stats.matched += 1;
            if entry.nullified {
                stats.skipped_nullified += 1;
            } else {
                submit_entry(entry, sink, &mut stats)?;
            }
        }

        cursor.advance(&entry.created_at);
    }
    Ok(stats)
}

/// Re-encode an op to canonical DRISL and assert it hashes to the directory's published CID — the
/// integrity gate (REFERENCE.md §3): we never anchor bytes that disagree with the directory.
/// Returns the canonical signed bytes.
fn signed_checked(entry: &ExportEntry) -> Result<Vec<u8>> {
    let signed = signed_op_bytes(&entry.operation)?;
    let cid = op_cid(&signed);
    if cid != entry.cid {
        bail!(
            "re-encoded CID {cid} != directory CID {} for {} — refusing to submit",
            entry.cid,
            entry.did
        );
    }
    Ok(signed)
}

fn submit_entry(entry: &ExportEntry, sink: &mut dyn AnchorSink, stats: &mut Stats) -> Result<()> {
    let signed = signed_checked(entry)?;

    let delta = if is_genesis(&entry.operation) {
        stats.genesis += 1;
        Delta::Genesis {
            did: entry.did.clone(),
            signed,
        }
    } else {
        stats.appends += 1;
        Delta::Append {
            did: entry.did.clone(),
            signed,
        }
    };
    sink.apply(&delta)
}

/// Onboard a DID's existing history as one **settled** `import` chain (SECURITY-TODO 4a).
///
/// This is the onboarding path (single-DID mode). It filters `entries` to `did`'s resolved live
/// chain — dropping directory-nullified branches, so what remains links genesis → … → head as pure
/// appends — CID-checks every op (the integrity gate), and emits a single [`Delta::Import`]. The
/// cursor advances past every entry examined.
///
/// Onboarding via `import` rather than op-by-op `submit_op` is what marks the backfilled history
/// **settled** on-chain. The contract stamps imported ops with the import block time and forbids a
/// recovery from nullifying them, so a *rotated-out* higher-priority key cannot re-open a
/// long-closed 72h recovery window and capture the DID (SECURITY-TODO 4a). `submit_op` is reserved
/// for genuinely-new ops observed ~live while tailing an already-onboarded DID, whose block-time
/// stamp approximates their real authored time.
pub fn onboard_via_import(
    entries: &[ExportEntry],
    did: &str,
    sink: &mut dyn AnchorSink,
    cursor: &mut Cursor,
) -> Result<Stats> {
    let mut stats = Stats::default();
    let mut ops: Vec<Vec<u8>> = Vec::new();
    for entry in entries {
        stats.scanned += 1;
        if entry.did == did {
            stats.matched += 1;
            if entry.nullified {
                stats.skipped_nullified += 1;
            } else {
                if ops.is_empty() && !is_genesis(&entry.operation) {
                    bail!(
                        "first live op for {did} is not a genesis — refusing to import a partial \
                         or forked history"
                    );
                }
                ops.push(signed_checked(entry)?);
            }
        }
        cursor.advance(&entry.created_at);
    }
    if ops.is_empty() {
        bail!("no live ops for {did} — nothing to import");
    }
    stats.genesis = 1;
    stats.appends = ops.len() - 1;
    sink.apply(&Delta::Import {
        did: did.to_string(),
        ops,
    })?;
    Ok(stats)
}

/// A driver tying a source, an anchor set, and a sink together with a resumable cursor.
pub struct Indexer<S: OpSource, K: AnchorSink> {
    source: S,
    anchor_set: AnchorSet,
    sink: K,
    cursor: Cursor,
    page_size: usize,
}

impl<S: OpSource, K: AnchorSink> Indexer<S, K> {
    /// Default page size for `/export` fetches (the directory caps a page at 1000).
    pub const DEFAULT_PAGE_SIZE: usize = 1000;

    /// Build a driver. Resume from `cursor` (use [`Cursor::genesis`] to start from the top).
    pub fn new(source: S, anchor_set: AnchorSet, sink: K, cursor: Cursor) -> Self {
        Self {
            source,
            anchor_set,
            sink,
            cursor,
            page_size: Self::DEFAULT_PAGE_SIZE,
        }
    }

    /// Override the page size (mainly for tests).
    pub fn with_page_size(mut self, page_size: usize) -> Self {
        self.page_size = page_size.max(1);
        self
    }

    /// The current cursor (persist this between runs).
    pub fn cursor(&self) -> &Cursor {
        &self.cursor
    }

    /// Borrow the sink (e.g. to inspect a [`DryRunSink`](crate::sink::DryRunSink)).
    pub fn sink(&self) -> &K {
        &self.sink
    }

    /// Fetch and process one page. Returns the page's stats; an empty page (stats.scanned == 0)
    /// means caught up.
    pub fn run_once(&mut self) -> Result<Stats> {
        let entries = self
            .source
            .fetch(self.cursor.after.as_deref(), self.page_size)?;
        process_batch(&entries, &self.anchor_set, &mut self.sink, &mut self.cursor)
    }

    /// Drain the source page by page until caught up, accumulating stats. This is the backfill
    /// / cron shape; continuous tailing (re-poll on an interval, or the `/export/stream`
    /// websocket) sits on top of `run_once` and is left to the binary / a follow-up.
    pub fn run_to_idle(&mut self) -> Result<Stats> {
        let mut total = Stats::default();
        loop {
            let batch = self.run_once()?;
            if batch.scanned == 0 {
                break;
            }
            total.merge(&batch);
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sink::DryRunSink;
    use crate::source::FixtureSource;

    #[derive(serde::Deserialize)]
    struct CorpusEntry {
        did: String,
        operation: serde_json::Value,
        cid: String,
    }

    /// Turn the verification corpus into a synthetic export stream: assign increasing
    /// `createdAt`s in corpus order so the fixture paginates deterministically. The ops are
    /// independent fixtures (not one real chain), which is fine — the pipeline routes each by
    /// its own `prev`, and the sink is a recorder.
    fn corpus_entries() -> Vec<ExportEntry> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/vectors/plc-ops/corpus.json"
        );
        let raw = std::fs::read_to_string(path).expect("read corpus.json");
        let corpus: Vec<CorpusEntry> = serde_json::from_str(&raw).expect("parse corpus.json");
        corpus
            .into_iter()
            .enumerate()
            .map(|(i, c)| ExportEntry {
                did: c.did,
                operation: c.operation,
                cid: c.cid,
                nullified: false,
                created_at: format!("2023-01-{:02}T00:00:00Z", i + 1),
            })
            .collect()
    }

    // The corpus contains a real genesis→update→tombstone chain for one DID (entries 0, 4, 5),
    // plus four standalone genesis ops. `chain_did` is that 3-op DID.
    fn chain_did(entries: &[ExportEntry]) -> String {
        entries[0].did.clone()
    }

    #[test]
    fn anchors_only_matched_dids_and_advances_cursor() {
        let entries = corpus_entries();
        let did = chain_did(&entries);
        let anchor_set = AnchorSet::from_iter_dids([did.clone()]);
        let mut sink = DryRunSink::new();
        let mut cursor = Cursor::genesis();

        let stats = process_batch(&entries, &anchor_set, &mut sink, &mut cursor).unwrap();

        assert_eq!(stats.scanned, entries.len());
        // genesis + update + tombstone for the one anchored DID; the other DIDs stream past
        assert_eq!(stats.matched, 3);
        assert_eq!(stats.genesis, 1);
        assert_eq!(stats.appends, 2);
        assert_eq!(stats.submitted(), 3);
        assert!(sink.applied.iter().all(|d| d.did() == did));
        // first op is the genesis (prev: null), the rest are appends
        assert!(matches!(sink.applied[0], Delta::Genesis { .. }));
        assert!(matches!(sink.applied[1], Delta::Append { .. }));
        assert!(matches!(sink.applied[2], Delta::Append { .. }));
        // cursor advanced past the whole batch, anchored or not
        assert_eq!(
            cursor.after.as_deref(),
            Some(entries.last().unwrap().created_at.as_str())
        );
    }

    #[test]
    fn skips_nullified_entries() {
        let mut entries = corpus_entries();
        let did = chain_did(&entries);
        // mark the genesis nullified; the two appends still flow
        entries[0].nullified = true;
        let anchor_set = AnchorSet::from_iter_dids([did]);
        let mut sink = DryRunSink::new();
        let mut cursor = Cursor::genesis();

        let stats = process_batch(&entries, &anchor_set, &mut sink, &mut cursor).unwrap();

        assert_eq!(stats.matched, 3);
        assert_eq!(stats.skipped_nullified, 1);
        assert_eq!(stats.submitted(), 2);
        assert_eq!(sink.applied.len(), 2);
    }

    #[test]
    fn rejects_cid_mismatch_without_submitting() {
        let mut entries = corpus_entries();
        let did = entries[0].did.clone();
        entries[0].cid = "bafyreiThisIsNotTheRealCid".to_string();
        let anchor_set = AnchorSet::from_iter_dids([did]);
        let mut sink = DryRunSink::new();
        let mut cursor = Cursor::genesis();

        let err = process_batch(&entries, &anchor_set, &mut sink, &mut cursor).unwrap_err();
        assert!(err.to_string().contains("refusing to submit"), "got: {err}");
        assert!(sink.applied.is_empty());
        // stopped at the offending op — cursor did not advance past it
        assert_eq!(cursor.after, None);
    }

    // ── Onboarding via `import` (settled history — SECURITY-TODO 4a) ──

    #[test]
    fn onboard_via_import_emits_one_settled_chain() {
        // The DID's whole resolved history goes in as a SINGLE Import delta (not op-by-op
        // Genesis/Append), so the contract marks every op settled and a rotated-out key can't
        // recover-nullify it (SECURITY-TODO 4a). Contrast `anchors_only_matched_dids_*`, which
        // exercises the firehose per-op path.
        let entries = corpus_entries();
        let did = chain_did(&entries);
        let mut sink = DryRunSink::new();
        let mut cursor = Cursor::genesis();

        let stats = onboard_via_import(&entries, &did, &mut sink, &mut cursor).unwrap();

        assert_eq!(stats.scanned, entries.len());
        assert_eq!(
            stats.matched, 3,
            "genesis + update + tombstone for the chain DID"
        );
        assert_eq!(stats.genesis, 1);
        assert_eq!(stats.appends, 2);
        // Exactly one delta: the whole chain, imported as settled.
        assert_eq!(sink.applied.len(), 1);
        match &sink.applied[0] {
            Delta::Import { did: d, ops } => {
                assert_eq!(d, &did);
                assert_eq!(ops.len(), 3, "genesis + 2 successors");
            }
            other => panic!("expected a single Import delta, got {other:?}"),
        }
        // cursor advanced past the whole batch
        assert_eq!(
            cursor.after.as_deref(),
            Some(entries.last().unwrap().created_at.as_str())
        );
    }

    #[test]
    fn onboard_via_import_drops_nullified_branches() {
        // A directory-nullified entry is not part of the resolved live chain, so it never enters
        // the import. (The chain DID's ops are all live; nullify the update to prove the filter.)
        let mut entries = corpus_entries();
        let did = chain_did(&entries);
        // entry index 4 is the chain DID's update op.
        let update_idx = entries
            .iter()
            .position(|e| e.did == did && !is_genesis(&e.operation));
        entries[update_idx.unwrap()].nullified = true;
        let mut sink = DryRunSink::new();
        let mut cursor = Cursor::genesis();

        let stats = onboard_via_import(&entries, &did, &mut sink, &mut cursor).unwrap();

        assert_eq!(stats.skipped_nullified, 1);
        match &sink.applied[0] {
            Delta::Import { ops, .. } => assert_eq!(ops.len(), 2, "the nullified op is excluded"),
            other => panic!("expected Import, got {other:?}"),
        }
    }

    #[test]
    fn onboard_via_import_rejects_cid_mismatch() {
        let mut entries = corpus_entries();
        let did = chain_did(&entries);
        entries[0].cid = "bafyreiThisIsNotTheRealCid".to_string();
        let mut sink = DryRunSink::new();
        let mut cursor = Cursor::genesis();

        let err = onboard_via_import(&entries, &did, &mut sink, &mut cursor).unwrap_err();
        assert!(err.to_string().contains("refusing to submit"), "got: {err}");
        assert!(sink.applied.is_empty());
    }

    #[test]
    fn indexer_drains_source_to_idle() {
        let entries = corpus_entries();
        let dids: Vec<String> = entries.iter().map(|e| e.did.clone()).collect();
        let anchor_set = AnchorSet::from_iter_dids(dids);
        let source = FixtureSource::new(entries.clone());
        let mut indexer = Indexer::new(source, anchor_set, DryRunSink::new(), Cursor::genesis())
            .with_page_size(2);

        let stats = indexer.run_to_idle().unwrap();

        assert_eq!(stats.scanned, entries.len());
        assert_eq!(stats.matched, entries.len());
        // every corpus op re-encodes and passes its CID self-check, so all are submitted
        assert_eq!(stats.submitted(), entries.len());
        assert_eq!(indexer.sink().applied.len(), entries.len());
        assert_eq!(
            indexer.cursor().after.as_deref(),
            Some(entries.last().unwrap().created_at.as_str())
        );
    }
}
