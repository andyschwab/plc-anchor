//! Enrichment — derive identity (handle, PDS host, key count, last-op, tombstoned) from a fixture
//! audit log; the throttled/cached worker over an injected resolver. No network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCriterion } from "../src/criterion.ts";
import { EnrichmentService, identityFromLog, type AuditEntry } from "../src/enrich.ts";
import { RosterStore } from "../src/roster.ts";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

function modernOp(handle: string, host: string, keys: number, type = "plc_operation"): unknown {
  return {
    type,
    alsoKnownAs: [`at://${handle}`],
    rotationKeys: Array.from({ length: keys }, (_, i) => `did:key:k${i}`),
    services: { atproto_pds: { endpoint: `https://${host}` } },
  };
}

function entry(op: unknown, createdAt: string, nullified = false): AuditEntry {
  return { cid: "bafy", createdAt, nullified, operation: op };
}

test("identityFromLog uses the latest non-nullified op", () => {
  const log: AuditEntry[] = [
    entry(modernOp("old.eurosky.social", "old.host", 1), "2020-01-01T00:00:00Z"),
    entry(modernOp("forged", "evil", 1), "2020-06-01T00:00:00Z", true), // nullified — ignored
    entry(modernOp("alice.eurosky.social", "eurosky.social", 2), "2021-01-01T00:00:00Z"),
  ];
  const id = identityFromLog(log)!;
  assert.equal(id.handle, "alice.eurosky.social");
  assert.equal(id.pdsHost, "eurosky.social");
  assert.equal(id.keyCount, 2);
  assert.equal(id.lastOpAt, Date.parse("2021-01-01T00:00:00Z"));
  assert.equal(id.tombstoned, false);
});

test("identityFromLog flags a tombstone and handles legacy create shape", () => {
  const tomb = identityFromLog([entry({ type: "plc_tombstone" }, "2022-01-01T00:00:00Z")])!;
  assert.equal(tomb.tombstoned, true);

  const legacy = identityFromLog([
    entry({ handle: "at://bob.example", service: "https://eurosky.social", signingKey: "s", recoveryKey: "r" }, "2019-01-01T00:00:00Z"),
  ])!;
  assert.equal(legacy.handle, "bob.example");
  assert.equal(legacy.pdsHost, "eurosky.social");
  assert.equal(legacy.keyCount, 2);
});

test("identityFromLog returns null for an empty / all-nullified log", () => {
  assert.equal(identityFromLog([]), null);
  assert.equal(identityFromLog([entry(modernOp("x", "y", 1), "2020-01-01T00:00:00Z", true)]), null);
});

test("enrichOne records identity and stamps enrichedAt", async () => {
  const s = RosterStore.open();
  s.upsertCandidate(DID, "pds:eurosky.social");
  const resolver = { auditLog: async () => [entry(modernOp("alice.eurosky.social", "eurosky.social", 2), "2021-01-01T00:00:00Z")] };
  const svc = new EnrichmentService(s, resolver);
  assert.equal(await svc.enrichOne(DID), true);
  const e = s.get(DID)!;
  assert.equal(e.handle, "alice.eurosky.social");
  assert.equal(e.keyCount, 2);
  assert.ok(e.enrichedAt !== null);
});

test("enrichOne flags off-criterion when the authoritative host no longer matches", async () => {
  const s = RosterStore.open();
  const criterion = parseCriterion("pds_domain:eurosky.social");
  // Two DIDs enumerated as eurosky members, but PLC says one migrated to bsky.
  s.upsertCandidate("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "pds:eurosky.social");
  s.upsertCandidate("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", "pds:eurosky.social");
  const svc = new EnrichmentService(
    s,
    {
      auditLog: async (did) =>
        did.endsWith("bbbb")
          ? [entry(modernOp("moved.bsky.social", "x.host.bsky.network", 1), "2022-01-01T00:00:00Z")]
          : [entry(modernOp("stay.eurosky.social", "eurosky.social", 1), "2022-01-01T00:00:00Z")],
    },
    { criterion },
  );
  await svc.enrichOne("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  await svc.enrichOne("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(s.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")!.offCriterion, false, "still on eurosky");
  assert.equal(s.get("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb")!.offCriterion, true, "migrated → flagged");
  // Nothing is removed — flag-only.
  assert.equal(s.get("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb")!.state, "candidate");
});

test("enrichOne leaves off-criterion null when no criterion is configured", async () => {
  const s = RosterStore.open();
  s.upsertCandidate("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "pds:eurosky.social");
  const svc = new EnrichmentService(s, { auditLog: async () => [entry(modernOp("h", "x.host.bsky.network", 1), "2022-01-01T00:00:00Z")] });
  await svc.enrichOne("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(s.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")!.offCriterion, null);
});

test("enrichOne records the error without stamping enrichedAt on failure (retries later)", async () => {
  const s = RosterStore.open();
  s.upsertCandidate(DID, "pds:eurosky.social");
  const resolver = { auditLog: async () => { throw new Error("HTTP 503"); } };
  assert.equal(await new EnrichmentService(s, resolver).enrichOne(DID), false);
  const e = s.get(DID)!;
  assert.equal(e.enrichedAt, null, "a failed enrich stays stale so it retries");
  assert.match(e.error!, /enrich: HTTP 503/);
});

test("enrichStale enriches only stale entries and respects re-enrich TTL", async () => {
  let t = 1_000_000;
  const s = RosterStore.open(":memory:", () => t);
  for (const d of ["did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"]) {
    s.upsertCandidate(d, "pds:eurosky.social");
  }
  let calls = 0;
  const resolver = {
    auditLog: async () => {
      calls += 1;
      return [entry(modernOp("h.eurosky.social", "eurosky.social", 1), "2021-01-01T00:00:00Z")];
    },
  };
  const svc = new EnrichmentService(s, resolver, { now: () => t, reEnrichMs: 1000, sleep: async () => {} });

  const r1 = await svc.enrichStale(10, 0);
  assert.equal(r1.enriched, 2, "both are never-enriched → stale");
  assert.equal(calls, 2);

  // Immediately re-running finds nothing stale (within the TTL).
  const r2 = await svc.enrichStale(10, 0);
  assert.equal(r2.enriched, 0);

  // Advance past the TTL → both are stale again.
  t += 2000;
  const r3 = await svc.enrichStale(10, 0);
  assert.equal(r3.enriched, 2);
});
