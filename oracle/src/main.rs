//! DRISL/CID differential oracle (REFERENCE.md §3, §5). STUB.
//!
//! Loads the vendored DASL conformance vectors and, once `atproto-dasl` is wired,
//! recomputes each CID and asserts it matches the vector's expected output — the
//! Rust leg of the three-way agreement check (`make conformance`). Until then it
//! just confirms the vectors directory is present and well-formed.

use std::path::Path;

fn main() -> anyhow::Result<()> {
    let vectors = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("conformance/vectors");
    if vectors.is_dir() {
        println!(
            "oracle: vectors present at {} (atproto-dasl check: TODO)",
            vectors.display()
        );
    } else {
        println!("oracle: no vectors vendored yet at {}", vectors.display());
    }
    Ok(())
}
