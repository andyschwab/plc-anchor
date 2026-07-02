//! Status-ladder scenario table (offline) — the witness's decision surface and the regression
//! wall for the governing invariant: **no benign edge resolves to `diverged`** (Phase 5 plan
//! §0). Fakes inject the anchor reads + directory log; single-leaf roots make proofs verify
//! trivially, so each row isolates the ladder branch, not the Merkle math.

import assert from "node:assert/strict";
import { test } from "node:test";
import { leafHash } from "../src/merkle.ts";
import { type AuditEntry } from "../src/directory.ts";
import { type AnchorView, check, type DirectorySource } from "../src/status.ts";

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const NOW = Date.parse("2026-06-30T00:00:00Z");
const ZERO = new Uint8Array(32);

function fakeAnchor(opts: {
  anchored?: boolean;
  confirmedHead?: string;
  tentativeHead?: string;
  breakProof?: boolean;
}): AnchorView {
  const cHead = opts.confirmedHead ?? "";
  const tHead = opts.tentativeHead ?? cHead;
  return {
    isAnchored: async () => opts.anchored ?? true,
    confirmedProof: async () => ({ head: cHead, proof: [] }),
    tentativeProof: async () => ({ head: tHead, proof: [] }),
    // Single-leaf root == the head's leaf, so an empty proof verifies (unless we break it).
    confirmedRoot: async () => (opts.breakProof || cHead === "" ? ZERO : leafHash(DID, cHead)),
    tentativeRoot: async () => (tHead === "" ? ZERO : leafHash(DID, tHead)),
  };
}

const entry = (cid: string, createdAt: string, nullified = false): AuditEntry => ({
  did: DID,
  cid,
  createdAt,
  nullified,
  operation: {},
});

const fakeDirectory = (log: AuditEntry[]): DirectorySource => ({ auditLog: async () => log });

const run = (anchor: AnchorView, dir: DirectorySource) => check(DID, anchor, dir, { now: () => NOW });

test("absent — DID not anchored", async () => {
  const r = await run(fakeAnchor({ anchored: false }), fakeDirectory([]));
  assert.equal(r.status, "absent");
});

test("confirmed — directory head == anchor confirmed head", async () => {
  const r = await run(
    fakeAnchor({ confirmedHead: "bafyHEAD", tentativeHead: "bafyHEAD" }),
    fakeDirectory([entry("bafyGEN", "2026-01-01T00:00:00Z"), entry("bafyHEAD", "2026-02-01T00:00:00Z")]),
  );
  assert.equal(r.status, "confirmed");
  assert.equal(r.reason, "confirmed-head-match");
});

test("tentative-consistent — nothing confirmed yet (all within window)", async () => {
  const r = await run(
    fakeAnchor({ confirmedHead: "", tentativeHead: "bafyTIP" }),
    fakeDirectory([entry("bafyTIP", "2026-06-29T23:00:00Z")]),
  );
  assert.equal(r.status, "tentative-consistent");
  assert.equal(r.reason, "within-window-uncommitted");
});

test("tentative-consistent — confirmed head still in the directory's live chain (ingest lag)", async () => {
  // Anchor confirmed bafyA; the directory has moved on to bafyB but bafyA is still on its chain.
  const r = await run(
    fakeAnchor({ confirmedHead: "bafyA", tentativeHead: "bafyA" }),
    fakeDirectory([entry("bafyA", "2026-02-01T00:00:00Z"), entry("bafyB", "2026-06-29T00:00:00Z")]),
  );
  assert.equal(r.status, "tentative-consistent");
  assert.equal(r.reason, "confirmed-head-in-live-chain");
});

test("tentative-consistent — anchor's own confirmed proof doesn't verify (anchor-side issue, not divergence)", async () => {
  const r = await run(
    fakeAnchor({ confirmedHead: "bafyA", breakProof: true }),
    fakeDirectory([entry("bafyZ", "2020-01-01T00:00:00Z")]),
  );
  assert.equal(r.status, "tentative-consistent");
  assert.equal(r.reason, "anchor-proof-unverified");
});

test("diverged — confirmed head absent from a stable, old directory chain", async () => {
  // Anchor confirmed bafyA; the directory serves a different, OLD head that omits it entirely.
  const r = await run(
    fakeAnchor({ confirmedHead: "bafyA", tentativeHead: "bafyA" }),
    fakeDirectory([entry("bafyOTHER", "2024-01-01T00:00:00Z")]),
  );
  assert.equal(r.status, "diverged");
  assert.equal(r.reason, "confirmed-head-absent");
});

test("WALL: skew-pending — confirmed head absent but directory head is recent (no false diverged)", async () => {
  // Same contradiction as the diverged row, but the directory's head is fresh → a window-edge
  // recovery the anchor accepted later could explain it. MUST NOT alarm.
  const r = await run(
    fakeAnchor({ confirmedHead: "bafyA", tentativeHead: "bafyA" }),
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
    fakeAnchor({ confirmedHead: "bafyA", tentativeHead: "bafyA" }),
    fakeDirectory([entry("bafyOTHER", "not-a-date")]),
  );
  assert.equal(r.status, "error");
  assert.equal(r.reason, "directory-timestamp-unparseable");
});

test("diverged — anchored with a confirmed head the directory serves nothing for", async () => {
  const r = await run(
    fakeAnchor({ confirmedHead: "bafyA", tentativeHead: "bafyA" }),
    fakeDirectory([]),
  );
  assert.equal(r.status, "diverged");
});
