//! Differential gate for the DRISL / dag-cbor DECODER — the strict inverse of `encodeDagCbor`.
//!
//! Verify-on-read reads the anchor's raw op bytes and decodes them itself (not via the untrusted
//! directory), so the decoder is consensus-critical. `encodeDagCbor` is already pinned byte-exact
//! to `@ipld/dag-cbor` (via the CIDs in `nullified.test.ts` / the corpus); this pins `decodeDagCbor`
//! as its exact inverse over real PLC ops, and checks the strictness that stops a permissionless
//! writer's malformed/non-canonical bytes from being misparsed (they must throw → be dropped).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodeDagCbor, encodeDagCbor } from "../src/dagcbor.ts";

interface Fixture {
  scenarios: { auditLog: { operation: unknown }[] }[];
}
const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "nullified-vectors.json"), "utf8"),
);

test("decode ∘ encode is the identity over every real PLC op in the corpus", () => {
  let n = 0;
  for (const s of fixture.scenarios) {
    for (const e of s.auditLog) {
      assert.deepEqual(decodeDagCbor(encodeDagCbor(e.operation)), e.operation);
      n += 1;
    }
  }
  assert.ok(n > 0, "fixture had ops to round-trip");
});

test("decode ∘ encode round-trips the scalar/collection blessed subset", () => {
  const values: unknown[] = [
    0,
    1,
    23,
    24,
    255,
    256,
    65535,
    65536,
    -1,
    -24,
    -256,
    true,
    false,
    null,
    "",
    "did:plc:abcdefghijklmnopqrstuvwx",
    ["a", "bb", "ccc"],
    [],
    { a: 1, bb: "two", ccc: null, dddd: ["x"], eeeee: { z: true } },
    { type: "plc_operation", prev: null, rotationKeys: ["did:key:z1", "did:key:z2"], sig: "AAAA" },
    1.5,
    -0.25,
  ];
  for (const v of values) assert.deepEqual(decodeDagCbor(encodeDagCbor(v)), v);
});

test("decoder is STRICT: rejects non-canonical / malformed / out-of-subset bytes", () => {
  const cases: [string, number[]][] = [
    ["non-minimal 1-byte uint (0 as 0x18 0x00)", [0x18, 0x00]],
    ["non-minimal 2-byte uint (0 as 0x19 0x0000)", [0x19, 0x00, 0x00]],
    ["trailing bytes after a value", [0x00, 0x00]],
    ["byte string (major type 2, unsupported)", [0x41, 0x00]],
    ["tag (major type 6, unsupported)", [0xc2, 0x00]],
    ["indefinite-length array", [0x9f, 0xff]],
    ["truncated string (len 3, 1 byte)", [0x63, 0x61]],
    ["map key not a string", [0xa1, 0x00, 0x00]],
  ];
  for (const [why, bytes] of cases) {
    assert.throws(() => decodeDagCbor(Uint8Array.from(bytes)), new RegExp("dag-cbor decode"), why);
  }
});

test("decoder rejects out-of-order and duplicate map keys", () => {
  // Encode a valid map, then hand-build the same map with keys in the WRONG order and confirm the
  // decoder rejects it (canonical order is consensus-critical — a mis-ordered op must not parse).
  const good = encodeDagCbor({ a: 1, bb: 2 }); // canonical: "a" (len 1) before "bb" (len 2)
  assert.deepEqual(decodeDagCbor(good), { a: 1, bb: 2 });
  // Same two entries, emitted "bb" first then "a" (length-descending → not canonical).
  const badOrder = Uint8Array.from([0xa2, 0x62, 0x62, 0x62, 0x02, 0x61, 0x61, 0x01]);
  assert.throws(() => decodeDagCbor(badOrder), /out of order/);
  // Duplicate key "a".
  const dup = Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]);
  assert.throws(() => decodeDagCbor(dup), /out of order|duplicat/);
});
