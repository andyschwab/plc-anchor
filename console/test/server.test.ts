//! HTTP API — exercises the real routes over an ephemeral loopback port (the approve gate, the
//! diverged alarm, filters, and error mapping).

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createConsoleServer } from "../src/server.ts";
import { RosterStore } from "../src/roster.ts";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
let base = "";
let store: RosterStore;
const server = (() => {
  store = RosterStore.open();
  return createConsoleServer(store, { contractAddress: "0xanchor" });
})();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test("healthz reports contract address and counts", async () => {
  const { status, json } = await req("GET", "/healthz");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.contractAddress, "0xanchor");
  assert.equal(json.counts.total, 0);
});

test("add → list → approve → detail", async () => {
  const add = await req("POST", "/roster/dids", { did: DID });
  assert.equal(add.status, 200);
  assert.equal(add.json.state, "candidate");

  const list = await req("GET", "/roster");
  assert.equal(list.json.length, 1);

  const approve = await req("POST", `/roster/dids/${DID}/approve`);
  assert.equal(approve.json.state, "approved");

  const detail = await req("GET", `/roster/dids/${DID}`);
  assert.equal(detail.json.did, DID);
});

test("approving a non-candidate is a 400 (illegal transition surfaced)", async () => {
  // DID is already approved from the previous test; approved → approved is illegal.
  const { status, json } = await req("POST", `/roster/dids/${DID}/approve`);
  assert.equal(status, 400);
  assert.match(json.error, /illegal transition/);
});

test("diverged alarm endpoint", async () => {
  // Drive the DID to anchored+diverged directly via the store, then read the alarm route.
  store.transition(DID, "onboarding");
  store.transition(DID, "anchored");
  store.setStatus(DID, { status: "diverged", reason: "confirmed-head-absent", headCid: null });
  const { json } = await req("GET", "/roster/diverged");
  assert.equal(json.length, 1);
  assert.equal(json[0].did, DID);
});

test("filters create/list/delete", async () => {
  const add = await req("POST", "/roster/filters", { value: "pds.example.eu" });
  assert.equal(add.json.value, "pds.example.eu");
  const list = await req("GET", "/roster/filters");
  assert.equal(list.json.length, 1);
  const del = await req("DELETE", `/roster/filters/${add.json.id}`);
  assert.equal(del.json.ok, true);
  assert.equal((await req("GET", "/roster/filters")).json.length, 0);
});

test("unknown route → 404, bad body → 400", async () => {
  assert.equal((await req("GET", "/nope")).status, 404);
  assert.equal((await req("POST", "/roster/dids", { nope: 1 })).status, 400);
});
