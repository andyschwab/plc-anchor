//! EventCachingAnchorView — the refresh RPC-cost gate. Verifies chains serve from cache when no
//! Stored events fired, refetch when they did (or on a cold cache), and fail SAFE (full refetch)
//! when the event probe throws — never serving possibly-stale logs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { EventCachingAnchorView, type ChainCache } from "../src/event-cache.ts";
import type { AnchorEventView } from "../src/event-cache.ts";
import type { AnchorOp } from "../src/starknet.ts";

const op = (n: number): AnchorOp => ({ signed: new Uint8Array([n]), createdAt: n, imported: false });

/** An in-memory ChainCache. */
function memCache(): ChainCache {
  const chains = new Map<string, AnchorOp[]>();
  let cursor: number | null = null;
  return {
    get: (did) => chains.get(did) ?? null,
    set: (did, ops) => void chains.set(did, ops),
    getCursor: () => cursor,
    setCursor: (b) => void (cursor = b),
  };
}

/** A fake anchor reader with a controllable block height, event signal, and chain-read counter. */
function fakeReader(opts: { block?: number; hasEvents?: boolean; throwProbe?: boolean } = {}) {
  const state = {
    block: opts.block ?? 100,
    hasEvents: opts.hasEvents ?? false,
    throwProbe: opts.throwProbe ?? false,
    chainReads: 0 as number,
    blockReads: 0 as number,
  };
  const reader: AnchorEventView = {
    isAnchored: async (did) => (await reader.chain(did)).length > 0,
    chain: async (did) => {
      state.chainReads += 1;
      return [op(did.length)];
    },
    blockNumber: async () => {
      state.blockReads += 1;
      if (state.throwProbe) throw new Error("blockNumber failed");
      return state.block;
    },
    hasStoredEventsSince: async () => {
      if (state.throwProbe) throw new Error("getEvents failed");
      return state.hasEvents;
    },
  };
  return { reader, state };
}

test("cold cache (no cursor): first cycle refetches, sets the cursor", async () => {
  const { reader, state } = fakeReader({ block: 100 });
  const cache = memCache();
  const view = new EventCachingAnchorView(reader, cache);

  await view.beginCycle();
  await view.chain("did:plc:aaa");
  assert.equal(state.chainReads, 1, "cold cache forces a fetch");
  assert.equal(view.stats().refetched, 1);
  assert.equal(cache.getCursor(), 100, "cursor advanced to the observed block");
});

test("no events since last cycle: chains serve from cache, zero chain reads", async () => {
  const { reader, state } = fakeReader({ block: 100, hasEvents: false });
  const cache = memCache();
  const view = new EventCachingAnchorView(reader, cache);

  // Cycle 1 (cold): populate the cache.
  await view.beginCycle();
  await view.chain("did:plc:aaa");
  await view.chain("did:plc:bbb");
  const afterWarmup = state.chainReads;

  // Cycle 2: no events → everything from cache.
  state.block = 105;
  await view.beginCycle();
  await view.isAnchored("did:plc:aaa");
  await view.chain("did:plc:aaa");
  await view.chain("did:plc:bbb");
  assert.equal(state.chainReads, afterWarmup, "no RPC chain reads on a quiet cycle");
  assert.equal(view.stats().refetched, 0);
  assert.equal(view.stats().invalidated, false);
});

test("events since last cycle: cache is invalidated, chains refetched once each", async () => {
  const { reader, state } = fakeReader({ block: 100, hasEvents: false });
  const cache = memCache();
  const view = new EventCachingAnchorView(reader, cache);

  await view.beginCycle();
  await view.chain("did:plc:aaa");
  const warm = state.chainReads;

  // Cycle 2: a Stored event fired.
  state.hasEvents = true;
  state.block = 110;
  await view.beginCycle();
  // isAnchored + chain within one check() must cost exactly ONE refetch for the DID.
  await view.isAnchored("did:plc:aaa");
  await view.chain("did:plc:aaa");
  assert.equal(state.chainReads, warm + 1, "isAnchored+chain refetch the log at most once per DID");
  assert.equal(view.stats().refetched, 1);
});

test("fail-safe: a probe error invalidates the cache (full refetch), does not throw or serve stale", async () => {
  const { reader, state } = fakeReader({ block: 100, hasEvents: false });
  const cache = memCache();
  const view = new EventCachingAnchorView(reader, cache);

  // Warm the cache.
  await view.beginCycle();
  await view.chain("did:plc:aaa");
  const warm = state.chainReads;
  const cursorBefore = cache.getCursor();

  // Cycle 2: the event probe throws.
  state.throwProbe = true;
  await view.beginCycle(); // must not throw
  await view.chain("did:plc:aaa");
  assert.equal(state.chainReads, warm + 1, "a broken gate refetches rather than serving stale cache");
  assert.equal(view.stats().probeFailed, true);
  assert.equal(view.stats().invalidated, true);
  assert.equal(cache.getCursor(), cursorBefore, "cursor is NOT advanced on a probe failure");
});

test("a never-seen DID is fetched even on a quiet (no-event) cycle", async () => {
  const { reader, state } = fakeReader({ block: 100, hasEvents: false });
  const cache = memCache();
  const view = new EventCachingAnchorView(reader, cache);

  await view.beginCycle();
  await view.chain("did:plc:aaa"); // cache aaa
  const warm = state.chainReads;

  state.block = 101;
  await view.beginCycle(); // quiet
  await view.chain("did:plc:aaa"); // cached
  await view.chain("did:plc:zzz"); // brand new → must fetch
  assert.equal(state.chainReads, warm + 1, "only the new DID is fetched");
});
