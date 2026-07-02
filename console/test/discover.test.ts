//! Discovery — enumeration (PDS listRepos → auto-approve) and the criterion tail (/export from
//! ~now → auto-approve). Injected fetchers serve fixtures; no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCriterion } from "../src/criterion.ts";
import { EnumerationService, ExportClient, TailService } from "../src/discover.ts";
import { PdsClient } from "../src/pds.ts";
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
const CRITERION = parseCriterion("pds_domain:eurosky.social");

// --- Enumeration (listRepos backlog) ----------------------------------------

/** A listRepos fetcher that serves cursor-keyed pages from a map (cursor "" = the first page). */
function listReposFetcher(pages: Record<string, { repos: unknown[]; cursor: string | null }>) {
  return (url: string) => {
    const cursor = new URL(url).searchParams.get("cursor") ?? "";
    const page = pages[cursor] ?? { repos: [], cursor: null };
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }));
  };
}

test("enumeration auto-approves every did:plc, paging by cursor, then idles when drained", async () => {
  const s = RosterStore.open();
  const client = new PdsClient(
    "https://eurosky.social",
    listReposFetcher({
      "": { repos: [{ did: AAAA }, { did: "did:web:example.com" }], cursor: "c1" },
      c1: { repos: [{ did: BBBB }], cursor: null },
    }),
  );
  const svc = new EnumerationService(s, client);

  const p1 = await svc.enumerateOnce();
  assert.equal(p1.scanned, 1, "did:web is filtered out");
  assert.equal(p1.queued, 1);
  assert.equal(p1.done, false);
  assert.equal(s.get(AAAA)!.state, "approved", "matches auto-approve (no manual gate)");
  assert.equal(s.get(AAAA)!.source, "pds:eurosky.social");
  assert.equal(s.get(AAAA)!.pdsHost, "eurosky.social");

  const p2 = await svc.enumerateOnce();
  assert.equal(p2.done, true);
  assert.equal(s.get(BBBB)!.state, "approved");

  // Drained: a further tick is a no-op.
  const p3 = await svc.enumerateOnce();
  assert.equal(p3.scanned, 0);
  assert.equal(p3.done, true);
});

test("enumerateBacklog drains all pages in one call", async () => {
  const s = RosterStore.open();
  const client = new PdsClient(
    "https://eurosky.social",
    listReposFetcher({
      "": { repos: [{ did: AAAA }], cursor: "c1" },
      c1: { repos: [{ did: BBBB }], cursor: "c2" },
      c2: { repos: [{ did: CCCC }], cursor: null },
    }),
  );
  const r = await new EnumerationService(s, client).enumerateBacklog();
  assert.equal(r.done, true);
  assert.equal(r.queued, 3);
  assert.equal(s.list("approved").length, 3);
});

// --- Tail (/export against the criterion) -----------------------------------

test("tail seeds the cursor to ~now on first run without replaying history", async () => {
  const s = RosterStore.open();
  let served = false;
  const client = new ExportClient("https://m", () => {
    served = true;
    return Promise.resolve(new Response("", { status: 200 }));
  });
  const svc = new TailService(s, client, CRITERION, () => Date.parse("2026-01-01T00:00:00Z"));
  const r = await svc.scanOnce();
  assert.equal(served, false, "first run does not hit the network");
  assert.equal(r.scanned, 0);
  assert.equal(s.getMeta("tail_cursor"), "2026-01-01T00:00:00.000Z");
});

test("tail auto-approves matching ops and ignores others; cursor advances", async () => {
  const s = RosterStore.open();
  s.setMeta("tail_cursor", "2020-01-01T00:00:00Z"); // pretend already seeded
  const client = new ExportClient(
    "https://m",
    pageFetcher([
      entry(AAAA, "pds1.eurosky.social", "2020-01-02T00:00:00Z"),
      entry(BBBB, "bsky.social", "2020-01-03T00:00:00Z"),
      entry(CCCC, "eurosky.social", "2020-01-04T00:00:00Z"),
    ]),
  );
  const r = await new TailService(s, client, CRITERION).scanOnce();
  assert.equal(r.scanned, 3);
  assert.equal(r.matched, 2);
  assert.equal(s.get(AAAA)!.state, "approved");
  assert.equal(s.get(CCCC)!.state, "approved");
  assert.equal(s.get(BBBB), null, "non-matching DID is not proposed");
  assert.equal(r.cursor, "2020-01-04T00:00:00Z");
  assert.equal(s.getMeta("tail_cursor"), "2020-01-04T00:00:00Z");
});

test("ExportClient parses JSON-Lines and passes the after cursor", async () => {
  let seen = "";
  const client = new ExportClient("https://m", (url) => {
    seen = url;
    return Promise.resolve(new Response(entry(AAAA, "eurosky.social", "2020-01-01T00:00:00Z") + "\n", { status: 200 }));
  });
  const page = await client.page("2019-12-31T00:00:00Z", 50);
  assert.equal(page.length, 1);
  assert.equal(page[0].did, AAAA);
  assert.match(seen, /after=2019-12-31/);
  assert.match(seen, /count=50/);
});
