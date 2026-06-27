//! DRISL (Deterministic Representation for Interoperable Structures and Links)
//! canonical encoding + DASL CID derivation, in Cairo.
//!
//! THE KEYSTONE (REFERENCE.md §3, component 1). Everything composes around this module
//! and it is consensus-critical: any divergence from the reference encoders is a fork.
//!
//! Status: STUB. Implementation is gated on the conformance harness being wired
//! (see ../../../conformance) and is the long pole of the build order (§3).
//!
//! Blessed set (do not widen without a governance decision — REFERENCE.md §5):
//!   - CIDv1 only
//!   - multihash: sha2-256 (0x12), 32-byte digest (0x20)
//!   - codec: dag-cbor/DRISL (0x71) or raw (0x55)
//!   - dCBOR42 canonical: minimal ints, length-first map-key ordering, 64-bit floats
//!     only (no NaN/Inf), no indefinite-length, Tag 42 for CID links (0x00-prefixed),
//!     simple values true/false/null only.

pub mod cid;
pub mod drisl;
