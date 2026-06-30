//! The anchored-DID set.
//!
//! Membership is off-chain policy (REFERENCE.md §2): a DID is anchored iff someone chose to
//! anchor it (a PDS anchors its own users; a coalition sponsors a roster). The indexer only
//! submits deltas for DIDs in this set — everything else streams past untouched. The set is a
//! flat `did:plc:...`-per-line file; *which* DIDs and *who pays* is the deferred Layer-2 tool.

use anyhow::{Context, Result};
use std::collections::HashSet;
use std::path::Path;

/// The set of DIDs the indexer is anchoring.
#[derive(Debug, Clone, Default)]
pub struct AnchorSet {
    dids: HashSet<String>,
}

impl AnchorSet {
    /// An empty set (anchors nothing).
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from DID strings.
    pub fn from_iter_dids(dids: impl IntoIterator<Item = String>) -> Self {
        Self {
            dids: dids.into_iter().collect(),
        }
    }

    /// Parse a roster: one DID per line, `#` comments and blank lines ignored.
    pub fn from_lines(text: &str) -> Self {
        let dids = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect();
        Self { dids }
    }

    /// Load a roster file.
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read anchor roster {}", path.display()))?;
        Ok(Self::from_lines(&text))
    }

    /// Whether a DID is anchored.
    pub fn contains(&self, did: &str) -> bool {
        self.dids.contains(did)
    }

    /// Number of anchored DIDs.
    pub fn len(&self) -> usize {
        self.dids.len()
    }

    /// Whether the set is empty.
    pub fn is_empty(&self) -> bool {
        self.dids.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_roster_with_comments_and_blanks() {
        let set = AnchorSet::from_lines(
            "# roster\ndid:plc:aaa\n\n  did:plc:bbb  \n# did:plc:ccc commented out\n",
        );
        assert_eq!(set.len(), 2);
        assert!(set.contains("did:plc:aaa"));
        assert!(set.contains("did:plc:bbb"));
        assert!(!set.contains("did:plc:ccc"));
        assert!(!set.is_empty());
    }
}
