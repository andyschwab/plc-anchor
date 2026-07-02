//! HTTP API — exercises the real routes over an ephemeral loopback port (the approve gate, the
//! diverged alarm, filters, and error mapping).

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { SharedSecretAuth } from "../src/auth.ts";
import { createConsoleServer } from "../src/server.ts";
import { RosterStore } from "../src/roster.ts";
import { SettingsStore } from "../src/settings.ts";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
let base = "";
let store: RosterStore;
const server = (() => {
  store = RosterStore.open();
  // These CRUD tests exercise routes without auth, so opt into open-writes explicitly.
  return createConsoleServer(store, {
    contractAddress: "0xanchor",
    allowOpenWrites: true,
    settings: new SettingsStore(store),
    locked: () => ({ port: 8787, contractAddress: "0xanchor", rpcConfigured: false }),
  });
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

test("GET / serves the bundled UI", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /PLC anchor console/);
});

test("healthz reports contract address and counts", async () => {
  const { status, json } = await req("GET", "/healthz");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.contractAddress, "0xanchor");
  assert.equal(json.counts.total, 0);
});

test("add → list (paged) → approve → detail", async () => {
  const add = await req("POST", "/roster/dids", { did: DID });
  assert.equal(add.status, 200);
  assert.equal(add.json.state, "candidate");

  const list = await req("GET", "/roster");
  assert.equal(list.json.total, 1);
  assert.equal(list.json.rows.length, 1);
  assert.equal(list.json.rows[0].did, DID);

  const approve = await req("POST", `/roster/dids/${DID}/approve`);
  assert.equal(approve.json.state, "approved");

  const detail = await req("GET", `/roster/dids/${DID}`);
  assert.equal(detail.json.did, DID);
});

test("roster query filters by state and searches DID + handle", async () => {
  // DID is 'approved' from the prior test. Filter to approved returns it; candidate returns none.
  const byApproved = await req("GET", "/roster?state=approved");
  assert.equal(byApproved.json.total, 1);
  const byCandidate = await req("GET", "/roster?state=candidate");
  assert.equal(byCandidate.json.total, 0);
  const bySearch = await req("GET", `/roster?q=${DID.slice(-6)}`);
  assert.equal(bySearch.json.total, 1);
  const noMatch = await req("GET", "/roster?q=zzzzzznope");
  assert.equal(noMatch.json.total, 0);
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

test("settings/active reads and sets the toggle + budget", async () => {
  const initial = await req("GET", "/settings/active");
  assert.equal(initial.json.active, false, "defaults off");

  const on = await req("POST", "/settings/active", { active: true, budget: 5 });
  assert.equal(on.json.active, true);
  assert.equal(on.json.budget, 5);
  assert.equal((await req("GET", "/settings/active")).json.active, true);

  // Bad body is a 400.
  assert.equal((await req("POST", "/settings/active", { budget: 1 })).status, 400);

  // Reset for later tests.
  await req("POST", "/settings/active", { active: false, budget: null });
});

test("GET /settings returns live settings + a read-only locked snapshot", async () => {
  const { status, json } = await req("GET", "/settings");
  assert.equal(status, 200);
  assert.equal(json.settings.tailIntervalMs, 60000);
  assert.deepEqual(json.settings.pdsEndpoints, ["https://eurosky.social"]);
  assert.equal(json.locked.contractAddress, "0xanchor");
  assert.equal(json.locked.rpcConfigured, false);
});

test("PUT /settings patches live fields and rejects bad input", async () => {
  const ok = await req("PUT", "/settings", { tailIntervalMs: 12345, criterion: "pds_domain:eurosky.social" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.tailIntervalMs, 12345);
  assert.equal(ok.json.settings.criterion, "pds_domain:eurosky.social");
  // Persisted: a fresh GET sees it.
  assert.equal((await req("GET", "/settings")).json.settings.tailIntervalMs, 12345);
  // Bad input → 400.
  const bad = await req("PUT", "/settings", { importBudget: -5 });
  assert.equal(bad.status, 400);
  const badCrit = await req("PUT", "/settings", { criterion: "bogus:x" });
  assert.equal(badCrit.status, 400);
});

test("aggregates rollup exposes counts, fees, active, cursors, workers, and enrichment", async () => {
  const { status, json } = await req("GET", "/roster/aggregates");
  assert.equal(status, 200);
  assert.equal(typeof json.total, "number");
  assert.equal(typeof json.byState, "object");
  assert.equal(typeof json.feeTotal, "string");
  assert.equal(json.active, false);
  assert.ok(json.cursors);
  assert.ok(json.workers, "worker statuses present");
  assert.equal(typeof json.enrichment.enriched, "number");
  assert.equal(typeof json.offCriterion, "number");
});

test("healthz advertises the criterion and active flag", async () => {
  const { json } = await req("GET", "/healthz");
  assert.equal(json.active, false);
  assert.ok("criterion" in json);
});

test("unknown route → 404, bad body → 400", async () => {
  assert.equal((await req("GET", "/nope")).status, 404);
  assert.equal((await req("POST", "/roster/dids", { nope: 1 })).status, 400);
});

test("worker trigger → 503 when the action is not configured", async () => {
  // This server was built without `actions`, so all worker triggers are unconfigured.
  const { status, json } = await req("POST", "/worker/onboard");
  assert.equal(status, 503);
  assert.match(json.error, /not configured/);
});

test("worker trigger runs a configured action", async () => {
  const wired = createConsoleServer(RosterStore.open(), {
    contractAddress: "0x0",
    allowOpenWrites: true,
    actions: { refresh: async () => ({ diverged: 3 }) },
  });
  await new Promise<void>((r) => wired.listen(0, "127.0.0.1", r));
  const { port } = wired.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/worker/refresh`, { method: "POST" });
  assert.equal((await res.json()).diverged, 3);
  wired.close();
});

// --- Auth gate: with an Authenticator wired, writes require a session; reads stay open. ---
test("auth gate: reads open, writes 401 without a session, 200 with one", async () => {
  const gated = createConsoleServer(RosterStore.open(), {
    contractAddress: "0xg",
    auth: new SharedSecretAuth("s3cret"),
    actions: { refresh: async () => ({ diverged: 0 }) },
  });
  await new Promise<void>((r) => gated.listen(0, "127.0.0.1", r));
  const gbase = `http://127.0.0.1:${(gated.address() as AddressInfo).port}`;
  const call = (method: string, path: string, opts: { body?: unknown; token?: string } = {}) =>
    fetch(`${gbase}${path}`, {
      method,
      headers: {
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

  // healthz advertises the gated write mode, and reads work unauthenticated.
  assert.equal((await (await call("GET", "/healthz")).json()).writeMode, "gated");
  assert.equal((await call("GET", "/roster")).status, 200);

  // A write with no session is rejected.
  const denied = await call("POST", "/roster/dids", { body: { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" } });
  assert.equal(denied.status, 401);
  assert.match((await denied.json()).error, /unauthorized/);

  // Worker triggers are gated too.
  assert.equal((await call("POST", "/worker/refresh")).status, 401);

  // Bad login is 401; good login mints a token.
  assert.equal((await call("POST", "/auth/login", { body: { secret: "wrong" } })).status, 401);
  const login = await call("POST", "/auth/login", { body: { secret: "s3cret" } });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);

  // The same writes now succeed with the bearer token.
  const ok = await call("POST", "/roster/dids", { body: { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }, token });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).state, "candidate");
  assert.equal((await call("POST", "/worker/refresh", { token })).status, 200);

  gated.close();
});

test("fail-closed default: no auth + no open flag → writes refused, reads open", async () => {
  const shut = createConsoleServer(RosterStore.open(), { contractAddress: "0xc" });
  await new Promise<void>((r) => shut.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${(shut.address() as AddressInfo).port}`;

  assert.equal((await (await fetch(`${b}/healthz`)).json()).writeMode, "closed");
  assert.equal((await fetch(`${b}/roster`)).status, 200); // reads open

  const write = await fetch(`${b}/roster/dids`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: "did:plc:x" }),
  });
  assert.equal(write.status, 503);
  assert.match((await write.json()).error, /CONSOLE_ADMIN_TOKEN/);

  // Login is unavailable when no auth is configured.
  const login = await fetch(`${b}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "x" }),
  });
  assert.equal(login.status, 503);
  assert.match((await login.json()).error, /not configured/);
  shut.close();
});

test("open-writes escape hatch: writes allowed without a session", async () => {
  // The main test server runs with allowOpenWrites; confirm healthz reports it and writes pass.
  assert.equal((await req("GET", "/healthz")).json.writeMode, "open");
  assert.equal((await req("POST", "/settings/active", { active: false })).status, 200);
});
