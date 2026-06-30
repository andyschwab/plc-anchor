//! Resumable export cursor.
//!
//! The directory paginates `/export` by `after=<createdAt>`; the cursor is the `createdAt` of
//! the last entry we processed. Persisting it lets the indexer resume after a restart without
//! re-scanning (or, worse, re-submitting) history. The cursor is purely positional — it never
//! feeds verification (the `createdAt` is not in the signed op; REFERENCE.md §1).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The last processed export position.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Cursor {
    /// `createdAt` of the last processed entry; `None` starts from the beginning of history.
    #[serde(default)]
    pub after: Option<String>,
}

impl Cursor {
    /// A cursor at the start of history.
    pub fn genesis() -> Self {
        Self { after: None }
    }

    /// Advance to a processed entry's `createdAt`.
    pub fn advance(&mut self, created_at: &str) {
        self.after = Some(created_at.to_string());
    }

    /// Load a cursor from a JSON file, or start fresh if the file does not exist.
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        match std::fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw)
                .with_context(|| format!("parse cursor file {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::genesis()),
            Err(e) => Err(e).with_context(|| format!("read cursor file {}", path.display())),
        }
    }

    /// Persist the cursor to a JSON file.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        let raw = serde_json::to_string(self).context("serialize cursor")?;
        std::fs::write(path, raw).with_context(|| format!("write cursor file {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_a_file() {
        let dir = std::env::temp_dir().join(format!("ingest-cursor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cursor.json");

        assert_eq!(Cursor::load(&path).unwrap(), Cursor::genesis());

        let mut c = Cursor::genesis();
        c.advance("2023-05-01T00:00:00Z");
        c.save(&path).unwrap();
        assert_eq!(
            Cursor::load(&path).unwrap().after.as_deref(),
            Some("2023-05-01T00:00:00Z")
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
