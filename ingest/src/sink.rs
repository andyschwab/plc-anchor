//! Where deltas go — the anchor-endpoint seam.
//!
//! A [`Delta`] is a verified op ready to submit: genesis ops route to `import_genesis`,
//! appends to `submit_op` (REFERENCE.md §3). Authorization is the op's embedded signature,
//! verified in-contract — the Starknet tx signer / fee payer is irrelevant (REFERENCE.md §2),
//! so a sink need not hold any PLC key.
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
    /// A subsequent op for an already-anchored DID — routes to `submit_op`.
    Append {
        /// The DID being updated.
        did: String,
        /// Canonical DRISL signed-op bytes.
        signed: Vec<u8>,
    },
}

impl Delta {
    /// The DID this delta targets.
    pub fn did(&self) -> &str {
        match self {
            Delta::Genesis { did, .. } | Delta::Append { did, .. } => did,
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
