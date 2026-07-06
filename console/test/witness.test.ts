//! StoreChainCache — the AnchorOp⇆JSON(base64) adapter between the witness library's ChainCache
//! port and the RosterStore. The byte round-trip is load-bearing: a corrupted `signed` byte would
//! re-derive a wrong head and could manufacture a false `diverged`, so this pins it exactly.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnchorOp } from "../../witness-ts/src/index.ts";
import { StoreChainCache, type ChainCacheStore } from "../src/witness.ts";

/** In-memory ChainCacheStore (the slice of RosterStore the adapter uses). */
function fakeStore(): ChainCacheStore {
  const chains = new Map<string, string>();
  const meta = new Map<string, string>();
  return {
    getChainCache: (did) => chains.get(did) ?? null,
    setChainCache: (did, ops) => void chains.set(did, ops),
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
  };
}

test("chain round-trips exact bytes (incl. 0x00 and high bytes) through base64", () => {
  const cache = new StoreChainCache(fakeStore());
  const ops: AnchorOp[] = [
    { signed: new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x80]), createdAt: 1_700_000_000_000, imported: true },
    { signed: new Uint8Array([]), createdAt: 0, imported: false },
  ];
  cache.set("did:plc:aaa", ops);
  const got = cache.get("did:plc:aaa");
  assert.deepEqual(got, ops, "bytes, createdAt, and imported all preserved");
  assert.ok(got![0].signed instanceof Uint8Array, "signed comes back as a Uint8Array");
});

test("get returns null for an unknown DID", () => {
  const cache = new StoreChainCache(fakeStore());
  assert.equal(cache.get("did:plc:missing"), null);
});

test("cursor round-trips and rejects a non-integer stored value", () => {
  const store = fakeStore();
  const cache = new StoreChainCache(store);
  assert.equal(cache.getCursor(), null, "unset → null");
  cache.setCursor(4242);
  assert.equal(cache.getCursor(), 4242);
  store.setMeta("anchorcache:cursor", "garbage");
  assert.equal(cache.getCursor(), null, "a corrupt cursor reads as null (cold start), not NaN");
});
