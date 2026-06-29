# Phase 2 → 3 plan

Working plan for finishing **Phase 2 (PLC op verification + recovery)** and entering
**Phase 3 (state commitment + anchor endpoint)**. Scope and rationale come from
`REFERENCE.md` §3–5; this doc is the **sequencing and acceptance** layer. It does not
relitigate anything in `CLAUDE.md` "Do NOT relitigate".

---

## 0. Status correction

Phase 2 is **partially complete**, not done. The landing commit (`abeb051`) delivered PLC op
*signature* verification — a subset of `REFERENCE.md` §3 item 2. The repo tracker already
reflects this: `CLAUDE.md` build order item 2 is ⏳, not ✅.

**Done and differential-green** (6-op corpus vs `@did-plc/lib`, three-way conformance):
- secp256k1 + secp256r1 ECDSA over the DRISL-encoded *unsigned* op — `plc_core/sig_verify.cairo`
- `did:key` parse (base58btc → multicodec → compressed pubkey) — `plc_core/key_parse.cairo`
- unsigned-op extraction (byte-level `sig`-strip; relies on `sig` being the first map key) —
  `plc_core/op_verify.cairo`
- base64url-nopad sig decode
- corpus: k256 genesis, 2-rotation genesis, p256 genesis, mixed-key genesis, update, tombstone

**Not done** (still Phase 2 per §3 item 2 + §5) — tracked as P2.1–P2.5 below.

> **Why this blocks Phase 3.** Phase 3's confirmed/tentative tiers need the nullification
> rules (P2.4); `submit_op`'s `prev == head` enforcement needs op-structure decode + signer
> *index* (P2.1–P2.3). Remaining Phase 2 is a hard prerequisite, not polish.

---

## 1. Remaining Phase 2 work

Each item lands behind a differential gate against `@did-plc/lib` (extend
`conformance/src/check.mjs` + the generated Cairo vector tables; never hand-edit a vector —
`CLAUDE.md` guardrails).

### P2.1 — Op-structure decode + constraint validation
New `plc_core/op_decode.cairo`. Decode a signed op's DRISL into typed fields without a full
generic CBOR decoder — a targeted reader over the known PLC schema (keys are a fixed small
set). Produce a struct:

```
Op { type, prev: Option<Cid>, rotation_keys: Array<ByteArray>,
     verification_methods, also_known_as, services, sig }
```

Enforce §5 constraints, rejecting on violation:
- `type ∈ { plc_operation, create, plc_tombstone }`
- `len(rotation_keys) ∈ 1..=5`
- `len(verification_methods) ≤ 10`
- encoded op size ≤ 7500 bytes
- genesis ⇔ `prev == null`

**Gate:** decode every corpus op; assert field-by-field agreement with the JSON the TS oracle
emits. Add malformed-op rejection vectors (over-limit rotationKeys, bad type, oversize).

### P2.2 — Legacy `create` op support
Add a legacy-`create` vector to the corpus (`gen-plc-corpus.mjs`; `@did-plc/lib` still emits
these). `create` has a different field shape (`signingKey`/`recoveryKey` vs
`rotationKeys`/`verificationMethods`) — handle both shapes in P2.1's decoder, or normalize
`create` → modern shape at decode time (preferred: keep one downstream representation).

### P2.3 — Authorized-signer derivation + signer index
Replace the caller-supplied `signer_key_str` in `verify_op_sig` with derivation from the op
chain:
- **genesis**: allowed signers = the op's own `rotation_keys`.
- **non-genesis**: allowed signers = the *previous* op's `rotation_keys`.

Verify the sig against each allowed key; on success, **return the matching key index**. That
index is the recovery-priority input for P2.4. Reject if no key matches.

**Gate:** for each corpus op, assert the returned signer index equals `@did-plc/lib`'s
`assureValidSig` result (already used in `check.mjs` phase 3 — extend it to also assert the
index).

### P2.4 — `prev` linkage
Enforce `op.prev == CID(previous signed op)`, reusing `drisl::cid`. Genesis requires
`prev == null`. This is the per-DID linearization primitive (the residual-trust "ordering" of
§1) — pure given a candidate ordered chain; on-chain `head` tracking is Phase 3.

**Gate:** a multi-op chain vector (genesis → update → tombstone for one DID); assert accept on
correct linkage, reject on a tampered `prev`.

### P2.5 — 72h recovery state machine
New `plc_core/recovery.cairo`. Pure logic (no storage): given an ordered op history + a
candidate op, decide accept / nullify-and-fork per §4–5:
- a lower-index (higher-priority) rotation key signing within 72h of a contested op nullifies
  the lower-priority branch, forking to the last universally-accepted state;
- `createdAt` drives the window (residual-trust "timestamp", §1) — take it as an input
  parameter, do not trust a block clock.

**Gate:** recovery-scenario vectors generated from `@did-plc/lib`'s recovery paths
(`rotateOp` / nullification fixtures): contested fork inside the window, attempt outside the
window (rejected), priority ordering among 3–5 keys.

**Decision (recorded): recovery stays in Phase 2.** It is pure verification logic,
differential-testable in isolation, independent of on-chain commitment. Phase 3 consumes its
output (which ops are confirmed vs nullifiable) to build the two-tier roots.

---

## 2. Phase 3 scope (next)

Lands in `plc_core` as contract code; measured with `snforge` gas on real entrypoints
(`CLAUDE.md` guardrails). Depends on all of §1.

- **P3.1 Per-DID head + state** — storage map `did → head_cid` (+ tentative tip); the
  `prev == head` rule enforced on append using P2.3/P2.4.
- **P3.2 DID→document commitment** — a root over the map so resolution = root + inclusion
  proof (Phase 5's read surface). Pick the accumulator (Merkle vs Starknet-native Poseidon
  trie) here; cheap inclusion proofs are the constraint (adoption surface).
- **P3.3 Confirmed / tentative tiers (§4)** — confirmed root commits ops past the 72h window
  (immutable); tentative tip carries within-window ops, flagged, using P2.5's nullification
  verdicts.
- **P3.4 Permissionless `import` / `submit_op` (§2)** — `import(did, chain)` verifies a full
  log from genesis and commits the head; `submit_op(op)` appends. **Authorization = the op's
  embedded sig (P2.3), never the Starknet tx signer** (`CLAUDE.md`). Native AA / paymasters
  are gas/UX only.

**Open question to resolve before §3 settlement wiring (do not treat as settled):** appchain
timing — whether public Starknet's L1→L2 forced-inclusion guarantee is strong enough for CR
(`REFERENCE.md` §6a). Decide before relying on it.

---

## 3. Sequencing

```
P2.1 decode ─┬─ P2.2 legacy create
             ├─ P2.3 signer index ── P2.4 prev linkage ── P2.5 recovery
             │                                                  │
             └──────────────────────────────────────────────► P3.x (state + endpoint)
```

P2.1 first (everything decodes through it). P2.2 folds into P2.1's decoder. P2.3 → P2.4 →
P2.5 are a chain. Phase 3 starts only when §1 is differential-green end-to-end.

## 4. Test / differential strategy

- Extend the corpus generator (`gen-plc-corpus.mjs`) with: a legacy `create`, a full
  genesis→update→tombstone chain, malformed-op rejection cases, and recovery scenarios.
- Extend `check.mjs` to assert signer-index and recovery verdicts, not just sig validity.
- Regenerate Cairo vector tables via `make gen-plc-vectors`; CI drift gate
  (`gen-plc-vectors-check`) stays green. Never hand-edit vectors.
- Each P2.x item is "done" only when Cairo ⇄ `@did-plc/lib` agree on accept **and** reject
  cases.

## 5. Exit criteria

- **Phase 2 complete:** P2.1–P2.5 differential-green; `CLAUDE.md` build order item 2 → ✅ with
  the acceptance note (mirroring the Phase 1 close-out).
- **Phase 3 ready:** decode + signer-index + prev + recovery callable as a single
  `verify_and_classify(chain, op) → {accepted, signer_index, confirmed|tentative}` surface for
  the contract to consume.
