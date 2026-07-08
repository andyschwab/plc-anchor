//! DerivationCache — the refresh CPU-cost memo. Verifies the crypto (chain re-validation) is
//! skipped when a log is unchanged and re-run when it changes, and that the cheap clock-dependent
//! `headsFromLive` still runs fresh every call so the 72h rollover needs no re-verification.
//!
//! The memo wraps the REAL `deriveAnchorLive`/`deriveLiveChain`; feeding undecodable op bytes makes
//! `deriveAnchorLive` skip every op (non-canonical junk; SECURITY-TODO 4e) and yield an empty chain
//! WITHOUT running EC verification — enough to exercise the hit/miss bookkeeping without op
//! fixtures. The end-to-end crypto correctness of the split is covered by the status/nullified
//! differential suites.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DerivationCache } from "../src/derivation-cache.ts";
import { headsFromLive } from "../src/status.ts";
import { RECOVERY_WINDOW_MS, type AuditEntry, type LiveChain } from "../src/directory.ts";
import type { AnchorOp } from "../src/starknet.ts";

const op = (b: number): AnchorOp => ({ signed: new Uint8Array([b]), createdAt: 1_000, imported: false });
const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

test("deriveAnchor: identical op log is re-validated once, then served from the memo", () => {
  const cache = new DerivationCache();
  const ops = [op(1), op(2)];

  cache.deriveAnchor(ops, { now: 5_000, did: DID });
  cache.deriveAnchor(ops, { now: 9_999, did: DID }); // same ops, later clock
  const stats = cache.stats();
  assert.equal(stats.verified, 1, "the chain is validated (crypto) only once");
  assert.equal(stats.cached, 1, "the second call reuses the validated chain");
});

test("deriveAnchor: a changed op log forces re-validation", () => {
  const cache = new DerivationCache();
  cache.deriveAnchor([op(1)], { now: 5_000, did: DID });
  cache.deriveAnchor([op(2)], { now: 5_000, did: DID }); // different bytes → different hash
  assert.equal(cache.stats().verified, 2);
  assert.equal(cache.stats().cached, 0);
});

test("deriveLive: unchanged audit log returns the SAME LiveChain object (crypto skipped)", () => {
  const cache = new DerivationCache();
  const log: AuditEntry[] = [];
  const a = cache.deriveLive(log, DID);
  const b = cache.deriveLive(log, DID);
  assert.equal(a, b, "same reference → not re-derived");
  assert.equal(cache.stats().verified, 1);
  assert.equal(cache.stats().cached, 1);
});

test("per-DID: different DIDs each get their own slot", () => {
  const cache = new DerivationCache();
  cache.deriveAnchor([op(1)], { now: 0, did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" });
  cache.deriveAnchor([op(1)], { now: 0, did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" });
  assert.equal(cache.stats().verified, 2, "same bytes, different DID → both validated");
});

test("beginCycle resets the per-cycle counters", () => {
  const cache = new DerivationCache();
  cache.deriveLive([], DID);
  assert.equal(cache.stats().verified, 1);
  cache.beginCycle();
  assert.deepEqual(cache.stats(), { verified: 0, cached: 0 });
});

test("headsFromLive applies the 72h window fresh — no crypto, so it is safe on a memoized chain", () => {
  const base = Date.parse("2026-06-01T00:00:00Z");
  const live: LiveChain = {
    liveCids: new Set(["cidA", "cidB"]),
    head: { cid: "cidB", createdAt: new Date(base + 1000).toISOString() },
    ops: [
      { cid: "cidA", createdAt: new Date(base).toISOString() },
      { cid: "cidB", createdAt: new Date(base + 1000).toISOString() },
    ],
  };

  // Right after authoring: nothing has crossed the 72h window → no confirmed head.
  assert.deepEqual(headsFromLive(live, base + 1000), { confirmedHead: "", tentativeHead: "cidB" });

  // After the window closes on the first op only: it becomes confirmed; the tip stays tentative.
  const afterA = base + RECOVERY_WINDOW_MS + 1;
  assert.deepEqual(headsFromLive(live, afterA), { confirmedHead: "cidA", tentativeHead: "cidB" });

  // After the window closes on both: the tip is confirmed too.
  const afterB = base + 1000 + RECOVERY_WINDOW_MS + 1;
  assert.deepEqual(headsFromLive(live, afterB), { confirmedHead: "cidB", tentativeHead: "cidB" });
});
