//! `SharedSecretAuth` — login exchanges the operator secret for a short-lived HMAC session token;
//! `verify` accepts only unexpired, correctly-signed tokens presented as a bearer header.

import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { SharedSecretAuth } from "../src/auth.ts";

/** Minimal stand-in for the bits of IncomingMessage that `verify` reads. */
function reqWith(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

test("constructor rejects an empty secret", () => {
  assert.throws(() => new SharedSecretAuth(""), /non-empty secret/);
});

test("login: wrong or missing secret → null, correct → a session", () => {
  const auth = new SharedSecretAuth("hunter2");
  assert.equal(auth.login({ secret: "nope" }), null);
  assert.equal(auth.login({}), null);
  assert.equal(auth.login(null), null);
  assert.equal(auth.login("hunter2"), null); // must be a {secret} object, not a bare string
  const session = auth.login({ secret: "hunter2" });
  assert.ok(session);
  assert.ok(session.token.includes("."));
  assert.ok(session.expiresAt > Date.now());
});

test("verify: accepts a fresh token via Bearer header", () => {
  const auth = new SharedSecretAuth("s3cret");
  const { token } = auth.login({ secret: "s3cret" })!;
  assert.equal(auth.verify(reqWith(`Bearer ${token}`)), true);
  assert.equal(auth.verify(reqWith(`bearer ${token}`)), true); // scheme is case-insensitive
});

test("verify: rejects missing, malformed, and non-bearer credentials", () => {
  const auth = new SharedSecretAuth("s3cret");
  const { token } = auth.login({ secret: "s3cret" })!;
  assert.equal(auth.verify(reqWith()), false);
  assert.equal(auth.verify(reqWith(token)), false); // no Bearer scheme
  assert.equal(auth.verify(reqWith("Bearer ")), false);
  assert.equal(auth.verify(reqWith("Bearer not-a-token")), false);
});

test("verify: rejects a tampered signature", () => {
  const auth = new SharedSecretAuth("s3cret");
  const { token } = auth.login({ secret: "s3cret" })!;
  const [payload] = token.split(".");
  assert.equal(auth.verify(reqWith(`Bearer ${payload}.deadbeef`)), false);
});

test("verify: rejects an expired token", () => {
  const auth = new SharedSecretAuth("s3cret", -1); // already expired on mint
  const { token } = auth.login({ secret: "s3cret" })!;
  assert.equal(auth.verify(reqWith(`Bearer ${token}`)), false);
});

test("verify: a token minted by a different secret does not validate", () => {
  const a = new SharedSecretAuth("secret-a");
  const b = new SharedSecretAuth("secret-b");
  const { token } = a.login({ secret: "secret-a" })!;
  assert.equal(b.verify(reqWith(`Bearer ${token}`)), false);
});
