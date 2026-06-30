# Phase 5 — witness / resolver library: notes for when we get there

Pre-plan **context capture** for build-order item 5 (`REFERENCE.md` §3), the V1 product —
"atproto identity DMARC" (`REFERENCE.md` §1a Mode 1). Not a plan yet: this records decisions
and the one genuinely-hard rule we worked out with context fresh, so the next session isn't a
cold start. Scope/rationale live in `REFERENCE.md` §1, §1a, §4, §5; don't relitigate
`CLAUDE.md` "Do NOT relitigate".

Prereq: item 4 (`ingest/`) — the library leans on the directory audit log it consumes (see
"Clock reconciliation" below). Build order is dependency order; this still ships after 1–4.

---

## 1. What the library does

Given a DID, return its document + an inclusion proof against the published root, as a
**graduated status** — `confirmed` / `tentative-consistent` / `diverged` / `absent` (§4).
It is the read-side accountability check a resolver/PDS runs **unilaterally**. Must be cheap
and **portable** (resolvers in any language) — an anchor nobody checks is theater.

Inputs:
- **On-chain:** `anchor::confirmed_root` + `anchor::tentative_root` (now-parameterized views)
  and an inclusion proof for the DID's head. Proof *verification* already exists and is
  format-pinned: `plc_core::merkle::verify_proof` (leaf `sha256(0x00 ‖ did ‖ head_cid)`,
  node `sha256(0x01 ‖ left ‖ right)`, did-sorted, RFC 6962 odd-node promotion). Item 5
  packages root-fetch + proof-check around it.
- **Off-chain (directory/mirror):** the DID's current document **and audit log** (the audit
  log is where `createdAt` is visible — it is *not* in the signed op; §5).

## 2. Status computation (sketch — candidate, not settled)

1. DID not in the anchored roster → **`absent`** (coverage gap, like DMARC `p=none`).
2. Verify the inclusion proof for the anchored head against the root (`merkle::verify_proof`).
3. Directory head `H_dir` == anchor **confirmed** head → **`confirmed`**.
4. `H_dir` extends the confirmed chain and the extension sits inside the anchor's tentative
   window → **`tentative-consistent`**.
5. Otherwise `H_dir` *contradicts* the proven head (omits a confirmed op, or forks below a
   confirmed point) → **`diverged`** — **unless** the disagreement is fully explained by
   clock skew at the window edge (§3), which is a soft/skew-pending case, not an alarm.

## 3. Clock reconciliation — the hard part (window-edge recovery)

The decided contract behavior (`REFERENCE.md` §1, §5): `createdAt` is **not** in the signed
op, so the contract uses **Starknet block time** as the pragmatic `createdAt`, and imported
ops use import block time. The anchor's clock is therefore **strictly later** than the
directory's. Two consequences, opposite directions:

- **Finality lags (benign, common):** the anchor confirms *later* than the directory. A head
  the directory already calls `confirmed` while the anchor still calls `tentative`, histories
  agreeing → `tentative-consistent`. Never `diverged`.
- **Recovery is more permissive at the edge (the hard case):** PLC recovery lets a
  higher-priority key nullify within 72h of `createdAt`. Because the anchor's window opens
  later, near the edge the anchor can **accept a nullification the directory rejected as
  too-late** — the two then commit to different heads from skew alone.

**Where reconciliation belongs: the read-side library, not the contract.** The contract
intentionally sees only block time and stays simple/conservative. The *library* reads **both**
clocks — the directory audit log exposes `createdAt`; the chain exposes the anchor's
observation time — so it can compute per-op skew and decide whether an edge disagreement is
*explained by skew* (benign → defer judgment until the anchor window closes, then re-evaluate)
or *unexplained* (genuine omission/contradiction → `diverged`). This is the DMARC discipline:
do not quarantine on a transient.

**Candidate rule to pin at implementation:**
- Compute `skew = anchor_observation_time − directory_createdAt` per op.
- An anchor/directory disagreement about a recovery near the 72h edge that is fully accounted
  for by `skew` → **skew-pending** (report as `tentative-consistent` with a reason), resolved
  once the anchor's window closes.
- Disagreement **not** accounted for by `skew`, or a contradiction against already-`confirmed`
  history → **`diverged`**.
- Settle the exact `skew` bound and the re-evaluation trigger here; document it as a pinned
  rule (resolvers depend on it).

## 4. False-positive discipline

`diverged` is the only actionable alarm (warn / quarantine / refuse to relay). If it fires on
benign clock lag, operators turn the check off — the DMARC `ruf`-noise failure mode. The
directional model (§3) is what keeps it honest: lag and edge-skew are *expected* and must not
alarm; only unexplained committed-history contradiction does.

## 5. Don't

- Don't put `createdAt` or clock reconciliation **into the contract** — it's read-side.
- Don't offer a hard "reject unless `confirmed`" gate — it rejects every legitimate update
  from the last 72h. The product is the graduated status (§4).
- Don't change the `merkle` leaf/node format — it's pinned and resolvers depend on it.

## 6. Testing

Differential, like everything consensus-touching, but the oracle here is a *table of
scenarios*: given (directory decision via `@did-plc/lib`, anchor decision via the contract,
skew), assert the right status. Build targeted **window-edge recovery vectors** (recovery
landing just inside/outside each clock's window) — that is where the rule earns its keep.
