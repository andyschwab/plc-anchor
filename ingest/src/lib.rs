//! Firehose sync indexer (REFERENCE.md §3, build-order item 4).
//!
//! The off-chain feeder for the anchor endpoint. It consumes a PLC directory mirror's
//! `/export` stream, filters to the DIDs that have opted into anchoring (membership is
//! off-chain policy — REFERENCE.md §2), and submits each new op as a delta to the on-chain
//! `import_genesis` / `submit_op` entrypoints.
//!
//! The pipeline is built around three trait seams so the consensus-relevant logic stays
//! offline-testable:
//!
//! - [`source::OpSource`] — where ops come from (live HTTP, a fixture, a file).
//! - [`sink::AnchorSink`] — where deltas go (a dry-run logger now; a Starknet submitter next).
//! - everything between them ([`reencode`], [`pipeline`]) is pure and differential-tested
//!   against the vendored conformance corpus.
//!
//! The integrity invariant: a delta is only submitted if its re-encoded DRISL bytes hash to
//! the exact CID the directory published for that op ([`pipeline`] enforces this). We never
//! anchor bytes that disagree with the directory.

pub mod anchored;
pub mod cursor;
pub mod export;
pub mod pipeline;
pub mod reencode;
pub mod sink;
pub mod source;
#[cfg(feature = "live")]
pub mod starknet_sink;

pub use anchored::AnchorSet;
pub use cursor::Cursor;
pub use export::ExportEntry;
pub use pipeline::{process_batch, Indexer, Stats};
pub use sink::{AnchorSink, Delta, DryRunSink};
pub use source::{FixtureSource, HttpExportSource, OpSource};
#[cfg(feature = "live")]
pub use starknet_sink::{StarknetConfig, StarknetSink};
