//! CachingAnchorView — confirms the RPC cost fix: shared roots are fetched once per cycle, not
//! once per DID, while per-DID reads always pass through untouched.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CachingAnchorView } from "../src/caching-anchor.ts";
import type { AnchorView } from "../src/status.ts";

const ZERO = new Uint8Array(32);

function countingAnchor(): AnchorView & { calls: Record<string, number> } {
  const calls: Record<string, number> = {
    isAnchored: 0,
    confirmedProof: 0,
    tentativeProof: 0,
    confirmedRoot: 0,
    tentativeRoot: 0,
  };
  return {
    calls,
    isAnchored: async () => {
      calls.isAnchored += 1;
      return true;
    },
    confirmedProof: async () => {
      calls.confirmedProof += 1;
      return { head: "h", proof: [] };
    },
    tentativeProof: async () => {
      calls.tentativeProof += 1;
      return { head: "h", proof: [] };
    },
    confirmedRoot: async () => {
      calls.confirmedRoot += 1;
      return ZERO;
    },
    tentativeRoot: async () => {
      calls.tentativeRoot += 1;
      return ZERO;
    },
  };
}

test("confirmedRoot/tentativeRoot are memoized across many DIDs until reset", async () => {
  const inner = countingAnchor();
  const cached = new CachingAnchorView(inner);

  for (const did of ["did:plc:aaa", "did:plc:bbb", "did:plc:ccc"]) {
    await cached.isAnchored(did);
    await cached.confirmedProof(did);
    await cached.tentativeProof(did);
    await cached.confirmedRoot();
    await cached.tentativeRoot();
  }

  assert.equal(inner.calls.confirmedRoot, 1, "confirmedRoot fetched once for the whole cycle");
  assert.equal(inner.calls.tentativeRoot, 1, "tentativeRoot fetched once for the whole cycle");
  assert.equal(inner.calls.isAnchored, 3, "per-DID reads still happen once per DID");
  assert.equal(inner.calls.confirmedProof, 3);
  assert.equal(inner.calls.tentativeProof, 3);
});

test("reset() re-fetches the roots on the next cycle", async () => {
  const inner = countingAnchor();
  const cached = new CachingAnchorView(inner);

  await cached.confirmedRoot();
  await cached.confirmedRoot();
  assert.equal(inner.calls.confirmedRoot, 1);

  cached.reset();
  await cached.confirmedRoot();
  assert.equal(inner.calls.confirmedRoot, 2, "reset drops the cached value");
});

test("concurrent callers within a cycle share one in-flight request", async () => {
  const inner = countingAnchor();
  const cached = new CachingAnchorView(inner);

  await Promise.all([cached.confirmedRoot(), cached.confirmedRoot(), cached.confirmedRoot()]);
  assert.equal(inner.calls.confirmedRoot, 1, "concurrent calls dedupe onto one in-flight promise");
});
