//! Offline test of the HTTP malicious-mirror wrapper. Unlike `adversarial.test.ts` (which uses
//! the in-process `MaliciousDirectory`), this drives the **real `DirectoryClient` fetch
//! transport** against a real (loopback) URL — so the live runner's only untested-here piece is
//! the Sepolia anchor read. Proves: the PLC audit-log route round-trips, head selection works
//! over the wire, a 404 reads as an empty log, and a full `check()` runs through real fetch.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { leafHash } from "../witness-ts/src/merkle.ts";
import { type AuditEntry, DirectoryClient } from "../witness-ts/src/directory.ts";
import { type AnchorView, check } from "../witness-ts/src/status.ts";
import { startMaliciousMirror } from "./mirror.ts";

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const ZERO = new Uint8Array(32);

const entry = (cid: string, createdAt: string, nullified = false): AuditEntry => ({ did: DID, cid, createdAt, nullified, operation: {} });

// A fake anchor with a single-leaf commitment, so an empty proof verifies trivially and each
// assertion isolates the directory/transport behavior, not the Merkle math. The leaf is built
// over `did` (the subject `check` is called with), so the inclusion proof verifies.
function fakeAnchor(did: string, confirmedHead: string): AnchorView {
  return {
    isAnchored: async () => true,
    confirmedProof: async () => ({ head: confirmedHead, proof: [] }),
    tentativeProof: async () => ({ head: confirmedHead, proof: [] }),
    confirmedRoot: async () => (confirmedHead === "" ? ZERO : leafHash(did, confirmedHead)),
    tentativeRoot: async () => (confirmedHead === "" ? ZERO : leafHash(did, confirmedHead)),
  };
}

const mirror = await startMaliciousMirror(
  new Map([
    // The honest DID: a log whose live head is the anchor's confirmed head.
    [DID, [entry("bafyGEN", "2026-01-01T00:00:00Z"), entry("bafyCONFIRMED", "2026-02-01T00:00:00Z")]],
    // An equivocating subject: an old chain that omits the anchor's confirmed head entirely.
    ["did:plc:equivocator0000000000000", [entry("bafyFORGED", "2023-01-01T00:00:00Z")]],
  ]),
);
after(() => mirror.close());

const directory = new DirectoryClient(mirror.baseUrl);

test("real DirectoryClient fetches the malicious mirror's audit log over the wire", async () => {
  const log = await directory.auditLog(DID);
  assert.equal(log.length, 2);
  assert.equal(log[1].cid, "bafyCONFIRMED");
  const head = await directory.head(DID);
  assert.equal(head?.cid, "bafyCONFIRMED");
});

test("a DID the mirror doesn't list reads as an empty log (404 → [])", async () => {
  const log = await directory.auditLog("did:plc:neverlistedheredoesnotexist");
  assert.deepEqual(log, []);
});

test("end-to-end through real fetch: honest mirror → confirmed", async () => {
  const r = await check(DID, fakeAnchor(DID, "bafyCONFIRMED"), directory);
  assert.equal(r.status, "confirmed");
  assert.equal(r.reason, "confirmed-head-match");
});

test("end-to-end through real fetch: equivocating mirror (old, omits confirmed head) → diverged", async () => {
  const equiv = "did:plc:equivocator0000000000000";
  const r = await check(equiv, fakeAnchor(equiv, "bafyCONFIRMED"), directory);
  assert.equal(r.status, "diverged");
  assert.equal(r.reason, "confirmed-head-absent");
});

test("end-to-end through real fetch: vanishing DID (404) with a confirmed head → diverged", async () => {
  const gone = "did:plc:neverlistedheredoesnotexist";
  const r = await check(gone, fakeAnchor(gone, "bafyCONFIRMED"), directory);
  assert.equal(r.status, "diverged");
});
