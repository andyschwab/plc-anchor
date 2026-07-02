//! Differential gate for the witness's LOCAL re-derivation of PLC `nullified` (SECURITY-TODO
//! item 1). A hostile directory can flip the `nullified` flag to hide a live op or float a
//! superseded/forged op as live; the witness discards the flag and re-derives the live chain from
//! op contents (signatures + recovery priority + the 72h window), mirroring the on-chain
//! `state::apply_op` / `recovery::classify_next_op` and `@did-plc/lib`'s `assureValidNextOp`.
//!
//! Pins `deriveLiveChain` / `deriveNullified` / `verifySig` against
//! `conformance/src/gen-nullified-vectors.mjs`'s fixture — real signed chains whose every verdict
//! was ground-truthed vs `@did-plc/lib`. Regenerate with `make gen-nullified-vectors`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deriveLiveChain, deriveNullified, type AuditEntry } from "../src/directory.ts";
import { verifySig } from "../src/crypto.ts";
import { leafHash } from "../src/merkle.ts";
import { type AnchorView, check } from "../src/status.ts";

interface Scenario {
  id: string;
  note: string;
  auditLog: AuditEntry[];
  expectedHeadCid: string | null;
  expectedNullifiedCids: string[];
}
interface SigVector {
  note: string;
  didKey: string;
  unsignedHex: string;
  sig: string;
  expectValid: boolean;
}
interface Fixture {
  did: string;
  scenarios: Scenario[];
  sigVectors: SigVector[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "nullified-vectors.json"), "utf8"),
);

const scenario = (id: string): Scenario => {
  const s = fixture.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

// Return a copy of the log with every `nullified` flag inverted — the witness's re-derivation must
// be totally independent of the directory's claim, so both forms must yield the same result.
const flipFlags = (log: AuditEntry[]): AuditEntry[] => log.map((e) => ({ ...e, nullified: !e.nullified }));

// ── deriveLiveChain / deriveNullified against the @did-plc/lib-ground-truthed fixture ──

for (const s of fixture.scenarios) {
  test(`deriveLiveChain: ${s.id} — ${s.note}`, () => {
    const live = deriveLiveChain(s.auditLog, fixture.did);
    assert.equal(live.head?.cid ?? null, s.expectedHeadCid, "live head");
    assert.deepEqual(
      [...deriveNullified(s.auditLog)].sort(),
      [...s.expectedNullifiedCids].sort(),
      "nullified set",
    );
    for (const cid of s.expectedNullifiedCids) {
      assert.equal(live.liveCids.has(cid), false, `${cid} must not be live`);
    }
  });

  test(`deriveLiveChain: ${s.id} — result is independent of the directory's nullified flags`, () => {
    const asServed = deriveLiveChain(s.auditLog, fixture.did);
    const flipped = deriveLiveChain(flipFlags(s.auditLog), fixture.did);
    assert.equal(flipped.head?.cid ?? null, asServed.head?.cid ?? null);
    assert.deepEqual([...flipped.liveCids].sort(), [...asServed.liveCids].sort());
    assert.deepEqual([...deriveNullified(flipFlags(s.auditLog))].sort(), [...deriveNullified(s.auditLog)].sort());
  });
}

test("deriveLiveChain: a mismatched expectedDid yields no live chain (wrong DID's log)", () => {
  const s = scenario("clean-chain");
  const live = deriveLiveChain(s.auditLog, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(live.head, null);
  assert.equal(live.liveCids.size, 0);
});

// ── verifySig: both curves + the low-S / malleability asymmetry (mirrors sig_verify.cairo) ──

for (const v of fixture.sigVectors) {
  test(`verifySig: ${v.note}`, () => {
    const bytes = Uint8Array.from(Buffer.from(v.unsignedHex, "hex"));
    assert.equal(verifySig(v.didKey, bytes, v.sig), v.expectValid);
  });
}

test("verifySig: a malformed did:key or signature is a false, never a throw", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(verifySig("did:key:znotvalid", bytes, "AAAA"), false);
  assert.equal(verifySig("not-a-did-key", bytes, "AAAA"), false);
});

// ── Status integration: re-derivation defeats a flag-lying directory (the item-1 payoff) ──

const ZERO = new Uint8Array(32);
/** Fake anchor with a single-leaf commitment so an empty proof verifies (isolates the ladder). */
function fakeAnchor(did: string, confirmedHead: string): AnchorView {
  return {
    isAnchored: async () => true,
    confirmedProof: async () => ({ head: confirmedHead, proof: [] }),
    tentativeProof: async () => ({ head: confirmedHead, proof: [] }),
    confirmedRoot: async () => (confirmedHead === "" ? ZERO : leafHash(did, confirmedHead)),
    tentativeRoot: async () => (confirmedHead === "" ? ZERO : leafHash(did, confirmedHead)),
  };
}
const NOW = Date.parse("2026-06-30T00:00:00Z");
const runReal = (did: string, anchor: AnchorView, log: AuditEntry[]) =>
  check(did, anchor, { auditLog: async () => log }, { now: () => NOW });
const flagLive = (log: readonly AuditEntry[]) => ({
  liveCids: new Set(log.filter((e) => !e.nullified).map((e) => e.cid)),
  head: [...log].reverse().find((e) => !e.nullified) ?? null,
});

test("status: directory lies (recovery head flagged nullified) — re-derivation still confirms it", async () => {
  // valid-recovery served with HOSTILE flags: the recovery head R is flagged nullified and the
  // superseded opA flagged live, to hide the recovery. The anchor's confirmed head is R.
  const s = scenario("valid-recovery");
  const R = s.expectedHeadCid as string;
  const hostile = s.auditLog.map((e) => ({ ...e, nullified: e.cid === R }));
  const anchor = fakeAnchor(fixture.did, R);

  const real = await runReal(fixture.did, anchor, hostile);
  assert.equal(real.status, "confirmed", "re-derivation follows the real recovery head");

  // The old flag-trusting behaviour is fooled: it follows the (falsely) live opA and never reaches
  // `confirmed`, so the directory's lie succeeds in suppressing the correct verdict — the bug this fixes.
  const fooled = await check(fixture.did, anchor, { auditLog: async () => hostile }, { now: () => NOW, deriveLive: flagLive });
  assert.notEqual(fooled.status, "confirmed", "flag-trusting logic is fooled by the lie");
});

test("status: directory floats a weaker-key fork as live — re-derivation rejects it and confirms opA", async () => {
  // The mirror injects a weaker-key fork W, claims it live and opA nullified. The anchor's
  // confirmed head is the REAL live op, opA. Re-derivation rejects W and keeps opA live.
  const s = scenario("hostile-weaker-key-recovery");
  const A = s.expectedHeadCid as string; // opA — the true live head
  const anchor = fakeAnchor(fixture.did, A);
  const r = await runReal(fixture.did, anchor, s.auditLog);
  assert.equal(r.status, "confirmed");
});
