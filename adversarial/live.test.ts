//! Live adversarial read against the deployed Sepolia anchor — gated, manual (parallel to
//! `witness-ts/test/live.test.ts` and the Rust `live_e2e`). The full data path under attack:
//! the REAL `AnchorReader` reading real on-chain state, paired with a malicious mirror served
//! over HTTP so the REAL `DirectoryClient` fetch transport is exercised, run through the REAL
//! `check()`. Nothing is mocked.
//!
//!   WITNESS_LIVE_RPC=https://<keyed-sepolia> \
//!   WITNESS_LIVE_DID=did:plc:<anchored> \
//!     node --test adversarial/live.test.ts
//!   # optional: WITNESS_LIVE_CONTRACT=0x… (defaults to the recorded deployment)
//!
//! The runner reads the anchor's real head, then synthesizes the mirror's lie *relative to it*,
//! so the expectations adjust to on-chain reality: the confirmed-`diverged` headline requires a
//! DID with a confirmed head (anchored ≥72h ago); for a still-within-window DID the same attack
//! correctly yields a non-alarming status, and the runner says so rather than failing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AnchorReader } from "../witness-ts/src/starknet.ts";
import { directoryHead, type AuditEntry, DirectoryClient, type LiveChain } from "../witness-ts/src/directory.ts";
import { check } from "../witness-ts/src/status.ts";
import { startMaliciousMirror } from "./mirror.ts";

// Live transport/anchor test: the mirror serves stub ops keyed by CID (not full signed chains),
// so it drives the ladder with a flag-based live derivation. The crypto re-derivation of
// `nullified` is covered offline in witness-ts/test/nullified.test.ts.
const flagLive = (log: readonly AuditEntry[]): LiveChain => ({
  liveCids: new Set(log.filter((e) => !e.nullified).map((e) => e.cid)),
  head: directoryHead(log),
});

const RPC = process.env.WITNESS_LIVE_RPC;
// Default to the recorded Sepolia deployment (tracks redeploys); override with WITNESS_LIVE_CONTRACT.
const recordedSepolia = (): string =>
  JSON.parse(readFileSync(new URL("../deployments/sepolia.json", import.meta.url), "utf8")).contractAddress;
const CONTRACT = process.env.WITNESS_LIVE_CONTRACT ?? recordedSepolia();
const LIVE_DID = process.env.WITNESS_LIVE_DID;

const skipLive = RPC ? false : "set WITNESS_LIVE_RPC to run the live adversarial read";
const skipDid = skipLive || (LIVE_DID ? false : "set WITNESS_LIVE_DID to a known-anchored DID");

const entry = (did: string, cid: string, createdAt: string): AuditEntry => ({ did, cid, createdAt, nullified: false, operation: {} });

/** Serve `logsByDid`, run `check(did)` against the real anchor through the real fetch path. */
async function checkAgainstMirror(did: string, logsByDid: Map<string, AuditEntry[]>) {
  const anchor = AnchorReader.http(RPC as string, CONTRACT);
  const mirror = await startMaliciousMirror(logsByDid);
  try {
    return await check(did, anchor, new DirectoryClient(mirror.baseUrl), { deriveLive: flagLive });
  } finally {
    await mirror.close();
  }
}

/** Verify-on-read: the anchor exposes no head/root view, so derive its confirmed + tentative
 * heads the way `check()` does — re-derive from the on-chain `chain(did)` op log, resolving each
 * op body content-addressed against the HONEST directory (real plc.directory). Reads the derived
 * heads straight out of `check`'s evidence so this stays in lockstep with the real ladder. */
async function anchorHeads(did: string): Promise<{ confirmedHead: string; tentativeHead: string }> {
  const anchor = AnchorReader.http(RPC as string, CONTRACT);
  const r = await check(did, anchor, new DirectoryClient());
  return {
    confirmedHead: r.evidence.anchorConfirmedHead,
    tentativeHead: r.evidence.anchorTentativeHead,
  };
}

// Always-runnable (no anchored DID needed): the malicious mirror can't manufacture coverage. An
// unanchored DID short-circuits to `absent` before the directory is even consulted — proving the
// real anchor read and the real fetch wiring are both live.
test("live: an unanchored DID is `absent` no matter what the mirror serves", { skip: skipLive }, async () => {
  const gone = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
  const r = await checkAgainstMirror(gone, new Map([[gone, [entry(gone, "bafyMIRRORINVENTEDTHIS", "2020-01-01T00:00:00Z")]]]));
  assert.equal(r.status, "absent");
});

test("live: an honest mirror for the anchored DID is never an alarm", { skip: skipDid }, async (t) => {
  const did = LIVE_DID as string;
  const { confirmedHead, tentativeHead } = await anchorHeads(did);
  const head = confirmedHead || tentativeHead;
  t.diagnostic(`anchor: confirmedHead=${confirmedHead || "(none)"} tentativeHead=${tentativeHead}`);

  // Serve a log whose live head is the anchor's head (with the confirmed head present below it).
  const log = [entry(did, head, "2026-01-01T00:00:00Z")];
  if (tentativeHead && tentativeHead !== head) log.push(entry(did, tentativeHead, new Date().toISOString()));
  const r = await checkAgainstMirror(did, new Map([[did, log]]));
  t.diagnostic(`verdict: ${r.status} (${r.reason})`);
  assert.notEqual(r.status, "diverged");
  assert.notEqual(r.status, "absent");
});

test("live: an equivocating mirror (old, omits the anchor head) — diverged iff confirmed", { skip: skipDid }, async (t) => {
  const did = LIVE_DID as string;
  const { confirmedHead } = await anchorHeads(did);

  // The mirror serves an old forged chain that never contains the anchor's head.
  const forged = [entry(did, "bafyreiequivocationforgedheadneverhashedfromarealopxxxxxx", "2020-01-01T00:00:00Z")];
  const r = await checkAgainstMirror(did, new Map([[did, forged]]));
  t.diagnostic(`confirmedHead=${confirmedHead || "(none)"} → verdict ${r.status} (${r.reason})`);

  if (confirmedHead) {
    // The headline: a confirmed head, absent from an old directory chain → the sole alarm.
    assert.equal(r.status, "diverged", "equivocation against a confirmed head must alarm");
  } else {
    // No confirmed history yet: the anchor has nothing immutable to contradict, so the same
    // attack is (correctly) not an alarm. The confirmed-diverged headline needs a DID anchored
    // ≥72h ago — re-run then.
    t.diagnostic("DID has no confirmed head yet; the confirmed-`diverged` headline needs a DID anchored ≥72h ago.");
    assert.notEqual(r.status, "diverged");
  }
});

test("live: a vanishing DID (mirror 404) — diverged iff confirmed", { skip: skipDid }, async (t) => {
  const did = LIVE_DID as string;
  const { confirmedHead } = await anchorHeads(did);

  // The mirror lists nothing for the DID → DirectoryClient sees a 404 → empty log.
  const r = await checkAgainstMirror(did, new Map());
  t.diagnostic(`confirmedHead=${confirmedHead || "(none)"} → verdict ${r.status} (${r.reason})`);
  if (confirmedHead) assert.equal(r.status, "diverged", "erasing a confirmed DID must alarm");
  else assert.notEqual(r.status, "diverged");
});
