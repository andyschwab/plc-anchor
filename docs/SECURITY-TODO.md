# Security Audit — Remediation TODO

Findings from the June 2026 internal security audit. Ordered by priority; items 1–2 are the
only ones that meaningfully affect security properties. Items 3–6 are resilience/quality
improvements.

---

## 1. Re-derive `nullified` from op contents — HIGH

**Files:** `witness-ts/src/directory.ts`, `witness-ts/src/status.ts`

The `nullified` boolean from the plc.directory audit-log HTTP response is currently trusted
verbatim. A malicious directory can flip it to hide a legitimate op (false `diverged`) or
surface a forged op as live (false `confirmed`/`tentative-consistent`). The field must be
discarded and re-derived locally using the same recovery-key-index + 72h-window logic that
the Cairo contract enforces.

**Work items:**
- [ ] Implement `deriveNullified(ops: AuditEntry[]): Set<string>` in `directory.ts` — scan
  the op chain for any rotation using a lower-index recovery key within the 72h window of the
  op it supersedes; that op and everything after it are nullified regardless of the directory
  claim.
- [ ] Wire into `status.ts` in place of the directory-asserted `nullified` flag.
- [ ] Add adversarial test cases in `witness-ts/test/`: directory claims op is not nullified
  but local re-derivation says it is → expect `diverged`.

---

## 2. Runtime-validate and bound directory HTTP responses — MEDIUM

**File:** `witness-ts/src/directory.ts:54-59`

`auditLog()` casts the HTTP body with `as AuditEntry[]` — no runtime checks, no size bounds.
Missing fields silently become `undefined`/`NaN` and flow into comparisons rather than
surfacing as explicit errors.

**Work items:**
- [ ] Replace the bare cast with explicit runtime validation: `Array.isArray`, max array
  length, required fields (`cid`, `createdAt`, `nullified`, `operation`) present and correctly
  typed.
- [ ] Treat missing/malformed fields as a hard error (throw), not silent `undefined`.
- [ ] Add a max-bytes cap on the raw fetch body (or check `Content-Length` before reading).

---

## 3. Bound recursion depth in the ingest re-encoder — MEDIUM

**File:** `ingest/src/reencode.rs:48-64`, `ingest/src/source.rs`

`json_to_ipld` recurses with no depth limit; a deeply-nested payload from a malicious mirror
can stack-overflow the long-running indexer process. `serde_json::from_str` has no depth
guard either, so the crash can happen before re-encoding is reached.

**Work items:**
- [ ] Add `max_depth: usize` parameter to `json_to_ipld` (64 is well above any legitimate PLC
  op); return `Err` instead of recursing further.
- [ ] Add a max-bytes cap on HTTP response bodies in `source.rs` before passing to
  `serde_json::from_str`.

---

## 4. Treat unparseable `createdAt` as an explicit error — LOW

**File:** `witness-ts/src/status.ts:138-139`

When `Date.parse(entry.createdAt)` yields `NaN`, `withinHorizon` silently defaults to `true`
(non-alarming). A directory serving a malformed timestamp can suppress a `diverged` verdict
indefinitely.

**Work item:**
- [ ] Treat `NaN` from `Date.parse` as an unverifiable state — propagate an error or surface
  a distinct status (e.g. `error`) rather than absorbing it as non-alarming.

---

## 5. Consolidate duplicate op-verification logic — INFORMATIONAL

**Files:** `cairo/packages/plc_core/src/verify.cairo`, `src/state.cairo`, `src/anchor.cairo`

`verify.cairo`'s `verify_next_op`/`check_prev_link` are unreachable — `submit_op` reimplements
the same fork-point/authorization logic inline. Two parallel implementations of
security-critical code risk silent drift if one is patched without the other.

**Work item:**
- [ ] Either delete `verify.cairo` and its dead transitive code, or wire `state.cairo`/
  `anchor.cairo` through it so there is a single implementation.

---

## 6. Fix stale doc comment in `recovery.cairo` — INFORMATIONAL

**File:** `cairo/packages/plc_core/src/recovery.cairo:21-22`

Comment claims `now`/`createdAt` are "never a block clock." They are — `anchor.cairo` feeds
`get_block_timestamp() * 1000`. One-line correction.

---

## Dependency order

```
3 & 4  (ingest bounds, timestamp guard)   — independent, can be done in parallel
2      (response validation)
└─ 1   (nullified re-derivation)          — builds on validated op payloads; do 2 first
5 & 6  (Cairo cleanup)                    — independent, any time
```
