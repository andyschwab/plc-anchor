//! PDS-host parser — the net-new building block. Both op shapes + the resolved-doc shape.

import assert from "node:assert/strict";
import { test } from "node:test";
import { hostOf, opMatchesPdsHost, pdsHostFromDidDoc, pdsHostFromOp } from "../src/pdshost.ts";

test("modern plc_operation services map", () => {
  const op = {
    type: "plc_operation",
    services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://pds.example.eu" } },
    rotationKeys: [],
  };
  assert.equal(pdsHostFromOp(op), "pds.example.eu");
});

test("modern op with port preserves host:port", () => {
  const op = { services: { atproto_pds: { endpoint: "https://pds.example.eu:8443/x" } } };
  assert.equal(pdsHostFromOp(op), "pds.example.eu:8443");
});

test("legacy create flat service URL", () => {
  const op = { type: "create", service: "https://bsky.social", handle: "a.example" };
  assert.equal(pdsHostFromOp(op), "bsky.social");
});

test("modern shape wins over a stray legacy service field", () => {
  const op = { services: { atproto_pds: { endpoint: "https://new.example" } }, service: "https://old.example" };
  assert.equal(pdsHostFromOp(op), "new.example");
});

test("no PDS endpoint → null", () => {
  assert.equal(pdsHostFromOp({ type: "plc_tombstone" }), null);
  assert.equal(pdsHostFromOp({ services: {} }), null);
  assert.equal(pdsHostFromOp(null), null);
  assert.equal(pdsHostFromOp("nope"), null);
});

test("malformed endpoint → null, not a throw", () => {
  assert.equal(pdsHostFromOp({ services: { atproto_pds: { endpoint: "not a url" } } }), null);
  assert.equal(pdsHostFromOp({ service: "" }), null);
  assert.equal(hostOf(undefined), null);
});

test("resolved DID document service array", () => {
  const doc = {
    service: [
      { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.eu" },
    ],
  };
  assert.equal(pdsHostFromDidDoc(doc), "pds.example.eu");
});

test("DID doc match by type when id differs", () => {
  const doc = { service: [{ id: "#pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://h.example" }] };
  assert.equal(pdsHostFromDidDoc(doc), "h.example");
});

test("opMatchesPdsHost is case-insensitive and exact", () => {
  const op = { services: { atproto_pds: { endpoint: "https://PDS.Example.EU" } } };
  assert.ok(opMatchesPdsHost(op, "pds.example.eu"));
  assert.ok(!opMatchesPdsHost(op, "other.example"));
  assert.ok(!opMatchesPdsHost(op, "ds.example.eu"));
});
