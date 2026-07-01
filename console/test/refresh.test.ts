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
  const divergedCount = await new RefreshService(s, checker).refreshAll();
  assert.equal(divergedCount, 1);
  assert.equal(checked.length, 3, "the two anchored DIDs and the candidate are checked");
  assert.ok(!checked.some((d) => d.includes("dddd")), "removed DIDs are skipped");
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
