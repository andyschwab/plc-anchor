//! Where deltas go — the anchor-endpoint seam.
//!
//! A [`Delta`] is a verified op (or resolved chain) ready to submit. Onboarding a DID's existing
//! history routes to `import` as one settled chain ([`Delta::Import`]); a genesis seen live routes
//! to `import_genesis`; a subsequent op observed live routes to `submit_op` (REFERENCE.md §3).
//! Authorization is the op's embedded signature, verified in-contract — the Starknet tx signer /
//! fee payer is irrelevant (REFERENCE.md §2), so a sink need not hold any PLC key.
//!
//! ## Onboard vs. tail — the provenance split (SECURITY-TODO 4a)
//!
//! The contract stamps every op it accepts with the block time, since a PLC op carries no authored
//! `createdAt` (§1/§5). For **live-observed** ops that block time approximates the real authored
//! time, so the 72h recovery window measured against it is sound. For **backfilled history** it is
//! not — an op authored years ago but submitted now looks fresh, which would re-open a long-closed
//! recovery window and let a rotated-out key capture the DID. So the contract treats *imported* ops
//! as settled (a recovery may not nullify them). This module encodes that split: **onboard an
//! existing history via [`Delta::Import`]** (settled, not the op-by-op `submit_op` path), and reserve
//! `submit_op`/[`Delta::Append`] for genuinely-new ops observed ~live while tailing.
//!
//! [`DryRunSink`] records deltas without touching a chain — the default until a contract is
//! deployed, and the substrate for the pipeline tests. The live Starknet submitter is the next
//! seam to fill (it needs a deployed contract address + a fee-paying account; both are out of
//! scope for this build-order item and untestable without a devnet).

use anyhow::Result;

/// A verified op ready to anchor, carrying the canonical DRISL signed bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delta {
    /// A DID's first op — routes to `import_genesis`.
    Genesis {
        /// The DID being created.
        did: String,
        /// Canonical DRISL signed-op bytes.
        signed: Vec<u8>,
    },
    /// A subsequent op for an already-anchored DID, observed live — routes to `submit_op`.
    Append {
        /// The DID being updated.
        did: String,
        /// Canonical DRISL signed-op bytes.
        signed: Vec<u8>,
    },
    /// A DID's full existing history as one resolved linear chain — routes to `import`, which
    /// marks every op *settled* (SECURITY-TODO 4a). This is the onboarding path; `ops[0]` is the
    /// genesis and the rest are its resolved successors (nullified branches already dropped), each
    /// canonical DRISL signed bytes, CID-checked before inclusion.
    Import {
        /// The DID being onboarded.
        did: String,
        /// The resolved chain, genesis-first: canonical DRISL signed-op bytes per op.
        ops: Vec<Vec<u8>>,
    },
}

impl Delta {
    /// The DID this delta targets.
    pub fn did(&self) -> &str {
        match self {
            Delta::Genesis { did, .. } | Delta::Append { did, .. } | Delta::Import { did, .. } => {
                did
            }
        }
    }
}

/// The submission target for verified deltas.
pub trait AnchorSink {
    /// Submit one delta to the anchor endpoint.
    fn apply(&mut self, delta: &Delta) -> Result<()>;
}

/// A sink that records deltas instead of submitting them. Used as the default (no chain wired)
/// and to assert pipeline behaviour in tests.
#[derive(Debug, Default)]
pub struct DryRunSink {
    /// Every delta handed to the sink, in order.
    pub applied: Vec<Delta>,
}

impl DryRunSink {
    /// A fresh recorder.
    pub fn new() -> Self {
        Self::default()
    }
}

impl AnchorSink for DryRunSink {
    fn apply(&mut self, delta: &Delta) -> Result<()> {
        self.applied.push(delta.clone());
        Ok(())
    }
}
