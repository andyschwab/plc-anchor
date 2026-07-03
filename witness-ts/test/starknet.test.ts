//! ABI codec gate: the hand-encoded ByteArray (de)serialization + the `chain` view's
//! `Array<OpEntry>` return must match the Cairo `ByteArray`/struct serde (mirrored from
//! ingest/src/starknet_sink.rs and anchor.cairo). Pure/offline — no live node.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeByteArray, decodeChain, encodeByteArray, encodeString } from "../src/starknet.ts";

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

test("decodeChain reconstructs the anchor's Array<OpEntry> return", () => {
  // Synthesize exactly what anchor::chain serializes: an array length felt, then each
  // OpEntry = (signed ByteArray, created_at felt, imported felt).
  const ops = [
    { signed: Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff), createdAt: 1_700_000_000_000, imported: true },
    { signed: encodeStringBytes("bafybeigenesisbody"), createdAt: 1_700_000_050_000, imported: false },
  ];

  const felts: string[] = [`0x${ops.length.toString(16)}`];
  for (const op of ops) {
    felts.push(...encodeByteArray(op.signed));
    felts.push(`0x${op.createdAt.toString(16)}`);
    felts.push(op.imported ? "0x1" : "0x0");
  }

  const decoded = decodeChain(felts, 0);
  assert.equal(decoded.length, ops.length, "op count mismatch");
  for (let i = 0; i < ops.length; i += 1) {
    assert.deepEqual([...decoded[i].signed], [...ops[i].signed], `signed bytes mismatch at ${i}`);
    assert.equal(decoded[i].createdAt, ops[i].createdAt, `created_at mismatch at ${i}`);
    assert.equal(decoded[i].imported, ops[i].imported, `imported flag mismatch at ${i}`);
  }
});

function encodeStringBytes(s: string): Uint8Array {
  // Decode the calldata form back to bytes so the fixture reuses the pinned encoder.
  const felts = encodeString(s);
  return decodeByteArray(felts, 0).bytes;
}
