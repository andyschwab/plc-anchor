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
import { deriveLiveChain, deriveNullified, RECOVERY_WINDOW_MS, type AuditEntry } from "../src/directory.ts";
import { encodeDagCbor } from "../src/dagcbor.ts";
import { verifySig } from "../src/crypto.ts";
import {
  AnchorLogOverflowError,
  type AnchorView,
  check,
  deriveAnchorHeads,
  MAX_ANCHOR_LOG_BYTES,
  MAX_ANCHOR_OPS,
} from "../src/status.ts";
import type { AnchorOp } from "../src/starknet.ts";

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

/** Fake anchor: anchored, empty raw chain — the confirmed head is supplied via `deriveAnchor` so
 * these rows isolate the DIRECTORY re-derivation (the item-1 payoff), not the anchor's. */
const fakeAnchor: AnchorView = { isAnchored: async () => true, chain: async () => [] };
const NOW = Date.parse("2026-06-30T00:00:00Z");
const runReal = (did: string, confirmedHead: string, log: AuditEntry[]) =>
  check(did, fakeAnchor, { auditLog: async () => log }, {
    now: () => NOW,
    deriveAnchor: () => ({ confirmedHead, tentativeHead: confirmedHead }),
  });
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

  const real = await runReal(fixture.did, R, hostile);
  assert.equal(real.status, "confirmed", "re-derivation follows the real recovery head");

  // The old flag-trusting behaviour is fooled: it follows the (falsely) live opA and never reaches
  // `confirmed`, so the directory's lie succeeds in suppressing the correct verdict — the bug this fixes.
  const fooled = await check(fixture.did, fakeAnchor, { auditLog: async () => hostile }, {
    now: () => NOW,
    deriveLive: flagLive,
    deriveAnchor: () => ({ confirmedHead: R, tentativeHead: R }),
  });
  assert.notEqual(fooled.status, "confirmed", "flag-trusting logic is fooled by the lie");
});

test("status: directory floats a weaker-key fork as live — re-derivation rejects it and confirms opA", async () => {
  // The mirror injects a weaker-key fork W, claims it live and opA nullified. The anchor's
  // confirmed head is the REAL live op, opA. Re-derivation rejects W and keeps opA live.
  const s = scenario("hostile-weaker-key-recovery");
  const A = s.expectedHeadCid as string; // opA — the true live head
  const r = await runReal(fixture.did, A, s.auditLog);
  assert.equal(r.status, "confirmed");
});

// ── deriveAnchorHeads: the REAL verify-on-read path over on-chain bytes (docs/ONCHAIN-REARCH) ──
//
// Synthesize the anchor's `chain(did)` return from a real signed chain: `signed` = the op's DRISL
// bytes, `created_at` = the block time (here the entry's own time), `imported` = provenance.
// `deriveAnchorHeads` DECODES those bytes itself (no directory input), then runs the crypto
// re-derivation + block-time confirmed-head + the read-side recovery-of-imported guard — what the
// contract used to do in Cairo, now proven read-side and independent of any directory.

const anchorOpsFrom = (log: AuditEntry[], imported = false): AnchorOp[] =>
  log.map((e) => ({ signed: encodeDagCbor(e.operation), createdAt: Date.parse(e.createdAt), imported }));
const FAR_FUTURE = Date.parse("2099-01-01T00:00:00Z");

test("deriveAnchorHeads: re-derives the live recovery head from on-chain bytes", () => {
  const s = scenario("valid-recovery");
  const R = s.expectedHeadCid as string;
  const ops = anchorOpsFrom(s.auditLog);
  const heads = deriveAnchorHeads(ops, { now: FAR_FUTURE, did: fixture.did });
  assert.equal(heads.tentativeHead, R, "tentative tip should be the recovery head");
  assert.equal(heads.confirmedHead, R, "past the window the recovery head is confirmed");
});

test("deriveAnchorHeads: nothing is confirmed before any window closes (block-time clock)", () => {
  const s = scenario("valid-recovery");
  const R = s.expectedHeadCid as string;
  const ops = anchorOpsFrom(s.auditLog);
  // `now` earlier than every op's block time → no window has closed.
  const beforeAll = Math.min(...ops.map((o) => o.createdAt)) - 1;
  const heads = deriveAnchorHeads(ops, { now: beforeAll, did: fixture.did });
  assert.equal(heads.tentativeHead, R, "tentative tip is always the live head");
  assert.equal(heads.confirmedHead, "", "nothing confirmed before the window closes");
});

test("deriveAnchorHeads: a recovery may NOT nullify imported/settled history (SECURITY-TODO 4a, read-side)", () => {
  // The exact read-side mirror of the Cairo `recovery_cannot_nullify_imported_history` test: mark
  // the whole chain imported (settled backfill). The recovery that would nullify the settled opA
  // is refused, so the live tip stays below it — NOT the recovery head R.
  const s = scenario("valid-recovery");
  const R = s.expectedHeadCid as string;
  const imported = deriveAnchorHeads(anchorOpsFrom(s.auditLog, true), { now: FAR_FUTURE, did: fixture.did });
  assert.notEqual(imported.tentativeHead, R, "recovery-of-imported must be rejected read-side");
  assert.notEqual(imported.confirmedHead, R, "and so the imported recovery head is never confirmed");
  // Contrast: live-observed, the same recovery IS honored (the previous test) — the guard is what
  // changed the outcome, exactly as on-chain.
  assert.ok(RECOVERY_WINDOW_MS > 0);
});

test("deriveAnchorHeads: an equivocating directory can't suppress the head (decoded from anchor bytes)", () => {
  // The security fix: heads come from DECODING the on-chain bytes, so no directory input is even
  // taken here — a withholding/forging directory cannot lower the derived confirmed head. Same real
  // chain, no bodies provided anywhere: the recovery head is still derived.
  const s = scenario("valid-recovery");
  const R = s.expectedHeadCid as string;
  const heads = deriveAnchorHeads(anchorOpsFrom(s.auditLog), { now: FAR_FUTURE, did: fixture.did });
  assert.equal(heads.confirmedHead, R, "confirmed head derived from anchor bytes alone");
});

// ── Anchor-log junk + bounds (SECURITY-TODO 4e): skip-don't-truncate, overflow → error ──
//
// The anchor's writes are permissionless and its log append-only, so junk INTERLEAVED with real
// ops is expected. Junk must be skipped, never a truncation point (one cheap bogus append must not
// permanently hide the real ops stored after it — the per-DID witness-silencing attack), and a
// spam-pumped log must degrade to a bounded `error`, never a verdict.

const junkOp = (createdAt: number): AnchorOp => ({
  signed: Uint8Array.from([0xff, 0x00, 0x13, 0x37]), // undecodable / non-canonical
  createdAt,
  imported: false,
});

test("deriveAnchorHeads: garbage on-chain bytes are skipped, never becoming a head", () => {
  // A permissionless writer appends non-canonical / undecodable bytes after a real chain. They
  // decode-fail → skipped; the head stays the last valid op, and junk never confirms.
  const s = scenario("valid-recovery");
  const ops = anchorOpsFrom(s.auditLog);
  const withGarbage = [...ops, junkOp(FAR_FUTURE)];
  const heads = deriveAnchorHeads(withGarbage, { now: FAR_FUTURE + 1, did: fixture.did });
  assert.equal(heads.tentativeHead, s.expectedHeadCid, "garbage tail is dropped; tip is the real head");
});

test("deriveAnchorHeads: junk interleaved mid-chain cannot silence the real ops after it (4e)", () => {
  // The silencing attack: an attacker appends one undecodable op BEFORE the indexer stores the
  // DID's next real ops. Under truncate-at-junk the anchor's view would freeze at the pre-junk
  // head forever; under skip the later real ops are still validated and derived.
  const s = scenario("valid-recovery");
  const ops = anchorOpsFrom(s.auditLog);
  const interleaved = ops.flatMap((op, i) => (i === 1 ? [junkOp(op.createdAt), op] : [op]));
  const heads = deriveAnchorHeads(interleaved, { now: FAR_FUTURE, did: fixture.did });
  assert.equal(heads.tentativeHead, s.expectedHeadCid, "real ops after the junk still derive the head");
  assert.equal(heads.confirmedHead, s.expectedHeadCid, "…and still confirm past the window");
});

test("deriveAnchorHeads: a decodable-but-invalid op mid-chain is skipped the same way (4e)", () => {
  // Decodable canonical CBOR that is not a usable PLC op (readOp → null). One level below the
  // decode gate, same attack: it must be skipped, not end replay.
  const s = scenario("valid-recovery");
  const ops = anchorOpsFrom(s.auditLog);
  const notAnOp: AnchorOp = { signed: encodeDagCbor({ not: "a-plc-op" }), createdAt: ops[0].createdAt, imported: false };
  const interleaved = [ops[0], notAnOp, ...ops.slice(1)];
  const heads = deriveAnchorHeads(interleaved, { now: FAR_FUTURE, did: fixture.did });
  assert.equal(heads.tentativeHead, s.expectedHeadCid, "the non-op is skipped; the real chain derives");
});

test("deriveLiveChain: stop vs skip — the directory keeps truncate-at-invalid semantics", () => {
  // The two assembly modes side by side: the anchor path skips (permissionless log), while the
  // directory path must keep stopping at the first invalid entry — the acceptance procedure
  // @did-plc/lib models — so the consensus-faithful directory re-derivation is unchanged.
  const s = scenario("clean-chain");
  const junkEntry = { operation: { not: "a-plc-op" }, createdAt: s.auditLog[0].createdAt };
  const interleaved = [s.auditLog[0], junkEntry, ...s.auditLog.slice(1)];
  const stopped = deriveLiveChain(interleaved, fixture.did);
  assert.equal(stopped.head?.cid, s.auditLog[0].cid, "stop mode (default): replay ends at the junk");
  const skipped = deriveLiveChain(interleaved, fixture.did, { onInvalid: "skip" });
  assert.equal(skipped.head?.cid ?? null, s.expectedHeadCid, "skip mode: junk dropped, chain completes");
});

test("deriveAnchorHeads: an op-count-bloated log throws AnchorLogOverflowError before any crypto", () => {
  const bloated: AnchorOp[] = Array.from({ length: MAX_ANCHOR_OPS + 1 }, () => junkOp(0));
  assert.throws(
    () => deriveAnchorHeads(bloated, { now: FAR_FUTURE, did: fixture.did }),
    AnchorLogOverflowError,
  );
});

test("deriveAnchorHeads: a byte-bloated log throws AnchorLogOverflowError", () => {
  const big: AnchorOp = { signed: new Uint8Array(MAX_ANCHOR_LOG_BYTES + 1), createdAt: 0, imported: false };
  assert.throws(() => deriveAnchorHeads([big], { now: FAR_FUTURE, did: fixture.did }), AnchorLogOverflowError);
});

test("status: a spam-pumped anchor log degrades to `error` (anchor-log-overflow), never a verdict", async () => {
  // End-to-end §0 safety: the attacker pumps a victim DID's on-chain log past the bounds. check()
  // must return the non-alarming `error` — unavailable — not `diverged` (and not hang validating).
  const s = scenario("clean-chain");
  const bloatedAnchor: AnchorView = {
    isAnchored: async () => true,
    chain: async () => Array.from({ length: MAX_ANCHOR_OPS + 1 }, () => junkOp(0)),
  };
  const r = await check(fixture.did, bloatedAnchor, { auditLog: async () => s.auditLog }, { now: () => NOW });
  assert.equal(r.status, "error");
  assert.equal(r.reason, "anchor-log-overflow");
  assert.equal(r.evidence.directoryHead, s.expectedHeadCid, "directory evidence still reported");
});
