//! Onboarder — drives a fake runner over approved DIDs and checks the lifecycle, the ingest argv,
//! the Active/budget spend gate, and cost capture from ingest's ANCHORED lines. No live ingest /
//! Starknet / network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommandRunner, Onboarder, parseAnchorLines, type RunResult } from "../src/onboard.ts";
import { RosterStore } from "../src/roster.ts";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const config = { ingestCommand: ["ingest"], source: "https://plc.directory" };

function approved(s: RosterStore, did = DID): void {
  s.upsertCandidate(did, "explicit");
  s.transition(did, "approved");
}

class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  #result: RunResult;
  constructor(result: RunResult) {
    this.#result = result;
  }
  run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    return Promise.resolve(this.#result);
  }
}

test("parseAnchorLines pulls tx + optional fee, ignoring other output", () => {
  const stdout = [
    "ingest: fetched 3 ops",
    "ANCHORED did:plc:aaa tx=0xabc fee=12345",
    "ANCHORED did:plc:aaa tx=0xdef",
    "some other line",
  ].join("\n");
  const lines = parseAnchorLines(stdout);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { did: "did:plc:aaa", tx: "0xabc", fee: "12345" });
  assert.deepEqual(lines[1], { did: "did:plc:aaa", tx: "0xdef", fee: null });
});

test("successful onboard moves approved → anchored and builds the right argv", async () => {
  const s = RosterStore.open();
  approved(s);
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "anchored", stderr: "" });
  const ok = await new Onboarder(s, runner, config).onboard(DID);
  assert.equal(ok, true);
  assert.equal(s.get(DID)!.state, "anchored");
  assert.ok(s.get(DID)!.anchoredAt !== null);
  assert.deepEqual(runner.calls[0], [
    "ingest",
    "--did",
    DID,
    "--submit",
    "--source",
    "https://plc.directory",
  ]);
});

test("onboard captures tx hash + accumulated fee from ingest's ANCHORED lines", async () => {
  const s = RosterStore.open();
  approved(s);
  const stdout = `ANCHORED ${DID} tx=0xgenesis fee=1000\nANCHORED ${DID} tx=0xappend fee=500\n`;
  const runner = new FakeRunner({ ok: true, code: 0, stdout, stderr: "" });
  await new Onboarder(s, runner, config).onboard(DID);
  const e = s.get(DID)!;
  assert.equal(e.anchorTx, "0xappend", "tip tx is stored");
  assert.equal(e.anchorFee, "1500", "fees accumulate across genesis + append");
});

test("onboard resolves the fee via the FeeResolver when the ANCHORED line omits it", async () => {
  const s = RosterStore.open();
  approved(s);
  const stdout = `ANCHORED ${DID} tx=0xabc\n`; // hash only — no fee on the line
  const runner = new FakeRunner({ ok: true, code: 0, stdout, stderr: "" });
  const resolver = async (tx: string) => (tx === "0xabc" ? "777" : null);
  await new Onboarder(s, runner, config, resolver).onboard(DID);
  const e = s.get(DID)!;
  assert.equal(e.anchorTx, "0xabc");
  assert.equal(e.anchorFee, "777", "fee filled in from the RPC resolver");
});

test("failed onboard falls back to approved and records the error", async () => {
  const s = RosterStore.open();
  approved(s);
  const runner = new FakeRunner({ ok: false, code: 1, stdout: "", stderr: "tx reverted: import-fork" });
  const ok = await new Onboarder(s, runner, config).onboard(DID);
  assert.equal(ok, false);
  assert.equal(s.get(DID)!.state, "approved");
  assert.match(s.get(DID)!.error!, /import-fork/);
});

test("onboard refuses a DID that is not approved", async () => {
  const s = RosterStore.open();
  s.upsertCandidate(DID, "explicit"); // still a candidate
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "", stderr: "" });
  await assert.rejects(() => new Onboarder(s, runner, config).onboard(DID), /expected approved/);
  assert.equal(runner.calls.length, 0, "no ingest run for an unapproved DID");
});

test("onboardApproved is a no-op while Inactive (the spend gate)", async () => {
  const s = RosterStore.open();
  approved(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "", stderr: "" });
  const r = await new Onboarder(s, runner, config).onboardApproved();
  assert.equal(r.active, false);
  assert.equal(r.attempted, 0);
  assert.equal(runner.calls.length, 0, "nothing spends while inactive");
  assert.equal(s.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")!.state, "approved");
});

test("onboardApproved processes approved DIDs when Active and counts successes", async () => {
  const s = RosterStore.open();
  s.setActive(true);
  approved(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  approved(s, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
  s.upsertCandidate("did:plc:cccccccccccccccccccccccc", "explicit"); // candidate, skipped
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "", stderr: "" });
  const r = await new Onboarder(s, runner, config).onboardApproved();
  assert.equal(r.anchored, 2);
  assert.equal(r.attempted, 2);
  assert.equal(runner.calls.length, 2);
});

test("onboardApproved caps at the per-tick budget", async () => {
  const s = RosterStore.open();
  s.setActive(true);
  for (const c of "abcde") approved(s, `did:plc:${c.repeat(24)}`);
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "", stderr: "" });
  const r = await new Onboarder(s, runner, { ...config, defaultBudget: 2 }).onboardApproved();
  assert.equal(r.budget, 2);
  assert.equal(r.attempted, 2, "only budget-many are handed to ingest");
  assert.equal(runner.calls.length, 2);
  assert.equal(s.list("approved").length, 3, "the rest stay queued for the next tick");
});

test("a store budget override beats the config default", async () => {
  const s = RosterStore.open();
  s.setActive(true);
  s.setBudget(1);
  for (const c of "abc") approved(s, `did:plc:${c.repeat(24)}`);
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "", stderr: "" });
  const r = await new Onboarder(s, runner, { ...config, defaultBudget: 10 }).onboardApproved();
  assert.equal(r.budget, 1);
  assert.equal(r.attempted, 1);
});
