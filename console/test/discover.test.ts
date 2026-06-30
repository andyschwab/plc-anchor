//! Discover-scan — matches /export ops against pds_host filters, upserts candidates, advances
//! the cursor. Injected fetcher returns fixture JSON-Lines pages; no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscoverService, ExportClient } from "../src/discover.ts";
import { RosterStore } from "../src/roster.ts";

function op(host: string): unknown {
  return { type: "plc_operation", services: { atproto_pds: { endpoint: `https://${host}` } } };
}

function entry(did: string, host: string, createdAt: string): string {
  return JSON.stringify({ did, operation: op(host), cid: "bafy" + did.slice(-4), createdAt });
}

/** A fetcher that serves one fixed JSON-Lines page regardless of query. */
function pageFetcher(lines: string[]): (url: string) => Promise<Response> {
  return () => Promise.resolve(new Response(lines.join("\n") + "\n", { status: 200 }));
}

const AAAA = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const BBBB = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const CCCC = "did:plc:cccccccccccccccccccccccc";

test("no enabled filters → no scan, no candidates", async () => {
  const s = RosterStore.open();
  const client = new ExportClient("https://m", pageFetcher([entry(AAAA, "pds.eu", "2020-01-01T00:00:00Z")]));
  const r = await new DiscoverService(s, client).scanOnce();
  assert.equal(r.matched, 0);
  assert.equal(s.list().length, 0);
});

test("matching ops become candidates; non-matching are ignored", async () => {
  const s = RosterStore.open();
  s.addFilter("pds_host", "pds.eu");
  const lines = [
    entry(AAAA, "pds.eu", "2020-01-01T00:00:00Z"),
    entry(BBBB, "other.host", "2020-01-02T00:00:00Z"),
    entry(CCCC, "pds.eu", "2020-01-03T00:00:00Z"),
  ];
  const client = new ExportClient("https://m", pageFetcher(lines));
  const r = await new DiscoverService(s, client).scanOnce();
  assert.equal(r.scanned, 3);
  assert.equal(r.matched, 2);
  assert.equal(s.get(AAAA)!.state, "candidate");
  assert.equal(s.get(AAAA)!.pdsHost, "pds.eu");
  assert.equal(s.get(AAAA)!.source, `filter:${s.listFilters()[0].id}`);
  assert.equal(s.get(BBBB), null, "non-matching DID is not proposed");
});

test("discovered candidates still require approval (no auto-onboard)", async () => {
  const s = RosterStore.open();
  s.addFilter("pds_host", "pds.eu");
  const client = new ExportClient("https://m", pageFetcher([entry(AAAA, "pds.eu", "2020-01-01T00:00:00Z")]));
  await new DiscoverService(s, client).scanOnce();
  assert.equal(s.get(AAAA)!.state, "candidate", "the approve gate holds — nothing is anchored");
  assert.equal(s.list("approved").length, 0);
});

test("cursor advances to the last entry's createdAt and persists", async () => {
  const s = RosterStore.open();
  s.addFilter("pds_host", "pds.eu");
  const client = new ExportClient("https://m", pageFetcher([
    entry(AAAA, "pds.eu", "2020-01-01T00:00:00Z"),
    entry(CCCC, "pds.eu", "2020-01-03T00:00:00Z"),
  ]));
  const r = await new DiscoverService(s, client).scanOnce();
  assert.equal(r.cursor, "2020-01-03T00:00:00Z");
  assert.equal(s.getMeta("discover_cursor"), "2020-01-03T00:00:00Z");
});

test("ExportClient parses JSON-Lines and passes the after cursor", async () => {
  let seen = "";
  const client = new ExportClient("https://m", (url) => {
    seen = url;
    return Promise.resolve(new Response(entry(AAAA, "pds.eu", "2020-01-01T00:00:00Z") + "\n", { status: 200 }));
  });
  const page = await client.page("2019-12-31T00:00:00Z", 50);
  assert.equal(page.length, 1);
  assert.equal(page[0].did, AAAA);
  assert.match(seen, /after=2019-12-31/);
  assert.match(seen, /count=50/);
});
