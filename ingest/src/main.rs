//! Firehose sync indexer (REFERENCE.md §3, build-order item 4).
//!
//! Backfills a PLC mirror's `/export` for the DIDs in a roster, re-encodes each op to its
//! canonical DRISL bytes, checks it against the directory's published CID, and (currently) logs
//! the delta it would anchor. Wiring the [`DryRunSink`] to a live Starknet submitter is the
//! next seam (needs a deployed contract address + a fee-paying account).
//!
//! ```text
//! ingest --roster <dids.txt> [--source https://plc.directory] [--cursor <cursor.json>] [--count 1000]
//! ```

use anyhow::{Context, Result};
use ingest::{AnchorSet, Cursor, DryRunSink, HttpExportSource, Indexer};

const DEFAULT_SOURCE: &str = "https://plc.directory";

struct Args {
    roster: String,
    source: String,
    cursor_path: Option<String>,
    count: usize,
}

fn parse_args() -> Result<Option<Args>> {
    let mut roster = None;
    let mut source = DEFAULT_SOURCE.to_string();
    let mut cursor_path = None;
    let mut count = Indexer::<HttpExportSource, DryRunSink>::DEFAULT_PAGE_SIZE;

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "-h" | "--help" => return Ok(None),
            "--roster" => roster = Some(next_value(&mut args, "--roster")?),
            "--source" => source = next_value(&mut args, "--source")?,
            "--cursor" => cursor_path = Some(next_value(&mut args, "--cursor")?),
            "--count" => {
                count = next_value(&mut args, "--count")?
                    .parse()
                    .context("--count must be a positive integer")?;
            }
            other => anyhow::bail!("unknown argument {other:?} (try --help)"),
        }
    }

    let Some(roster) = roster else {
        return Ok(None);
    };
    Ok(Some(Args {
        roster,
        source,
        cursor_path,
        count,
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
         ingest --roster <dids.txt> [--source <url>] [--cursor <path>] [--count <n>]\n\n\
         OPTIONS:\n  \
         --roster <path>   anchored-DID roster (one did:plc:... per line; # comments) [required]\n  \
         --source <url>    PLC directory / mirror base URL [default: {DEFAULT_SOURCE}]\n  \
         --cursor <path>   resume/persist the export cursor as JSON [default: in-memory]\n  \
         --count <n>       export page size [default: 1000]\n\n\
         Runs a dry-run backfill: deltas are logged, not yet submitted on-chain."
    );
}

fn main() -> Result<()> {
    let Some(args) = parse_args()? else {
        usage();
        return Ok(());
    };

    let anchor_set = AnchorSet::load(&args.roster)?;
    if anchor_set.is_empty() {
        eprintln!(
            "ingest: roster {} is empty — nothing to anchor",
            args.roster
        );
        return Ok(());
    }

    let cursor = match &args.cursor_path {
        Some(path) => Cursor::load(path)?,
        None => Cursor::genesis(),
    };

    eprintln!(
        "ingest: anchoring {} DID(s) from {} (cursor: {})",
        anchor_set.len(),
        args.source,
        cursor.after.as_deref().unwrap_or("<genesis>")
    );

    let source = HttpExportSource::new(&args.source);
    let mut indexer =
        Indexer::new(source, anchor_set, DryRunSink::new(), cursor).with_page_size(args.count);

    let stats = indexer.run_to_idle()?;

    if let Some(path) = &args.cursor_path {
        indexer.cursor().save(path)?;
    }

    for delta in &indexer.sink().applied {
        let (kind, did) = match delta {
            ingest::Delta::Genesis { did, .. } => ("import_genesis", did),
            ingest::Delta::Append { did, .. } => ("submit_op", did),
        };
        println!("would {kind}: {did}");
    }

    eprintln!(
        "ingest: scanned {}, matched {}, submitted {} ({} genesis / {} append), skipped {} nullified",
        stats.scanned,
        stats.matched,
        stats.submitted(),
        stats.genesis,
        stats.appends,
        stats.skipped_nullified,
    );
    Ok(())
}
