//! Firehose sync indexer (REFERENCE.md §3, build-order item 4).
//!
//! Re-encodes each op to its canonical DRISL bytes, checks it against the directory's published
//! CID, and either logs the delta it would anchor (default, [`DryRunSink`]) or submits it to a
//! live `anchor` contract (`--submit`, the [`ingest::StarknetSink`] — requires `--features live`
//! and the env config it documents). Two modes:
//!
//! - `--roster <dids.txt>` — firehose: scan `/export` for the DIDs in a roster (backfill / cron).
//! - `--did <did:plc:...>` — single DID: pull just that DID's `/<did>/log/audit` and onboard it
//!   in one request (no firehose scan) — the practical way to anchor one existing DID.
//!
//! ```text
//! ingest --roster <dids.txt> [--source https://plc.directory] [--cursor <cursor.json>] [--count 1000] [--submit]
//! ingest --did <did:plc:...>  [--source https://plc.directory] [--submit]
//! ```

use anyhow::{Context, Result};
use ingest::{
    AnchorSet, AnchorSink, Cursor, DryRunSink, HttpExportSource, Indexer, OpSource, Stats,
};

const DEFAULT_SOURCE: &str = "https://plc.directory";

struct Args {
    /// Anchored-DID roster file (firehose mode). Mutually exclusive with `did`.
    roster: Option<String>,
    /// A single DID to onboard via its audit log (single-DID mode). Mutually exclusive with `roster`.
    did: Option<String>,
    source: String,
    cursor_path: Option<String>,
    count: usize,
    submit: bool,
}

fn parse_args() -> Result<Option<Args>> {
    let mut roster = None;
    let mut did = None;
    let mut source = DEFAULT_SOURCE.to_string();
    let mut cursor_path = None;
    let mut count = Indexer::<HttpExportSource, DryRunSink>::DEFAULT_PAGE_SIZE;
    let mut submit = false;

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "-h" | "--help" => return Ok(None),
            "--roster" => roster = Some(next_value(&mut args, "--roster")?),
            "--did" => did = Some(next_value(&mut args, "--did")?),
            "--source" => source = next_value(&mut args, "--source")?,
            "--cursor" => cursor_path = Some(next_value(&mut args, "--cursor")?),
            "--submit" => submit = true,
            "--count" => {
                count = next_value(&mut args, "--count")?
                    .parse()
                    .context("--count must be a positive integer")?;
            }
            other => anyhow::bail!("unknown argument {other:?} (try --help)"),
        }
    }

    match (&roster, &did) {
        (None, None) => return Ok(None),
        (Some(_), Some(_)) => anyhow::bail!("--roster and --did are mutually exclusive"),
        _ => {}
    }
    Ok(Some(Args {
        roster,
        did,
        source,
        cursor_path,
        count,
        submit,
    }))
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    args.next()
        .with_context(|| format!("{flag} requires a value"))
}

fn usage() {
    eprintln!(
        "ingest — PLC firehose sync indexer (REFERENCE.md §3, item 4)\n\n\
         USAGE:\n  \
         ingest --roster <dids.txt> [--source <url>] [--cursor <path>] [--count <n>] [--submit]\n  \
         ingest --did <did:plc:...> [--source <url>] [--submit]\n\n\
         MODE (pick one):\n  \
         --roster <path>   firehose: scan /export for the DIDs in this roster (one per line; # comments)\n  \
         --did <did>       single DID: pull just this DID's /<did>/log/audit and onboard it (no scan)\n\n\
         OPTIONS:\n  \
         --source <url>    PLC directory / mirror base URL [default: {DEFAULT_SOURCE}]\n  \
         --cursor <path>   (firehose) resume/persist the export cursor as JSON [default: in-memory]\n  \
         --count <n>       (firehose) export page size [default: 1000]\n  \
         --submit          submit deltas on-chain via StarknetSink (needs --features live + env config);\n  \
         \x20                without it, runs a dry-run backfill (deltas are logged, not submitted)."
    );
}

/// Shared run: drive the indexer to idle and persist the cursor. Generic over the sink so the
/// dry-run and live paths share the loop.
fn run_to_idle<S: OpSource, K: AnchorSink>(
    source: S,
    anchor_set: AnchorSet,
    sink: K,
    cursor: Cursor,
    count: usize,
    cursor_path: Option<&str>,
) -> Result<(Stats, Indexer<S, K>)> {
    let mut indexer = Indexer::new(source, anchor_set, sink, cursor).with_page_size(count);
    let stats = indexer.run_to_idle()?;
    if let Some(path) = cursor_path {
        indexer.cursor().save(path)?;
    }
    Ok((stats, indexer))
}

fn print_stats(stats: &Stats) {
    eprintln!(
        "ingest: scanned {}, matched {}, submitted {} ({} genesis / {} append), skipped {} nullified",
        stats.scanned,
        stats.matched,
        stats.submitted(),
        stats.genesis,
        stats.appends,
        stats.skipped_nullified,
    );
}

fn main() -> Result<()> {
    let Some(args) = parse_args()? else {
        usage();
        return Ok(());
    };

    // Single-DID mode: pull one DID's audit log and onboard it directly.
    if let Some(did) = &args.did {
        return run_single_did(did, &args.source, args.submit);
    }

    let roster = args
        .roster
        .as_deref()
        .expect("parse_args guarantees a mode");
    let anchor_set = AnchorSet::load(roster)?;
    if anchor_set.is_empty() {
        eprintln!("ingest: roster {roster} is empty — nothing to anchor");
        return Ok(());
    }

    let cursor = match &args.cursor_path {
        Some(path) => Cursor::load(path)?,
        None => Cursor::genesis(),
    };

    eprintln!(
        "ingest: anchoring {} DID(s) from {} (cursor: {}){}",
        anchor_set.len(),
        args.source,
        cursor.after.as_deref().unwrap_or("<genesis>"),
        if args.submit {
            " [SUBMIT]"
        } else {
            " [dry-run]"
        },
    );

    let source = HttpExportSource::new(&args.source);

    if args.submit {
        submit_run(
            source,
            anchor_set,
            cursor,
            args.count,
            args.cursor_path.as_deref(),
        )
    } else {
        let (stats, indexer) = run_to_idle(
            source,
            anchor_set,
            DryRunSink::new(),
            cursor,
            args.count,
            args.cursor_path.as_deref(),
        )?;
        for delta in &indexer.sink().applied {
            let (kind, did) = match delta {
                ingest::Delta::Genesis { did, .. } => ("import_genesis", did),
                ingest::Delta::Append { did, .. } => ("submit_op", did),
            };
            println!("would {kind}: {did}");
        }
        print_stats(&stats);
        Ok(())
    }
}

#[cfg(feature = "live")]
fn submit_run(
    source: HttpExportSource,
    anchor_set: AnchorSet,
    cursor: Cursor,
    count: usize,
    cursor_path: Option<&str>,
) -> Result<()> {
    use ingest::{StarknetConfig, StarknetSink};
    let sink = StarknetSink::new(StarknetConfig::from_env()?)?;
    eprintln!("ingest: submitting to anchor {:#x}", sink.contract());
    let (stats, _indexer) = run_to_idle(source, anchor_set, sink, cursor, count, cursor_path)?;
    print_stats(&stats);
    Ok(())
}

#[cfg(not(feature = "live"))]
fn submit_run(
    _source: HttpExportSource,
    _anchor_set: AnchorSet,
    _cursor: Cursor,
    _count: usize,
    _cursor_path: Option<&str>,
) -> Result<()> {
    anyhow::bail!(
        "--submit requires the `live` feature: rebuild with `cargo build --features live`"
    )
}

/// Single-DID mode: fetch one DID's `/<did>/log/audit` and onboard it through the same pipeline
/// (genesis → `import_genesis`, each canonical successor → `submit_op`; directory-nullified ops
/// skipped; each op CID-checked before submit), dry-run or on-chain.
fn run_single_did(did: &str, source: &str, submit: bool) -> Result<()> {
    let entries = ingest::fetch_audit_log(source, did)?;
    eprintln!(
        "ingest: fetched {} op(s) for {did} from {source} [{}]",
        entries.len(),
        if submit { "SUBMIT" } else { "dry-run" }
    );
    if entries.is_empty() {
        anyhow::bail!("no ops returned for {did} — is the DID correct and known to {source}?");
    }
    let anchor_set = AnchorSet::from_iter_dids([did.to_string()]);
    let mut cursor = Cursor::genesis();

    if submit {
        single_did_submit(did, &entries, &anchor_set, &mut cursor)
    } else {
        let mut sink = DryRunSink::new();
        let stats = ingest::process_batch(&entries, &anchor_set, &mut sink, &mut cursor)?;
        for delta in &sink.applied {
            let (kind, d) = match delta {
                ingest::Delta::Genesis { did, .. } => ("import_genesis", did),
                ingest::Delta::Append { did, .. } => ("submit_op", did),
            };
            println!("would {kind}: {d}");
        }
        print_stats(&stats);
        Ok(())
    }
}

#[cfg(feature = "live")]
fn single_did_submit(
    did: &str,
    entries: &[ingest::ExportEntry],
    anchor_set: &AnchorSet,
    cursor: &mut Cursor,
) -> Result<()> {
    use ingest::{StarknetConfig, StarknetSink};
    let mut sink = StarknetSink::new(StarknetConfig::from_env()?)?;
    eprintln!("ingest: submitting to anchor {:#x}", sink.contract());
    let stats = ingest::process_batch(entries, anchor_set, &mut sink, cursor)?;
    print_stats(&stats);
    // Confirm the on-chain effect.
    if sink.is_anchored(did)? {
        let head = sink.call_byte_array_view("head_cid", did.as_bytes())?;
        eprintln!(
            "ingest: on-chain head_cid = {}",
            String::from_utf8_lossy(&head)
        );
        let root = sink.call_byte_array_view("tentative_root", &[])?;
        eprintln!("ingest: tentative_root = {}", hex::encode(root));
    }
    Ok(())
}

#[cfg(not(feature = "live"))]
fn single_did_submit(
    _did: &str,
    _entries: &[ingest::ExportEntry],
    _anchor_set: &AnchorSet,
    _cursor: &mut Cursor,
) -> Result<()> {
    anyhow::bail!(
        "--submit requires the `live` feature: rebuild with `cargo build --features live`"
    )
}
