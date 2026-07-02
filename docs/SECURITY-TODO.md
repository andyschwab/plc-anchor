# Security Audit — Remediation TODO

Findings from the June 2026 internal security audit. Ordered by priority; items 1–2 are the
only ones that meaningfully affect security properties. Items 3–6 are resilience/quality
improvements. Finding **4a** (below) is a later, higher-severity finding from the July 2026
design review — a write-path capture, not a read-path suppression like item 1.

**Status (2026-07-02):** items 1–6 done (item 1 HIGH — the witness re-derives `nullified`
locally, differential-green vs `@did-plc/lib`). **Finding 4a (CRITICAL, below): fix landed on
`claude/project-analysis-risk-oudg4u`** — imported history is now marked *settled* on-chain
(a recovery may not nullify it) and ingest onboards via the settled `import` chain. Rust-green;
the Cairo suite must be run on CI / a Scarb box before the mainnet deploy.

---

## 4a. Imported history must be settled — recovery-window capture — CRITICAL  *(done)*

**Files:** `cairo/packages/plc_core/src/state.cairo`, `src/anchor.cairo`,
`cairo/packages/plc_core/tests/anchor.cairo`, `ingest/src/{pipeline,sink,starknet_sink,main}.rs`

`import`/`import_genesis` stamp every backfilled op with the import block time, and the 72h
recovery window (`recovery::classify_next_op`) is measured against that stamp. So for 72h after
onboarding, the *entire* history reads as freshly authored. A PLC recovery is authorized by any
**strictly-higher-priority** rotation key; a key that was higher-priority at a historical fork
point but has since been **rotated away** (the custodial→self-hosted migration leaves exactly
such a key, no longer the DID's controller) could fork below the real history *within that
window* and nullify it — capturing the anchored DID. The anchor would then harden the forged
head to `confirmed` and read `diverged` against an **honest** directory: the anchor manufacturing
the very false-`diverged` the §0 governing invariant exists to prevent. The earlier claim
(HISTORY.md item 3) that re-exposing the window was "sound because it never lets a *non*-key-holder
mutate a DID" missed that a *former* key-holder is not the current controller.

**Root cause.** The 72h window is a *live-observation* mechanism; the anchor has no authored
timestamp (it's not in the signed op, §1/§5), so it cannot soundly adjudicate the window for
history it never observed live. Backfilled ops must not be given a (block-time) window at all.

**Fix (two layers):**
- [x] **Contract — provenance + guard.** `OpRecord`/`StoredOp` carry `imported: bool`
  (`true` for `import`/`import_genesis`, `false` for `submit_op`). `state::apply_op` rejects a
  recovery whose first-nullified op is imported (`recovery-of-imported`); imported ops always
  form the chain prefix, so checking the first nullified op suffices. The guard is a *strictly
  conservative* refinement of `classify_next_op` (only ever rejects), layered in `state`, so the
  differential-green PLC validation (`recovery`/`op_verify`) is untouched — **no vector
  regeneration**. Test: `recovery_cannot_nullify_imported_history` vs. the still-passing
  `recovery_through_contract` (live opA remains recoverable).
- [x] **Ingest — onboard via the settled chain.** `onboard_via_import` imports a DID's whole
  resolved history as one settled `import` call (new `Delta::Import` → the `import` entrypoint),
  replacing the old `import_genesis` + per-successor `submit_op` onboarding that would live-stamp
  historical ops and defeat the guard. `submit_op` is reserved for genuinely-live tail ops.

**Guardrail:** consensus-critical Cairo — run `make cairo-test` on CI / a Scarb-equipped box
before merge/deploy (not runnable in the authoring sandbox: no Scarb, installer host blocked by
the network policy). The `StoredOp` layout change is safe on the fresh mainnet deploy (migration
= re-import from genesis).

**Residual (documented, §0-safe direction).** A DID onboarded while its real tail op is still
in-window imports that tail as settled, so a *legitimate* recovery of it can't be mirrored
on-chain → a benign, operator-recoverable `diverged` on that one DID. This degrades to the status
quo, never to capture; live-stamping the tail to avoid it would re-open a bounded capture window
(the unsafe direction) and was rejected. Follow-up: the firehose/roster path can still live-stamp
ancient history if pointed at old data — an operational foot-gun to fence off (onboard via
`--did`/`import`; tail from a recent cursor).

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
