//! CLI plumbing gate (offline): argument parsing, exit-code mapping, and the report formatter.
//! The network path (`main`) is exercised by the live read, not here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCodeFor, formatResult, parseArgs } from "../src/cli.ts";
import type { CheckResult } from "../src/status.ts";

test("parseArgs: did + explicit flags", () => {
  const a = parseArgs(["did:plc:abc", "--rpc", "https://rpc", "--contract", "0x1", "--directory", "https://d"]);
  assert.deepEqual(a, { did: "did:plc:abc", rpc: "https://rpc", contract: "0x1", directory: "https://d" });
});

test("parseArgs: contract + directory default when omitted", () => {
  const a = parseArgs(["did:plc:abc", "--rpc", "https://rpc"]);
  assert.equal(a.directory, "https://plc.directory");
  assert.match(a.contract, /^0x[0-9a-f]+$/i);
});

test("parseArgs: errors without a DID, or without an RPC", () => {
  assert.throws(() => parseArgs(["--rpc", "https://rpc"]), /usage:/);
  const saved = process.env.STARKNET_RPC;
  delete process.env.STARKNET_RPC;
  try {
    assert.throws(() => parseArgs(["did:plc:abc"]), /no RPC endpoint/);
  } finally {
    if (saved !== undefined) process.env.STARKNET_RPC = saved;
  }
});

test("exitCodeFor: diverged → 2, error → 1, rest → 0", () => {
  assert.equal(exitCodeFor("diverged"), 2);
  assert.equal(exitCodeFor("error"), 1);
  for (const s of ["confirmed", "tentative-consistent", "absent"] as const) {
    assert.equal(exitCodeFor(s), 0);
  }
});

test("formatResult: renders status, reason, and evidence", () => {
  const r: CheckResult = {
    status: "confirmed",
    reason: "confirmed-head-match",
    evidence: {
      directoryHead: "bafyHEAD",
      anchorConfirmedHead: "bafyHEAD",
      anchorTentativeHead: "bafyHEAD",
    },
  };
  const out = formatResult("did:plc:abc", r);
  assert.match(out, /Status: CONFIRMED {2}\(confirmed-head-match\)/);
  assert.match(out, /directory head: {9}bafyHEAD/);
});
