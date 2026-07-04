//! Refresh service — drives the (mocked) status checker over anchored DIDs and records results.
//! The real witness binding is exercised live elsewhere; here we only verify the wiring.

import assert from "node:assert/strict";
import { test } from "node:test";
import { RefreshService, type StatusChecker, type CheckOutcome } from "../src/refresh.ts";
import { RosterStore } from "../src/roster.ts";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";

function anchored(s: RosterStore, did = DID): void {
  s.upsertCandidate(did, "explicit");
  s.transition(did, "approved");
  s.transition(did, "onboarding");
  s.transition(did, "anchored");
}

test("refresh records the checker's outcome", async () => {
  const s = RosterStore.open();
  anchored(s);
  const checker: StatusChecker = {
    check: async (): Promise<CheckOutcome> => ({ status: "diverged", reason: "confirmed-head-absent", headCid: "bafyX" }),
  };
  await new RefreshService(s, checker).refresh(DID);
  const e = s.get(DID)!;
  assert.equal(e.status, "diverged");
  assert.equal(e.statusReason, "confirmed-head-absent");
  assert.equal(e.headCid, "bafyX");
});

test("a thrown check is captured as an error, not a crash", async () => {
  const s = RosterStore.open();
  anchored(s);
  const checker: StatusChecker = {
    check: async () => {
      throw new Error("rpc down");
    },
  };
  await new RefreshService(s, checker).refresh(DID);
  assert.equal(s.get(DID)!.error, "rpc down");
  assert.equal(s.get(DID)!.status, null);
});

test("refreshAll checks every active DID and returns the diverged count", async () => {
  const s = RosterStore.open();
  anchored(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  anchored(s, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
  s.upsertCandidate("did:plc:cccccccccccccccccccccccc", "explicit"); // a candidate — now also checked
  s.upsertCandidate("did:plc:dddddddddddddddddddddddd", "explicit");
  s.transition("did:plc:dddddddddddddddddddddddd", "removed"); // removed — skipped

  const checked: string[] = [];
  const checker: StatusChecker = {
    check: async (did): Promise<CheckOutcome> => {
      checked.push(did);
      return { status: did.includes("aaaa") ? "diverged" : "confirmed", reason: "r", headCid: null };
    },
  };
  const result = await new RefreshService(s, checker).refreshAll();
  assert.equal(result.diverged, 1);
  assert.equal(result.checked, 3);
  assert.equal(result.skipped, 0);
  assert.equal(checked.length, 3, "the two anchored DIDs and the candidate are checked");
  assert.ok(!checked.some((d) => d.includes("dddd")), "removed DIDs are skipped");
});

test("refreshAll calls the checker's beginCycle exactly once, before any check", async () => {
  const s = RosterStore.open();
  anchored(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  anchored(s, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");

  let beginCycleCalls = 0;
  let checksAtFirstBeginCycle = -1;
  let checkCount = 0;
  const checker: StatusChecker = {
    beginCycle: () => {
      beginCycleCalls += 1;
      checksAtFirstBeginCycle = checkCount;
    },
    check: async (): Promise<CheckOutcome> => {
      checkCount += 1;
      return { status: "confirmed", reason: "r", headCid: null };
    },
  };
  await new RefreshService(s, checker).refreshAll();
  assert.equal(beginCycleCalls, 1, "beginCycle runs once per refreshAll pass, not once per DID");
  assert.equal(checksAtFirstBeginCycle, 0, "beginCycle runs before any per-DID check");
});

test("refreshAll works when the checker has no beginCycle (optional hook)", async () => {
  const s = RosterStore.open();
  anchored(s);
  const checker: StatusChecker = {
    check: async (): Promise<CheckOutcome> => ({ status: "confirmed", reason: "r", headCid: null }),
  };
  const result = await new RefreshService(s, checker).refreshAll();
  assert.equal(result.diverged, 0);
});

test("root-change gate: an unchanged root skips already-checked DIDs on the next cycle", async () => {
  const s = RosterStore.open();
  anchored(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  anchored(s, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");

  let checkCalls = 0;
  const checker: StatusChecker = {
    currentRoots: async () => ({ confirmedRoot: "c1", tentativeRoot: "t1" }),
    check: async (): Promise<CheckOutcome> => {
      checkCalls += 1;
      return { status: "confirmed", reason: "r", headCid: null };
    },
  };
  const svc = new RefreshService(s, checker);

  const first = await svc.refreshAll();
  assert.equal(first.checked, 2, "first cycle: nothing checked yet, so everything is checked");
  assert.equal(first.skipped, 0);

  const second = await svc.refreshAll();
  assert.equal(checkCalls, 2, "no new RPC checks on an unchanged root");
  assert.equal(second.checked, 0);
  assert.equal(second.skipped, 2, "both already-checked DIDs are skipped");
});

test("root-change gate: a moved root forces a full re-check", async () => {
  const s = RosterStore.open();
  anchored(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  anchored(s, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");

  let root = "c1";
  const checker: StatusChecker = {
    currentRoots: async () => ({ confirmedRoot: root, tentativeRoot: "t1" }),
    check: async (): Promise<CheckOutcome> => ({ status: "confirmed", reason: "r", headCid: null }),
  };
  const svc = new RefreshService(s, checker);
  await svc.refreshAll();

  root = "c2"; // e.g. a new op anchored, or the 72h confirmation cutover
  const second = await svc.refreshAll();
  assert.equal(second.checked, 2, "root moved, so every active DID is re-checked");
  assert.equal(second.skipped, 0);
});

test("root-change gate: a new DID is always checked even when the root is unchanged", async () => {
  const s = RosterStore.open();
  anchored(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");

  const checker: StatusChecker = {
    currentRoots: async () => ({ confirmedRoot: "c1", tentativeRoot: "t1" }),
    check: async (): Promise<CheckOutcome> => ({ status: "confirmed", reason: "r", headCid: null }),
  };
  const svc = new RefreshService(s, checker);
  await svc.refreshAll();

  anchored(s, "did:plc:cccccccccccccccccccccccc"); // onboarded after the first cycle
  const second = await svc.refreshAll();
  assert.equal(second.checked, 1, "only the never-checked DID is checked");
  assert.equal(second.skipped, 1);
});

test("a candidate observed anchored on-chain is reflected and shows status", async () => {
  const s = RosterStore.open();
  s.upsertCandidate("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "explicit"); // anchored elsewhere (ingest)
  s.upsertCandidate("did:plc:cccccccccccccccccccccccc", "explicit"); // not on-chain
  const checker: StatusChecker = {
    check: async (did): Promise<CheckOutcome> =>
      did.includes("aaaa")
        ? { status: "confirmed", reason: "confirmed-head-match", headCid: "bafyX" }
        : { status: "absent", reason: "not-anchored", headCid: null },
  };
  await new RefreshService(s, checker).refreshAll();
  const observed = s.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")!;
  assert.equal(observed.state, "anchored", "on-chain DID promoted to anchored");
  assert.equal(observed.status, "confirmed");
  const stillCandidate = s.get("did:plc:cccccccccccccccccccccccc")!;
  assert.equal(stillCandidate.state, "candidate", "absent DID stays a candidate");
  assert.equal(stillCandidate.status, "absent");
});
