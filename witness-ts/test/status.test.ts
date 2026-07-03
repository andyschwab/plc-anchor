//! Status-ladder scenario table (offline) — the witness's decision surface and the regression
//! wall for the governing invariant: **no benign edge resolves to `diverged`** (Phase 5 plan
//! §0). Fakes inject the anchor's re-derived heads + the directory log, so each row isolates a
//! ladder branch, not the chain re-derivation (which `nullified.test.ts` covers directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { directoryHead, type AuditEntry, type LiveChain } from "../src/directory.ts";
import {
  type AnchorHeads,
  type AnchorView,
  check,
  type CheckOptions,
  type DirectorySource,
} from "../src/status.ts";

// These rows isolate the status LADDER, driving it with stub ops and explicit `nullified` labels;
// they inject a flag-based live derivation (directory) and a fixed-heads anchor derivation, so the
// crypto re-derivation (tested in nullified.test.ts) doesn't reject the stubs. The labels ARE the
// test input here.
const flagLive = (log: readonly AuditEntry[]): LiveChain => ({
  liveCids: new Set(log.filter((e) => !e.nullified).map((e) => e.cid)),
  head: directoryHead(log),
});

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const NOW = Date.parse("2026-06-30T00:00:00Z");

function fakeAnchor(anchored = true): AnchorView {
  return { isAnchored: async () => anchored, chain: async () => [] };
}

const fixedHeads =
  (confirmedHead: string, tentativeHead = confirmedHead) =>
  (): AnchorHeads => ({ confirmedHead, tentativeHead });

const entry = (cid: string, createdAt: string, nullified = false): AuditEntry => ({
  did: DID,
  cid,
  createdAt,
  nullified,
  operation: {},
});

const fakeDirectory = (log: AuditEntry[]): DirectorySource => ({ auditLog: async () => log });

const run = (
  heads: NonNullable<CheckOptions["deriveAnchor"]>,
  dir: DirectorySource,
  anchored = true,
) => check(DID, fakeAnchor(anchored), dir, { now: () => NOW, deriveLive: flagLive, deriveAnchor: heads });

test("absent — DID not anchored", async () => {
  const r = await run(fixedHeads(""), fakeDirectory([]), false);
  assert.equal(r.status, "absent");
});

test("confirmed — directory head == anchor confirmed head", async () => {
  const r = await run(
    fixedHeads("bafyHEAD"),
    fakeDirectory([entry("bafyGEN", "2026-01-01T00:00:00Z"), entry("bafyHEAD", "2026-02-01T00:00:00Z")]),
  );
  assert.equal(r.status, "confirmed");
  assert.equal(r.reason, "confirmed-head-match");
});

test("tentative-consistent — nothing confirmed yet (all within window)", async () => {
  const r = await run(
    fixedHeads("", "bafyTIP"),
    fakeDirectory([entry("bafyTIP", "2026-06-29T23:00:00Z")]),
  );
  assert.equal(r.status, "tentative-consistent");
  assert.equal(r.reason, "within-window-uncommitted");
});

test("tentative-consistent — confirmed head still in the directory's live chain (ingest lag)", async () => {
  // Anchor confirmed bafyA; the directory has moved on to bafyB but bafyA is still on its chain.
  const r = await run(
    fixedHeads("bafyA"),
    fakeDirectory([entry("bafyA", "2026-02-01T00:00:00Z"), entry("bafyB", "2026-06-29T00:00:00Z")]),
  );
  assert.equal(r.status, "tentative-consistent");
  assert.equal(r.reason, "confirmed-head-in-live-chain");
});

test("diverged — confirmed head absent from a stable, old directory chain", async () => {
  // Anchor confirmed bafyA; the directory serves a different, OLD head that omits it entirely.
  const r = await run(
    fixedHeads("bafyA"),
    fakeDirectory([entry("bafyOTHER", "2024-01-01T00:00:00Z")]),
  );
  assert.equal(r.status, "diverged");
  assert.equal(r.reason, "confirmed-head-absent");
});

test("WALL: skew-pending — confirmed head absent but directory head is recent (no false diverged)", async () => {
  // Same contradiction as the diverged row, but the directory's head is fresh → a window-edge
  // recovery the anchor accepted later could explain it. MUST NOT alarm.
  const r = await run(
    fixedHeads("bafyA"),
    fakeDirectory([entry("bafyRECOVERED", "2026-06-29T12:00:00Z")]),
  );
  assert.notEqual(r.status, "diverged");
  assert.equal(r.status, "tentative-consistent");
  assert.equal(r.reason, "skew-pending");
});

test("error — confirmed head absent and the directory head's createdAt is unparseable", async () => {
  // Same contradiction as the diverged/skew rows, but the directory serves a malformed timestamp
  // so the skew/divergence split can't be made. MUST surface as `error`, never silently absorbed
  // into a non-alarming verdict (SECURITY-TODO item 4).
  const r = await run(
    fixedHeads("bafyA"),
    fakeDirectory([entry("bafyOTHER", "not-a-date")]),
  );
  assert.equal(r.status, "error");
  assert.equal(r.reason, "directory-timestamp-unparseable");
});

test("diverged — anchored with a confirmed head the directory serves nothing for", async () => {
  const r = await run(fixedHeads("bafyA"), fakeDirectory([]));
  assert.equal(r.status, "diverged");
});
