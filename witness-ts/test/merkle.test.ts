//! Drift gate: the TypeScript `verifyProof` + leaf/node hashing must stay byte-identical to
//! the pinned Merkle format (REFERENCE.md §4). Pins against the SAME `gen-merkle-vectors`
//! output the Cairo tests pin against (`make gen-merkle-vectors` emits both) — one source of
//! truth, two consumers. If the contract's tree and this resolver-side check ever disagree,
//! resolvers fork; this test is the wall against that.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { emptyRoot, leafHash, verifyProof, type ProofStep } from "../src/merkle.ts";

interface MerkleVectors {
  entriesSorted: [string, string][];
  sortedLeaves: string[];
  expectedRoot: string;
  singleEntry: [string, string];
  singleRoot: string;
  emptyRoot: string;
  proofIndex: number;
  proofSteps: { sibling: string; siblingIsLeft: boolean }[];
}

const vectors: MerkleVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "merkle-vectors.json"), "utf8"),
);

const fromHex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const steps = (): ProofStep[] =>
  vectors.proofSteps.map((s) => ({ sibling: fromHex(s.sibling), siblingIsLeft: s.siblingIsLeft }));

test("leafHash matches the pinned leaf digests (leaf format)", () => {
  vectors.entriesSorted.forEach(([did, head], i) => {
    assert.equal(toHex(leafHash(did, head)), vectors.sortedLeaves[i], `leaf ${i} drifted`);
  });
});

test("emptyRoot matches the pinned sha256(\"\")", () => {
  assert.equal(toHex(emptyRoot()), vectors.emptyRoot);
});

test("the pinned inclusion proof verifies against the expected root", () => {
  const [did, head] = vectors.entriesSorted[vectors.proofIndex];
  const leaf = leafHash(did, head);
  assert.equal(verifyProof(leaf, steps(), fromHex(vectors.expectedRoot)), true);
});

test("a proof for the wrong leaf is rejected (same path, different member)", () => {
  // Reuse proofIndex's path but feed a different member's leaf → must not reconstruct the root.
  const other = vectors.proofIndex === 0 ? 1 : 0;
  const [did, head] = vectors.entriesSorted[other];
  const leaf = leafHash(did, head);
  assert.equal(verifyProof(leaf, steps(), fromHex(vectors.expectedRoot)), false);
});

test("a tampered root is rejected", () => {
  const [did, head] = vectors.entriesSorted[vectors.proofIndex];
  const leaf = leafHash(did, head);
  const bad = fromHex(vectors.expectedRoot);
  bad[0] ^= 0xff;
  assert.equal(verifyProof(leaf, steps(), bad), false);
});

test("single-entry tree: empty path, root == the leaf", () => {
  // A lone member has no siblings; verifyProof with an empty path compares the leaf to the
  // root, and the single-leaf root IS that leaf.
  const [did, head] = vectors.singleEntry;
  const leaf = leafHash(did, head);
  assert.equal(toHex(leaf), vectors.singleRoot);
  assert.equal(verifyProof(leaf, [], fromHex(vectors.singleRoot)), true);
});
