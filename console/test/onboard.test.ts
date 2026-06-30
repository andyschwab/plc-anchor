//! Onboarder — drives a fake runner over approved DIDs and checks the lifecycle + the ingest
//! argv it builds. No live ingest / Starknet / network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommandRunner, Onboarder, type RunResult } from "../src/onboard.ts";
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

test("successful onboard moves approved → anchored and builds the right argv", async () => {
  const s = RosterStore.open();
  approved(s);
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "anchored", stderr: "" });
  const ok = await new Onboarder(s, runner, config).onboard(DID);
  assert.equal(ok, true);
  assert.equal(s.get(DID)!.state, "anchored");
  assert.deepEqual(runner.calls[0], [
    "ingest",
    "--did",
    DID,
    "--submit",
    "--source",
    "https://plc.directory",
  ]);
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

test("onboardApproved processes every approved DID and counts successes", async () => {
  const s = RosterStore.open();
  approved(s, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  approved(s, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
  s.upsertCandidate("did:plc:cccccccccccccccccccccccc", "explicit"); // candidate, skipped
  const runner = new FakeRunner({ ok: true, code: 0, stdout: "", stderr: "" });
  const anchored = await new Onboarder(s, runner, config).onboardApproved();
  assert.equal(anchored, 2);
  assert.equal(runner.calls.length, 2);
});
