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
