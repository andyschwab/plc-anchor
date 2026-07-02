//! Directory head-selection gate (offline). The current head is the latest **non-nullified**
//! op — recovery marks superseded ops nullified, and the witness must follow the live branch,
//! not the abandoned one.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuditEntry,
  DirectoryClient,
  directoryHead,
  parseAuditLog,
} from "../src/directory.ts";

const entry = (cid: string, createdAt: string, nullified = false): AuditEntry => ({
  did: "did:plc:test",
  cid,
  createdAt,
  nullified,
  operation: { type: "plc_operation" },
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

// --- Response validation (SECURITY-TODO item 2) ---

test("parseAuditLog accepts a well-formed log", () => {
  const log = [entry("bafyA", "2024-01-01T00:00:00Z")];
  assert.deepEqual(parseAuditLog(log, "did:plc:test"), log);
});

test("parseAuditLog rejects a non-array body", () => {
  assert.throws(() => parseAuditLog({ not: "an array" }, "did:plc:test"), /expected a JSON array/);
});

test("parseAuditLog rejects an entry with a missing field", () => {
  const bad = [{ did: "did:plc:test", cid: "bafyA", createdAt: "2024-01-01T00:00:00Z" }];
  assert.throws(() => parseAuditLog(bad, "did:plc:test"), /entry 0 missing or has malformed fields/);
});

test("parseAuditLog rejects an entry with a mistyped field (nullified as string)", () => {
  const bad = [
    { did: "did:plc:test", cid: "bafyA", createdAt: "x", nullified: "false", operation: {} },
  ];
  assert.throws(() => parseAuditLog(bad, "did:plc:test"), /malformed fields/);
});

test("parseAuditLog rejects an over-long log", () => {
  const many = Array.from({ length: 10_001 }, (_, i) => entry(`bafy${i}`, "2024-01-01T00:00:00Z"));
  assert.throws(() => parseAuditLog(many, "did:plc:test"), /exceeds cap/);
});

/** Build a `DirectoryClient` whose transport returns a fixed body. */
const clientReturning = (body: string, init?: ResponseInit) =>
  new DirectoryClient("https://plc.directory", async () => new Response(body, init));

test("auditLog returns [] on 404", async () => {
  const log = await clientReturning("", { status: 404 }).auditLog("did:plc:test");
  assert.deepEqual(log, []);
});

test("auditLog validates and returns a well-formed body", async () => {
  const log = [entry("bafyA", "2024-01-01T00:00:00Z")];
  const got = await clientReturning(JSON.stringify(log)).auditLog("did:plc:test");
  assert.deepEqual(got, log);
});

test("auditLog throws on a malformed entry rather than coercing undefined", async () => {
  const body = JSON.stringify([{ cid: "bafyA" }]);
  await assert.rejects(clientReturning(body).auditLog("did:plc:test"), /malformed fields/);
});

test("auditLog throws on invalid JSON", async () => {
  await assert.rejects(clientReturning("{not json").auditLog("did:plc:test"), /invalid JSON/);
});

test("auditLog rejects a body whose Content-Length exceeds the cap", async () => {
  const client = clientReturning("[]", {
    headers: { "content-length": String(9 * 1024 * 1024) },
  });
  await assert.rejects(client.auditLog("did:plc:test"), /exceeds cap/);
});
