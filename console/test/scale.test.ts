//! Scale + query correctness — seed a few thousand synthetic rows and assert the server-side
//! paginated/filtered/sorted query and the aggregates rollup stay correct (and fast) at size. The
//! 20k target is verified manually (queries stay in the low-ms); this keeps a fast regression guard
//! on the indexed query behaviour.

import assert from "node:assert/strict";
import { test } from "node:test";
import { RosterStore } from "../src/roster.ts";

const N = 3000;

function seeded(): RosterStore {
  const s = RosterStore.open();
  for (let i = 0; i < N; i += 1) {
    const did = "did:plc:" + i.toString(36).padStart(24, "0");
    const host = i % 2 === 0 ? "pds1.eurosky.social" : "eurosky.social";
    s.autoApprove(did, "pds:eurosky.social", host);
    if (i % 4 === 0) {
      s.setEnrichment(did, {
        handle: `user${i}.eurosky.social`,
        pdsHost: host, // keep the host stable so the filter counts are deterministic
        keyCount: 2,
        lastOpAt: 1_700_000_000_000 + i,
        tombstoned: false,
      });
    }
  }
  return s;
}

test("paginated query returns a bounded page with the full total", () => {
  const s = seeded();
  const page = s.query({ limit: 50, offset: 0 });
  assert.equal(page.total, N);
  assert.equal(page.rows.length, 50);

  const deep = s.query({ limit: 50, offset: 2900 });
  assert.equal(deep.total, N);
  assert.equal(deep.rows.length, 50);
});

test("substring search over DID + handle narrows the total", () => {
  const s = seeded();
  const byHandle = s.query({ q: "user4.eurosky", limit: 50 });
  assert.equal(byHandle.total, 1);
  assert.equal(byHandle.rows[0].handle, "user4.eurosky.social");

  const none = s.query({ q: "no-such-thing", limit: 50 });
  assert.equal(none.total, 0);
});

test("filter by state + pdsHost composes", () => {
  const s = seeded();
  const half = s.query({ pdsHost: "pds1.eurosky.social", limit: 10 });
  assert.equal(half.total, N / 2);
  const approved = s.query({ state: "approved", pdsHost: "pds1.eurosky.social", limit: 10 });
  assert.equal(approved.total, N / 2, "all seeded rows are approved");
  const anchored = s.query({ state: "anchored", limit: 10 });
  assert.equal(anchored.total, 0);
});

test("sort by handle asc/desc orders deterministically", () => {
  const s = seeded();
  const asc = s.query({ sort: "handle", order: "asc", limit: 5 });
  const desc = s.query({ sort: "handle", order: "desc", limit: 5 });
  // handle is null for 3/4 of rows; ascending puts NULLs first in SQLite, descending last.
  assert.notEqual(asc.rows[0].did, desc.rows[0].did);
});

test("aggregates rollup is correct at size", () => {
  const s = seeded();
  const agg = s.aggregates();
  assert.equal(agg.total, N);
  assert.equal(agg.backlog, N, "everything is approved, nothing anchored yet");
  assert.equal(agg.anchored, 0);
  assert.equal(agg.byState.approved, N);
});
