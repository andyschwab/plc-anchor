//! CI gate for the adversarial-validation suite: every read-class scenario in the generated
//! fixture must produce its specified graduated status through the real `check()`. This is the
//! pass/fail wall; `report.ts` renders the same outcomes as the engineer-facing narrative.
//!
//! In particular this pins the governing invariant (Phase 5 plan §0): the benign scenarios
//! (honest lag, window-edge skew) MUST resolve to a non-`diverged` status. A regression that
//! made the witness trigger-happy would fail here before it could ship.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFixture, runScenario } from "./harness.ts";

const fixture = loadFixture();
const readScenarios = fixture.scenarios.filter((s) => s.class === "read");
const writeScenarios = fixture.scenarios.filter((s) => s.class === "write");

test("fixture has both read- and write-class scenarios", () => {
  assert.ok(readScenarios.length > 0, "expected at least one read-class scenario");
  assert.ok(writeScenarios.length > 0, "expected at least one write-class scenario");
});

// Read-class: the witness check() must produce exactly the specified graduated status.
for (const s of readScenarios) {
  test(`read/${s.id}: ${s.title}`, async () => {
    const { actual } = await runScenario(s, fixture);
    assert.equal(actual.status, s.expect?.status, `status for ${s.id}`);
    assert.equal(actual.reason, s.expect?.reason, `reason for ${s.id}`);

    // The §0 wall: a benign disagreement must never alarm, regardless of what the expectation
    // string says — a regression that made the witness trigger-happy fails here.
    if (s.benign) {
      assert.notEqual(actual.status, "diverged", `${s.id} is benign and must not false-alarm`);
    }
  });
}

// Write-class: the enforcement proof is the generator's @did-plc/lib oracle assertion (the
// generator throws if a bad op is accepted) plus the Cairo recovery vectors. Here we pin that
// every write scenario is carrying a real rejection verdict with a contract reason.
for (const s of writeScenarios) {
  test(`write/${s.id}: ${s.title}`, () => {
    assert.ok(s.verdict, `${s.id} must carry a verdict`);
    assert.equal(s.verdict?.rejected, true, `${s.id} must be rejected`);
    assert.ok((s.verdict?.reason ?? "").length > 0, `${s.id} must name a rejection reason`);
    assert.ok((s.verdict?.defender ?? "").length > 0, `${s.id} must name a defender`);
  });
}
