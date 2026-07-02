# Security Audit — Remediation TODO

Findings from the June 2026 internal security audit. Ordered by priority; items 1–2 are the
only ones that meaningfully affect security properties. Items 3–6 are resilience/quality
improvements.

**Status (2026-07-02):** **all items are done.** Items 2–6 landed on
`claude/security-updates-review-4ejk28`; item 1 (HIGH) landed on
`claude/final-security-todo-m6xhy7` — the witness now re-derives `nullified` locally from op
contents, differential-green against `@did-plc/lib`.

---

## 1. Re-derive `nullified` from op contents — HIGH  *(done)*

**Files:** `witness-ts/src/directory.ts`, `witness-ts/src/status.ts`

The `nullified` boolean from the plc.directory audit-log HTTP response is currently trusted
verbatim. A malicious directory can flip it to hide a legitimate op (false `diverged`) or
surface a forged op as live (false `confirmed`/`tentative-consistent`). The field must be
discarded and re-derived locally using the same recovery-key-index + 72h-window logic that
the Cairo contract enforces.

**Why this is its own PR (scope note).** Re-deriving `nullified` means reproducing PLC's
recovery decision, which turns on *which rotation key signed each op* — the signer key index.
That index is only obtainable by verifying each op's signature against the fork-point op's
`rotationKeys`, so item 1 requires bringing signature verification into `witness-ts`, which
today does **zero** crypto and has **no dependencies** (Node ≥22, type-strip, no build step).
did:plc uses two curves — **secp256k1** and **P-256** — with compact low-S ECDSA sigs over the
DRISL-encoded *unsigned* op and compressed did:key pubkeys.

**Load-bearing decisions (already settled for the follow-up):**
- **Crypto via Node builtins** (`node:crypto`), not a new dependency — preserves the
  zero-dep / no-build invariant. Hand-write did:key multibase decode, compressed-point
  decompression, and compact→DER signature conversion.
- The Cairo side is the byte-exact reference: `op_verify` (signer-index resolution),
  `sig_verify` (k256 low-S / p256 malleable), `recovery::classify_next_op` (72h + lower-index
  rule), and `state::apply_op` (fork-point search). Mirror these exactly.
- **Signed vs unsigned discipline** (CLAUDE.md / REFERENCE.md §5): DID/CID derivation hashes
  the *signed* op; signature verification is over the *unsigned* op (sig removed, then
  DRISL-encoded). Do not conflate.

**Guardrail:** this is a consensus-critical module — it must be **differential-green against
`@did-plc/lib`** before merge (CLAUDE.md), with its own vector corpus (extend
`conformance/`), never a hand-tuned fixture.

**Work items:**
- [x] Add a Node-builtin ECDSA verifier for secp256k1 + P-256 over did:key rotation keys
  (did:key decode, point decompression, low-S enforcement for k256, p256 malleability). —
  `witness-ts/src/crypto.ts` (`node:crypto`, compact `r‖s` via `dsaEncoding: "ieee-p1363"`;
  no new dependency). Byte-exact vs `@atproto/crypto`.
- [x] Implement signer-index resolution for an op against a `rotationKeys` set (the TS analog
  of `op_verify::verify_op_authorized`), over the *unsigned* DRISL bytes. — `opverify.ts`
  (`verifyOpAuthorized`) over `dagcbor.ts`'s canonical encoder (byte-exact vs `@ipld/dag-cbor`).
- [x] Implement re-derivation in `directory.ts` — `deriveLiveChain` replays the audit log
  (recomputing CIDs, verifying signatures, applying the lower-index-key + 72h-window recovery
  rule), and `deriveNullified(ops): Set<string>` returns the non-live CIDs, regardless of the
  directory claim. Mirrors `state::apply_op` / `recovery::classify_next_op`.
- [x] Wire into `status.ts` in place of the directory-asserted `nullified` flag. — `check` now
  derives its live head + live-CID set via `deriveLiveChain` (default; injectable for the
  ladder/transport tests, which drive stub ops).
- [x] Add a differential vector corpus (ground-truthed vs `@did-plc/lib`) plus adversarial test
  cases in `witness-ts/test/`. — `conformance/src/gen-nullified-vectors.mjs` +
  `witness-ts/test/nullified.test.ts` (valid recovery, weaker-key/late/forged/build-on-tombstone
  injections, flag-independence, and the status payoff: a flag-lying mirror can no longer suppress
  the correct verdict). Wired into `make ci` via `gen-nullified-vectors-check`.

---

## 2. Runtime-validate and bound directory HTTP responses — MEDIUM

**File:** `witness-ts/src/directory.ts:54-59`

`auditLog()` casts the HTTP body with `as AuditEntry[]` — no runtime checks, no size bounds.
Missing fields silently become `undefined`/`NaN` and flow into comparisons rather than
surfacing as explicit errors.

**Work items:**
- [x] Replace the bare cast with explicit runtime validation: `Array.isArray`, max array
  length, required fields (`cid`, `createdAt`, `nullified`, `operation`) present and correctly
  typed. — `parseAuditLog`/`isAuditEntry` in `directory.ts`.
- [x] Treat missing/malformed fields as a hard error (throw), not silent `undefined`.
- [x] Add a max-bytes cap on the raw fetch body (or check `Content-Length` before reading). —
  `readBoundedText` (streaming cap + `Content-Length` pre-check), 8 MiB.

---

## 3. Bound recursion depth in the ingest re-encoder — MEDIUM

**File:** `ingest/src/reencode.rs:48-64`, `ingest/src/source.rs`

`json_to_ipld` recurses with no depth limit; a deeply-nested payload from a malicious mirror
can stack-overflow the long-running indexer process. `serde_json::from_str` has no depth
guard either, so the crash can happen before re-encoding is reached.

**Work items:**
- [x] Add `max_depth: usize` parameter to `json_to_ipld` (64 is well above any legitimate PLC
  op); return `Err` instead of recursing further. — depth budget, `MAX_DEPTH = 64`.
- [x] Add a max-bytes cap on HTTP response bodies in `source.rs` before passing to
  `serde_json::from_str`. — `MAX_BODY_BYTES = 32 MiB` via ureq `.limit(...)` on both reads.

---

## 4. Treat unparseable `createdAt` as an explicit error — LOW

**File:** `witness-ts/src/status.ts:138-139`

When `Date.parse(entry.createdAt)` yields `NaN`, `withinHorizon` silently defaults to `true`
(non-alarming). A directory serving a malformed timestamp can suppress a `diverged` verdict
indefinitely.

**Work item:**
- [x] Treat `NaN` from `Date.parse` as an unverifiable state — propagate an error or surface
  a distinct status (e.g. `error`) rather than absorbing it as non-alarming. — new `error`
  status (`directory-timestamp-unparseable`), CLI exit 1.

---

## 5. Consolidate duplicate op-verification logic — INFORMATIONAL

**Files:** `cairo/packages/plc_core/src/verify.cairo`, `src/state.cairo`, `src/anchor.cairo`

`verify.cairo`'s `verify_next_op`/`check_prev_link` are unreachable — `submit_op` reimplements
the same fork-point/authorization logic inline. Two parallel implementations of
security-critical code risk silent drift if one is patched without the other.

**Work item:**
- [x] Either delete `verify.cairo` and its dead transitive code, or wire `state.cairo`/
  `anchor.cairo` through it so there is a single implementation. — deleted `verify.cairo` +
  `tests/verify.cairo`; `state::apply_op` is the single integrated path. (`check_prev_link`
  kept — a standalone P2.4 primitive with its own test in `tests/link.cairo`.)

---

## 6. Fix stale doc comment in `recovery.cairo` — INFORMATIONAL

**File:** `cairo/packages/plc_core/src/recovery.cairo:21-22`

Comment claims `now`/`createdAt` are "never a block clock." They are — `anchor.cairo` feeds
`get_block_timestamp() * 1000`. One-line correction.

- [x] Done — corrected to distinguish `createdAt` (directory time, never a block clock) from
  `now` (the caller's clock; the block timestamp in production, a fixed value in tests).

---

## Dependency order

```
3 & 4  (ingest bounds, timestamp guard)   — DONE
2      (response validation)              — DONE
└─ 1   (nullified re-derivation)          — DONE; builds on the now-validated op payloads
5 & 6  (Cairo cleanup)                    — DONE
```

Item 1 builds on item 2's validation: `deriveLiveChain` starts from `parseAuditLog`'s
well-typed entries (`operation` is guaranteed a present object) and re-derives PLC recovery from
those payloads, discarding the untrusted `nullified` flag.
