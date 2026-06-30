# `ingest/` — PLC firehose sync indexer

The off-chain feeder for the anchor endpoint (`REFERENCE.md` §3, build-order item 4). It
consumes a PLC directory mirror's `/export` stream, filters to the DIDs that have opted into
anchoring (membership is off-chain policy — `REFERENCE.md` §2), re-encodes each op to its
canonical DRISL bytes, and submits the deltas to the on-chain `import_genesis` / `submit_op`
entrypoints. This is the **normal anchoring path** in witness mode, and where ongoing update
cost lives.

## How it's built

The pipeline is three trait seams so the consensus-relevant logic stays offline-testable:

- **`source::OpSource`** — where ops come from. `HttpExportSource` (ureq, blocking) is the live
  `/export` path; `FixtureSource` drives the tests.
- **`sink::AnchorSink`** — where deltas go. `DryRunSink` logs what it *would* anchor (the
  default); `StarknetSink` submits on-chain (the `live` feature).
- **`reencode` + `pipeline`** — the pure middle, differential-tested byte-for-byte against the
  vendored conformance corpus.

**The integrity invariant:** a delta is submitted only if its re-encoded DRISL bytes hash to
the exact CID the directory published for that op (`pipeline` enforces this). We never anchor
bytes that disagree with the directory — so the feeder can't be tricked into anchoring forged
content even by the source it reads. (See `adversarial/` scenario `integrity-mismatch`.)

`reencode` confirmed PLC `prev` is a base32 **string**, not a tag-42 IPLD link — there are no
IPLD links in PLC ops.

## Running

```sh
# Single DID — pull just its /<did>/log/audit and onboard it in one request (no firehose scan):
cargo run --bin ingest -- --did did:plc:... [--source https://plc.directory]

# Firehose — scan /export for every DID in a roster file (one DID per line, # comments):
cargo run --bin ingest -- --roster dids.txt [--source URL] [--cursor cursor.json] [--count 1000]
```

Both modes default to a **dry run** (deltas are logged, not submitted). Add `--submit` to write
on-chain — that requires the `live` feature and its env config:

```sh
cargo run --features live --bin ingest -- --did did:plc:... --submit
```

`--cursor` (firehose) persists an `after=<createdAt>` cursor as JSON so backfills resume.

## The `live` feature

On-chain submission (`StarknetSink`, `--submit`, the E2E test) is gated behind the `live` cargo
feature so the default build and the offline consensus tests pull **no** async runtime or
Starknet client. `StarknetSink` (`src/starknet_sink.rs`) hand-encodes the Cairo `ByteArray`
calldata and waits for tx acceptance; `StarknetConfig::from_env()` documents the env vars it
reads. The on-chain Sepolia E2E lives in `tests/live_e2e.rs` (`--ignored`); deployment notes are
in [`snfoundry.toml`](../snfoundry.toml) and the gated job is
[`.github/workflows/e2e-sepolia.yml`](../.github/workflows/e2e-sepolia.yml).

## Tests

```sh
make rust-test          # fmt-check + clippy(-D warnings) + cargo test (offline pipeline)
```

The offline tests exercise `reencode`, `pipeline`, the cursor, and the dry-run sink — the live
Starknet path is feature-gated out of the default `cargo test`.
