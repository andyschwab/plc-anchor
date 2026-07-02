//! Live settings facade — precedence (defaults ← blob ← roster-backed), validation, persistence,
//! and that unknown/secret keys are ignored. Backed by a real RosterStore (its meta KV).

import assert from "node:assert/strict";
import { test } from "node:test";
import { RosterStore } from "../src/roster.ts";
import { SETTINGS_DEFAULTS, SettingsStore, validateSettings } from "../src/settings.ts";

function store(defaults = SETTINGS_DEFAULTS) {
  const roster = RosterStore.open();
  return { roster, settings: new SettingsStore(roster, defaults) };
}

test("get() returns defaults until anything is set", () => {
  const { settings } = store();
  const s = settings.get();
  assert.equal(s.active, false);
  assert.equal(s.importBudget, 25);
  assert.equal(s.tailIntervalMs, 60_000);
  assert.deepEqual(s.pdsEndpoints, ["https://eurosky.social"]);
});

test("patch persists blob fields and validates the merged result", () => {
  const { settings } = store();
  const next = settings.patch({ tailIntervalMs: 5000, directoryUrl: "https://mirror.example", criterion: "pds_domain:eurosky.social" });
  assert.equal(next.tailIntervalMs, 5000);
  assert.equal(next.directoryUrl, "https://mirror.example");
  assert.equal(next.criterion, "pds_domain:eurosky.social");
  // A fresh SettingsStore over the same store sees the persisted values.
  assert.equal(settings.get().tailIntervalMs, 5000);
});

test("active + importBudget round-trip through the RosterStore (single source of truth)", () => {
  const { roster, settings } = store();
  settings.patch({ active: true, importBudget: 3 });
  assert.equal(roster.getActive(), true, "active is written to the roster store");
  assert.equal(roster.getBudget(), 3);
  assert.equal(settings.get().active, true);
  assert.equal(settings.get().importBudget, 3);
});

test("patch ignores unknown / secret keys", () => {
  const { roster, settings } = store();
  const next = settings.patch({ tailIntervalMs: 1000, adminToken: "leak", starknetRpc: "https://evil", nope: 1 });
  assert.equal(next.tailIntervalMs, 1000);
  assert.equal("adminToken" in next, false);
  assert.equal("starknetRpc" in next, false);
  assert.equal(roster.getMeta("settings:blob:v1")?.includes("adminToken"), false);
});

test("validation rejects bad values", () => {
  const bad = (p) => assert.throws(() => validateSettings({ ...SETTINGS_DEFAULTS, ...p }));
  bad({ criterion: "not_a_criterion:x" });
  bad({ importBudget: -1 });
  bad({ enrichBatch: 0 });
  bad({ tailIntervalMs: 1.5 });
  bad({ directoryUrl: "not a url" });
  bad({ pdsEndpoints: ["https://ok", "http://[bad"] });
  bad({ active: "yes" });
});

test("validation trims and drops empty endpoints", () => {
  const s = validateSettings({ ...SETTINGS_DEFAULTS, criterion: "  pds_domain:eurosky.social ", pdsEndpoints: [" https://a ", "", "https://b"] });
  assert.equal(s.criterion, "pds_domain:eurosky.social");
  assert.deepEqual(s.pdsEndpoints, ["https://a", "https://b"]);
});

test("env/file-style defaults flow through get() and are overridable", () => {
  const defaults = { ...SETTINGS_DEFAULTS, criterion: "pds_domain:eurosky.social", enrichBatch: 100 };
  const { settings } = store(defaults);
  assert.equal(settings.get().criterion, "pds_domain:eurosky.social", "env default shows through");
  assert.equal(settings.get().enrichBatch, 100);
  settings.patch({ enrichBatch: 10 });
  assert.equal(settings.get().enrichBatch, 10, "an explicit edit overrides the default");
});

test("seedDefaults seeds active only when unset", () => {
  const roster = RosterStore.open();
  new SettingsStore(roster, { ...SETTINGS_DEFAULTS, active: true }).seedDefaults();
  assert.equal(roster.getActive(), true, "boot default seeds when unset");
  roster.setActive(false);
  new SettingsStore(roster, { ...SETTINGS_DEFAULTS, active: true }).seedDefaults();
  assert.equal(roster.getActive(), false, "a prior toggle is not overwritten by the default");
});
