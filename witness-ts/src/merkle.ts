//! sha256-Merkle inclusion-proof verification — the resolver-side half of the DID→head
//! commitment (REFERENCE.md §4; mirrors cairo/packages/plc_core/src/merkle.cairo).
//!
//! The anchor commits one root over `{ did → head_cid }`; a resolver proves a single DID's
//! current head against that root with a logarithmic path. This module is *verification only*
//! — root and proof generation are the contract's job (`anchor::tentative_proof` /
//! `confirmed_proof`). The resolver fetches the proof from the (untrusted) contract and the
//! root independently, then recomputes here.
//!
//! ## Format (pinned — must stay byte-identical to merkle.cairo, or resolvers fork)
//!
//!   - **leaf**:  sha256( 0x00 ‖ did ‖ head_cid )   (did/head are their UTF-8 string bytes)
//!   - **node**:  sha256( 0x01 ‖ left ‖ right )      (over two 32-byte child digests)
//!   - **empty**: sha256( "" )
//!
//! `did` is the `did:plc:` string (fixed 32 bytes), so the separator-less `did ‖ head_cid`
//! boundary is unambiguous. The drift gate (`test/merkle.test.ts`) pins every value here to
//! the same `gen-merkle-vectors` output the Cairo tests pin against.

import { createHash } from "node:crypto";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

/**
 * A sibling on an inclusion path: its 32-byte digest and whether it sits on the *left* of the
 * node being recomputed (so the verifier hashes the pair in the correct order). This mirrors
 * the `ProofStep` the contract returns from `tentative_proof` / `confirmed_proof`.
 */
export interface ProofStep {
  sibling: Uint8Array;
  siblingIsLeft: boolean;
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Leaf digest for one map entry: sha256( 0x00 ‖ did ‖ head_cid ). */
export function leafHash(did: string, headCid: string): Uint8Array {
  return sha256(Uint8Array.of(LEAF_PREFIX), utf8(did), utf8(headCid));
}

/** Internal-node digest: sha256( 0x01 ‖ left ‖ right ). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(NODE_PREFIX), left, right);
}

/** The root of the empty map: sha256(""). */
export function emptyRoot(): Uint8Array {
  return sha256(new Uint8Array(0));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Recompute the root from `leaf` and its inclusion `proof`, and compare to `root`. The
 * resolver primitive: a `true` here means `leaf` is committed under a root the resolver
 * fetched independently, so the proof server (the contract) need not be trusted. Mirrors
 * `merkle.cairo::verify_proof` exactly.
 */
export function verifyProof(leaf: Uint8Array, proof: readonly ProofStep[], root: Uint8Array): boolean {
  let acc = leaf;
  for (const step of proof) {
    acc = step.siblingIsLeft ? nodeHash(step.sibling, acc) : nodeHash(acc, step.sibling);
  }
  return bytesEqual(acc, root);
}
