//! ABI codec gate: the hand-encoded ByteArray / proof-tuple (de)serialization must match the
//! Cairo `ByteArray` serde (mirrored from ingest/src/starknet_sink.rs) and round-trip the
//! contract's `tentative_proof` return shape. Pure/offline — no live node. The end-to-end case
//! synthesizes the felts a proof view would return for a pinned merkle vector and decodes them
//! all the way through `verifyProof`, so a codec slip surfaces as a verification failure.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { leafHash, verifyProof } from "../src/merkle.ts";
import { decodeByteArray, decodeProof, encodeByteArray, encodeString } from "../src/starknet.ts";

const fromHex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

interface MerkleVectors {
  entriesSorted: [string, string][];
  expectedRoot: string;
  proofIndex: number;
  proofSteps: { sibling: string; siblingIsLeft: boolean }[];
}
const vectors: MerkleVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "merkle-vectors.json"), "utf8"),
);

test("ByteArray encode/decode round-trips across word boundaries", () => {
  for (const len of [0, 1, 31, 32, 70]) {
    const data = Uint8Array.from({ length: len }, (_, i) => i & 0xff);
    const felts = encodeByteArray(data);
    const { bytes, next } = decodeByteArray(felts, 0);
    assert.deepEqual([...bytes], [...data], `round-trip for ${len} bytes`);
    assert.equal(next, felts.length, `consumed all felts for ${len} bytes`);
  }
});

test("empty ByteArray is [0x0, 0x0, 0x0]", () => {
  assert.deepEqual(encodeByteArray(new Uint8Array(0)), ["0x0", "0x0", "0x0"]);
});

test("decodeProof reconstructs the contract's (head, ProofStep[]) return and verifies to root", () => {
  const [did, head] = vectors.entriesSorted[vectors.proofIndex];

  // Synthesize exactly what anchor::tentative_proof serializes: a head ByteArray, then an
  // Array<ProofStep> = [len, (sibling ByteArray, sibling_is_left felt) …].
  const felts: string[] = [...encodeString(head)];
  felts.push(`0x${vectors.proofSteps.length.toString(16)}`);
  for (const step of vectors.proofSteps) {
    felts.push(...encodeByteArray(fromHex(step.sibling)));
    felts.push(step.siblingIsLeft ? "0x1" : "0x0");
  }

  const decoded = decodeProof(felts);
  assert.equal(decoded.head, head, "decoded head CID mismatch");
  assert.equal(decoded.proof.length, vectors.proofSteps.length, "proof step count mismatch");

  // The decoded proof must verify the DID's leaf against the pinned root — the resolver's check.
  assert.equal(
    verifyProof(leafHash(did, decoded.head), decoded.proof, fromHex(vectors.expectedRoot)),
    true,
    "decoded proof failed to verify against the root",
  );
});
