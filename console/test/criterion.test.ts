//! Roster criterion — parsing `ROSTER_CRITERION` and the domain-suffix match over hosts, ops, and
//! resolved DID documents.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCriterion } from "../src/criterion.ts";

test("parses pds_domain and matches host / subdomains, case-insensitively", () => {
  const c = parseCriterion("pds_domain:eurosky.social");
  assert.equal(c.kind, "pds_domain");
  assert.equal(c.base, "eurosky.social");
  assert.equal(c.label, "PDS = eurosky.social");

  assert.equal(c.matchesHost("eurosky.social"), true);
  assert.equal(c.matchesHost("EUROSKY.social"), true, "case-insensitive");
  assert.equal(c.matchesHost("pds1.eurosky.social"), true, "subdomain matches");
  assert.equal(c.matchesHost("eurosky.social:443"), true, "host:port matches on host");

  assert.equal(c.matchesHost("noteurosky.social"), false, "must be a dot-boundary suffix");
  assert.equal(c.matchesHost("eurosky.social.evil.com"), false, "not a suffix");
  assert.equal(c.matchesHost("bsky.social"), false);
  assert.equal(c.matchesHost(null), false);
  assert.equal(c.matchesHost(""), false);
});

test("matchesOp extracts the PDS host from modern + legacy ops", () => {
  const c = parseCriterion("pds_domain:eurosky.social");
  const modern = { services: { atproto_pds: { endpoint: "https://pds1.eurosky.social" } } };
  const legacy = { service: "https://eurosky.social" };
  const other = { services: { atproto_pds: { endpoint: "https://bsky.social" } } };
  assert.equal(c.matchesOp(modern), true);
  assert.equal(c.matchesOp(legacy), true);
  assert.equal(c.matchesOp(other), false);
  assert.equal(c.matchesOp(null), false);
});

test("matchesDidDoc extracts the PDS host from a resolved doc", () => {
  const c = parseCriterion("pds_domain:eurosky.social");
  const doc = {
    service: [
      { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://eurosky.social" },
    ],
  };
  assert.equal(c.matchesDidDoc(doc), true);
  assert.equal(c.matchesDidDoc({ service: [] }), false);
});

test("tolerates a leading dot in the base and whitespace", () => {
  const c = parseCriterion("  pds_domain: .eurosky.social  ");
  assert.equal(c.base, "eurosky.social");
  assert.equal(c.matchesHost("pds.eurosky.social"), true);
});

test("rejects empty / unknown criteria loudly", () => {
  assert.throws(() => parseCriterion(""), /required/);
  assert.throws(() => parseCriterion(undefined), /required/);
  assert.throws(() => parseCriterion("something_else:x"), /unsupported/);
  assert.throws(() => parseCriterion("pds_domain:"), /base domain/);
});
