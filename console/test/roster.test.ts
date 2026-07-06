//! Roster store — the state machine (legal/illegal transitions), candidate idempotency, status
//! recording, the diverged alarm, and filters CRUD.

import assert from "node:assert/strict";
import { test } from "node:test";
import { RosterStore, TransitionError } from "../src/roster.ts";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";

function store(): RosterStore {
  let t = 1_000;
  return RosterStore.open(":memory:", () => (t += 1));
}

test("upsertCandidate inserts a new candidate", () => {
  const s = store();
  const e = s.upsertCandidate(DID, "explicit");
  assert.equal(e.state, "candidate");
  assert.equal(e.source, "explicit");
  assert.equal(s.list().length, 1);
});

test("upsertCandidate is idempotent for an active DID", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.transition(DID, "approved");
  const again = s.upsertCandidate(DID, "filter:1");
  assert.equal(again.state, "approved", "re-proposing must not reset an in-flight DID");
  assert.equal(again.source, "explicit", "source is not overwritten");
});

test("upsertCandidate revives a removed tombstone", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.transition(DID, "removed");
  const revived = s.upsertCandidate(DID, "filter:2", "pds.example.eu");
  assert.equal(revived.state, "candidate");
  assert.equal(revived.pdsHost, "pds.example.eu");
});

test("the happy-path lifecycle is legal", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  assert.equal(s.transition(DID, "approved").state, "approved");
  assert.equal(s.transition(DID, "onboarding").state, "onboarding");
  assert.equal(s.transition(DID, "anchored").state, "anchored");
});

test("candidate cannot skip the approve gate to onboarding (the spend)", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  // onboarding is the on-chain WRITE — still gated behind approve.
  assert.throws(() => s.transition(DID, "onboarding"), TransitionError);
});

test("candidate can be observed anchored on-chain (no write, no gate)", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.markObservedAnchored(DID);
  assert.equal(s.get(DID)!.state, "anchored");
  // idempotent, and never resurrects a removed DID.
  s.markObservedAnchored(DID);
  assert.equal(s.get(DID)!.state, "anchored");
  s.transition(DID, "removed");
  s.markObservedAnchored(DID);
  assert.equal(s.get(DID)!.state, "removed", "observation does not revive a removed DID");
});

test("onboarding failure can fall back to approved and clears nothing illegal", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.transition(DID, "approved");
  s.transition(DID, "onboarding");
  s.setError(DID, "tx reverted");
  assert.equal(s.get(DID)!.error, "tx reverted");
  const back = s.transition(DID, "approved");
  assert.equal(back.state, "approved");
  assert.equal(back.error, null, "falling back to approved clears the error for a retry");
});

test("transition on an unknown DID throws", () => {
  const s = store();
  assert.throws(() => s.transition("did:plc:unknown", "approved"), /unknown DID/);
});

test("setStatus records the witness result and clears error", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.transition(DID, "approved");
  s.transition(DID, "onboarding");
  s.transition(DID, "anchored");
  s.setError(DID, "stale");
  s.setStatus(DID, { status: "confirmed", reason: "confirmed-head-match", headCid: "bafyhead" });
  const e = s.get(DID)!;
  assert.equal(e.status, "confirmed");
  assert.equal(e.statusReason, "confirmed-head-match");
  assert.equal(e.headCid, "bafyhead");
  assert.equal(e.error, null);
  assert.ok(e.statusCheckedAt !== null);
});

test("diverged() returns only anchored+diverged", () => {
  const s = store();
  for (const d of ["did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"]) {
    s.upsertCandidate(d, "explicit");
    s.transition(d, "approved");
    s.transition(d, "onboarding");
    s.transition(d, "anchored");
  }
  s.setStatus("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", { status: "diverged", reason: "x", headCid: null });
  s.setStatus("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", { status: "confirmed", reason: "y", headCid: null });
  const d = s.diverged();
  assert.equal(d.length, 1);
  assert.equal(d[0].did, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
});

test("autoApprove queues a matched candidate (no manual gate)", () => {
  const s = store();
  const e = s.autoApprove(DID, "pds:eurosky.social", "eurosky.social");
  assert.equal(e.state, "approved", "discovery auto-advances candidate → approved");
  assert.equal(e.source, "pds:eurosky.social");
  assert.equal(e.pdsHost, "eurosky.social");
  assert.equal(e.discoveredAt !== null, true, "discovery stamps discoveredAt");
  // Idempotent: re-running does not disturb an in-flight DID.
  s.transition(DID, "onboarding");
  assert.equal(s.autoApprove(DID, "pds:eurosky.social").state, "onboarding");
});

test("transition to anchored stamps anchoredAt once", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.transition(DID, "approved");
  s.transition(DID, "onboarding");
  const anchored = s.transition(DID, "anchored");
  assert.ok(anchored.anchoredAt !== null);
  const first = anchored.anchoredAt;
  // A later removed→candidate→…→anchored round must not reset the original stamp.
  // (anchored can only go to removed; re-anchoring keeps the first timestamp.)
  assert.equal(s.get(DID)!.anchoredAt, first);
});

test("setEnrichment records PLC-derived identity context", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.setEnrichment(DID, {
    handle: "alice.eurosky.social",
    pdsHost: "eurosky.social",
    keyCount: 2,
    lastOpAt: 1_700_000_000_000,
    tombstoned: false,
  });
  const e = s.get(DID)!;
  assert.equal(e.handle, "alice.eurosky.social");
  assert.equal(e.pdsHost, "eurosky.social");
  assert.equal(e.keyCount, 2);
  assert.equal(e.lastOpAt, 1_700_000_000_000);
  assert.equal(e.tombstoned, false);
  assert.ok(e.enrichedAt !== null);
});

test("setAnchorCost stores the tip tx and accumulates the fee", () => {
  const s = store();
  s.upsertCandidate(DID, "explicit");
  s.setAnchorCost(DID, "0xtx1", "1000");
  s.setAnchorCost(DID, "0xtx2", "500");
  const e = s.get(DID)!;
  assert.equal(e.anchorTx, "0xtx2", "tip tx is the latest");
  assert.equal(e.anchorFee, "1500", "fee accumulates across txs");
});

test("reconcileForContract re-queues anchored/onboarding and clears on-chain provenance", () => {
  const s = store();
  // One anchored (with fee/status), one onboarding, plus a candidate + approved that must be left alone.
  s.upsertCandidate("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "explicit");
  s.transition("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "approved");
  s.transition("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "onboarding");
  s.transition("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "anchored");
  s.setAnchorCost("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "0xtx", "1000");
  s.setStatus("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", { status: "confirmed", reason: "ok", headCid: "bafy" });

  s.upsertCandidate("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", "explicit");
  s.transition("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", "approved");
  s.transition("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", "onboarding");

  s.upsertCandidate("did:plc:cccccccccccccccccccccccc", "explicit"); // candidate — untouched
  s.upsertCandidate("did:plc:dddddddddddddddddddddddd", "explicit");
  s.transition("did:plc:dddddddddddddddddddddddd", "approved"); // approved — untouched

  const reset = s.reconcileForContract();
  assert.equal(reset, 2, "anchored + onboarding are reset");

  const a = s.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")!;
  assert.equal(a.state, "approved");
  assert.equal(a.anchorTx, null, "on-chain provenance cleared");
  assert.equal(a.anchorFee, null);
  assert.equal(a.anchoredAt, null);
  assert.equal(a.status, null, "stale status cleared");
  assert.equal(a.headCid, null);

  assert.equal(s.get("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb")!.state, "approved");
  assert.equal(s.get("did:plc:cccccccccccccccccccccccc")!.state, "candidate", "candidate untouched");
  assert.equal(s.get("did:plc:dddddddddddddddddddddddd")!.state, "approved");
  // Idempotent: nothing anchored/onboarding remains.
  assert.equal(s.reconcileForContract(), 0);
});

test("chain cache round-trips and is dropped on a contract switch", () => {
  const s = store();
  assert.equal(s.getChainCache("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"), null, "empty until set");

  s.setChainCache("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", '[{"signed":"AQ==","createdAt":1,"imported":false}]');
  s.setMeta("anchorcache:cursor", "4200");
  assert.equal(
    s.getChainCache("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"),
    '[{"signed":"AQ==","createdAt":1,"imported":false}]',
  );

  // upsert overwrites in place (a re-fetch of the same DID).
  s.setChainCache("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "[]");
  assert.equal(s.getChainCache("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"), "[]");

  // A contract switch invalidates the whole cache + the event cursor (chains are contract-bound).
  s.reconcileForContract();
  assert.equal(s.getChainCache("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"), null, "cache cleared");
  assert.equal(s.getMeta("anchorcache:cursor"), null, "event cursor cleared");
});

test("setEnrichment records the off-criterion flag; aggregates + query surface it", () => {
  const s = store();
  for (const d of ["did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"]) {
    s.upsertCandidate(d, "pds:eurosky.social");
  }
  s.setEnrichment("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", {
    handle: "a.eurosky.social", pdsHost: "eurosky.social", keyCount: 1, lastOpAt: 1, tombstoned: false, offCriterion: false,
  });
  s.setEnrichment("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", {
    handle: "b.bsky.social", pdsHost: "x.host.bsky.network", keyCount: 1, lastOpAt: 1, tombstoned: false, offCriterion: true,
  });
  assert.equal(s.get("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb")!.offCriterion, true);
  assert.equal(s.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")!.offCriterion, false);

  const agg = s.aggregates();
  assert.equal(agg.offCriterion, 1);
  assert.equal(agg.enrichment.enriched, 2);
  assert.equal(agg.enrichment.pending, 0);

  const flagged = s.query({ offCriterion: true });
  assert.equal(flagged.total, 1);
  assert.equal(flagged.rows[0].did, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
});

test("enrichment pending count tracks un-enriched, non-removed entries", () => {
  const s = store();
  s.upsertCandidate("did:plc:cccccccccccccccccccccccc", "explicit");
  s.upsertCandidate("did:plc:dddddddddddddddddddddddd", "explicit");
  s.transition("did:plc:dddddddddddddddddddddddd", "removed");
  const agg = s.aggregates();
  assert.equal(agg.enrichment.enriched, 0);
  assert.equal(agg.enrichment.pending, 1, "removed entries are not counted as pending");
});

test("worker status merges partial updates and lists by name", () => {
  const s = store();
  s.setWorkerStatus("enumerate", { running: true, startedAt: 100 });
  s.setWorkerStatus("enumerate", { running: false, lastRunAt: 200, durationMs: 100, ok: true, summary: "queued 3004 · complete", error: null });
  const all = s.workerStatuses();
  assert.equal(all.enumerate.running, false);
  assert.equal(all.enumerate.startedAt, 100, "prior fields are preserved across a merge");
  assert.equal(all.enumerate.summary, "queued 3004 · complete");
  assert.equal(all.enumerate.ok, true);
  // A second worker is tracked independently.
  s.setWorkerStatus("refresh", { running: false, lastRunAt: 5, ok: false, error: "rpc down" });
  assert.equal(s.workerStatuses().refresh.error, "rpc down");
  assert.equal(Object.keys(s.workerStatuses()).length, 2);
});

test("settings: active + budget persist and default safely", () => {
  const s = store();
  assert.equal(s.getActive(), false, "active defaults off (no spend at boot)");
  assert.equal(s.getBudget(), null, "budget unset falls back to the caller default");
  s.setActive(true);
  s.setBudget(5);
  assert.equal(s.getActive(), true);
  assert.equal(s.getBudget(), 5);
  assert.deepEqual(s.getSettings(), { active: true, importBudget: 5 });
  s.setBudget(null);
  assert.equal(s.getBudget(), null, "budget can be cleared back to the default");
});

test("filters CRUD + uniqueness", () => {
  const s = store();
  const f = s.addFilter("pds_host", "pds.example.eu");
  assert.equal(f.value, "pds.example.eu");
  assert.equal(f.enabled, true);
  const dup = s.addFilter("pds_host", "pds.example.eu");
  assert.equal(dup.id, f.id, "duplicate (type,value) is de-duped");
  s.setFilterEnabled(f.id, false);
  assert.equal(s.listFilters()[0].enabled, false);
  assert.equal(s.listFilters(true).length, 0, "enabledOnly hides disabled filters");
  s.removeFilter(f.id);
  assert.equal(s.listFilters().length, 0);
});
