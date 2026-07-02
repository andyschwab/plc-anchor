//! Live read against the deployed Sepolia anchor — gated, manual (parallel to the Rust
//! `live_e2e` `--ignored`). Runs only when `WITNESS_LIVE_RPC` is set, so the default suite
//! stays offline + deterministic and spends no network.
//!
//!   WITNESS_LIVE_RPC=https://<keyed-sepolia> node --test test/live.test.ts
//!   # optional: WITNESS_LIVE_CONTRACT=0x… (defaults to the recorded deployment)
//!   #           WITNESS_LIVE_DID=did:plc:…  (assert a known-anchored DID resolves)

import assert from "node:assert/strict";
import { test } from "node:test";
import { AnchorReader } from "../src/starknet.ts";
import { DirectoryClient } from "../src/directory.ts";
import { check } from "../src/status.ts";

const RPC = process.env.WITNESS_LIVE_RPC;
const CONTRACT =
  process.env.WITNESS_LIVE_CONTRACT ?? "0x01e3cd42e8481a40b366ef32940e8bc050fd79c924c9b838a6dc0338a08fc5c3";
const skip = RPC ? false : "set WITNESS_LIVE_RPC to run the live read";

test("live: the tentative root reads back as a 32-byte digest", { skip }, async () => {
  const anchor = AnchorReader.http(RPC as string, CONTRACT);
  const root = await anchor.tentativeRoot();
  assert.equal(root.length, 32, "commitment root must be a 32-byte sha256 digest");
});

test("live: an obviously-unanchored DID reads as absent", { skip }, async () => {
  const anchor = AnchorReader.http(RPC as string, CONTRACT);
  const directory = new DirectoryClient();
  const r = await check("did:plc:zzzzzzzzzzzzzzzzzzzzzzzz", anchor, directory);
  assert.equal(r.status, "absent");
});

test("live: a known-anchored DID resolves to a non-alarming status", { skip: skip || !process.env.WITNESS_LIVE_DID }, async () => {
  const anchor = AnchorReader.http(RPC as string, CONTRACT);
  const directory = new DirectoryClient();
  const r = await check(process.env.WITNESS_LIVE_DID as string, anchor, directory);
  assert.notEqual(r.status, "absent");
  assert.notEqual(r.status, "diverged");
});
