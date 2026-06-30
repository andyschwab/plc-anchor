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

test("fixture has read-class scenarios", () => {
  assert.ok(readScenarios.length > 0, "expected at least one read-class scenario");
});

for (const s of readScenarios) {
  test(`${s.id}: ${s.title}`, async () => {
    const { actual } = await runScenario(s, fixture);
    assert.equal(actual.status, s.expect.status, `status for ${s.id}`);
    assert.equal(actual.reason, s.expect.reason, `reason for ${s.id}`);

    // The §0 wall: a benign disagreement must never alarm, regardless of what the expectation
    // string says — a regression that made the witness trigger-happy fails here.
    if (s.benign) {
      assert.notEqual(actual.status, "diverged", `${s.id} is benign and must not false-alarm`);
    }
  });
}
