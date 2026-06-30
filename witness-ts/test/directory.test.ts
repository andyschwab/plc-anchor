//! Directory head-selection gate (offline). The current head is the latest **non-nullified**
//! op — recovery marks superseded ops nullified, and the witness must follow the live branch,
//! not the abandoned one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type AuditEntry, directoryHead } from "../src/directory.ts";

const entry = (cid: string, createdAt: string, nullified = false): AuditEntry => ({
  did: "did:plc:test",
  cid,
  createdAt,
  nullified,
  operation: {},
});

test("head is the last entry of a clean (no-recovery) log", () => {
  const log = [entry("bafyA", "2024-01-01T00:00:00Z"), entry("bafyB", "2024-01-02T00:00:00Z")];
  assert.deepEqual(directoryHead(log), { cid: "bafyB", createdAt: "2024-01-02T00:00:00Z" });
});

test("head skips a nullified recovery tail back to the live branch", () => {
  // bafyB was forked away by a higher-priority key; bafyC is the live head.
  const log = [
    entry("bafyA", "2024-01-01T00:00:00Z"),
    entry("bafyB", "2024-01-02T00:00:00Z", true),
    entry("bafyC", "2024-01-02T06:00:00Z"),
  ];
  assert.deepEqual(directoryHead(log), { cid: "bafyC", createdAt: "2024-01-02T06:00:00Z" });
});

test("null when the log is empty or every op is nullified", () => {
  assert.equal(directoryHead([]), null);
  assert.equal(directoryHead([entry("bafyA", "2024-01-01T00:00:00Z", true)]), null);
});
