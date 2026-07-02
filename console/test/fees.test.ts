//! Fee resolution — parsing `actual_fee` shapes and the JSON-RPC receipt call over an injected
//! fetcher. No network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { feeToDecimal, starknetFeeResolver } from "../src/fees.ts";

test("feeToDecimal handles the {amount,unit} shape, bare hex, and junk", () => {
  assert.equal(feeToDecimal({ amount: "0x3e8", unit: "WEI" }), "1000");
  assert.equal(feeToDecimal("0xff"), "255");
  assert.equal(feeToDecimal({ amount: "42" }), "42");
  assert.equal(feeToDecimal(null), null);
  assert.equal(feeToDecimal({ amount: "not-a-number" }), null);
  assert.equal(feeToDecimal({}), null);
});

test("starknetFeeResolver posts getTransactionReceipt and extracts the fee", async () => {
  let seenBody = "";
  const resolver = starknetFeeResolver("https://rpc", async (_url, init) => {
    seenBody = String(init.body);
    return new Response(JSON.stringify({ result: { actual_fee: { amount: "0x64", unit: "FRI" } } }), { status: 200 });
  });
  const fee = await resolver("0xdeadbeef");
  assert.equal(fee, "100");
  assert.match(seenBody, /starknet_getTransactionReceipt/);
  assert.match(seenBody, /0xdeadbeef/);
});

test("starknetFeeResolver returns null on an HTTP error (degrades to count-only)", async () => {
  const resolver = starknetFeeResolver("https://rpc", async () => new Response("", { status: 500 }));
  assert.equal(await resolver("0x1"), null);
});
