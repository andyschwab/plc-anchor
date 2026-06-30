//! Firehose sync indexer (REFERENCE.md §3, build-order item 4).
//!
//! Backfills a PLC mirror's `/export` for the DIDs in a roster, re-encodes each op to its
//! canonical DRISL bytes, checks it against the directory's published CID, and either logs the
//! delta it would anchor (default, [`DryRunSink`]) or submits it to a live `anchor` contract
//! (`--submit`, the [`ingest::StarknetSink`] — requires `--features live` and the env config it
//! documents).
//!
//! ```text
//! ingest --roster <dids.txt> [--source https://plc.directory] [--cursor <cursor.json>] [--count 1000] [--submit]
//! ```

use anyhow::{Context, Result};
use ingest::{
    AnchorSet, AnchorSink, Cursor, DryRunSink, HttpExportSource, Indexer, OpSource, Stats,
};

const DEFAULT_SOURCE: &str = "https://plc.directory";

struct Args {
    roster: String,
    source: String,
    cursor_path: Option<String>,
    count: usize,
    submit: bool,
}

fn parse_args() -> Result<Option<Args>> {
    let mut roster = None;
    let mut source = DEFAULT_SOURCE.to_string();
    let mut cursor_path = None;
    let mut count = Indexer::<HttpExportSource, DryRunSink>::DEFAULT_PAGE_SIZE;
    let mut submit = false;

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "-h" | "--help" => return Ok(None),
            "--roster" => roster = Some(next_value(&mut args, "--roster")?),
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

    let Some(roster) = roster else {
        return Ok(None);
    };
    Ok(Some(Args {
        roster,
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
         ingest --roster <dids.txt> [--source <url>] [--cursor <path>] [--count <n>] [--submit]\n\n\
         OPTIONS:\n  \
         --roster <path>   anchored-DID roster (one did:plc:... per line; # comments) [required]\n  \
         --source <url>    PLC directory / mirror base URL [default: {DEFAULT_SOURCE}]\n  \
         --cursor <path>   resume/persist the export cursor as JSON [default: in-memory]\n  \
         --count <n>       export page size [default: 1000]\n  \
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
