# Phase 2 → 3 plan

Working plan for finishing **Phase 2 (PLC op verification + recovery)** and entering
**Phase 3 (state commitment + anchor endpoint)**. Scope and rationale come from
`REFERENCE.md` §3–5; this doc is the **sequencing and acceptance** layer. It does not
relitigate anything in `CLAUDE.md` "Do NOT relitigate".

---

## 0. Status

**Phase 2 is complete** (P2.1–P2.5 landed and differential-green; see §5 exit criteria).
This section is kept for the record of where it started.

The original gap: the landing commit (`abeb051`) delivered PLC op *signature* verification
only — a subset of `REFERENCE.md` §3 item 2. Everything below P2.1 was then built out.

> **Consensus correction made during P2.2:** S-malleability is curve-asymmetric in the
> reference (`@atproto/crypto`) — k256 requires low-S, **p256 is malleable** (high-S
> accepted). The earlier "low-S required" for both (old `REFERENCE.md` §5) was wrong for
> p256 and would have forked. Fixed in `sig_verify` + §5, guarded by a forced-high-S p256
> vector and a high-S k256 reject vector.

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

## 1. Remaining Phase 2 work — ✅ done

All of P2.1–P2.5 landed, each behind a differential gate against `@did-plc/lib`, plus the
integrated `verify::verify_next_op` seam. Implementation notes vs the original plan below:
- **P2.1** `op_decode.cairo` reuses the keystone `drisl::decode` (one canonical CBOR layer)
  rather than a second hand-rolled reader.
- **P2.2** legacy `create` decoded + normalized; surfaced the p256 malleability fix (§0).
- **P2.3** `verify_op_authorized` returns the signer index; the create vector pins index 1.
- **P2.4** `drisl::cid::derive_cid_string` (base32) + `link::check_prev_link`.
- **P2.5** `recovery::classify_next_op`; vectors ground-truthed by `assureValidNextOp`.

Original per-item specs retained below for reference.

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

## 2. Phase 3 scope

Lands in `plc_core` as contract code. Status: the permissionless endpoint with
append + recovery + confirmed/tentative tiers is live and offline-tested, and the sha256
Merkle commitment root (P3.2) has landed (pure `merkle` module + contract `tentative_root`/
`confirmed_root` views, format-pinned by a TS cross-check). Multi-op genesis import (P3.4)
remains.

- ✅ **P3.1 Per-DID head + state** — `state::{import_genesis, apply_append, DidHead}`; the
  `prev == head` rule on append via P2.3/P2.4. Differential on the corpus chain.
- ✅ **P3.1b Anchor contract** — `anchor` `#[starknet::contract]`: `import_genesis` /
  `submit_op` / views; embedded-sig authorization (tx signer irrelevant); offline-tested via
  `contract_state_for_testing`.
- ✅ **P3.3 Confirmed / tentative tiers (§4) + recovery** — `state::{OpRecord, apply_op,
  rebuild_chain, confirmed_head, tentative_head}`; the contract stores a per-DID chain
  (`Map<felt, Vec<StoredOp>>`) and `submit_op` handles forks (truncate-to-fork + push),
  applying the 72h rule via `classify_next_op`. Ground-truthed end-to-end against
  `assureValidNextOp` (deterministic fixed-key scenario) + the contract recovery test.
- ✅ **P3.2 DID→document commitment** — `merkle` (pure) + `anchor::{tentative_root,
  confirmed_root}`: a **sha256 Merkle** root over the DID→head map so resolution = root +
  inclusion proof (portable for resolvers in any language; the adoption surface). RFC 6962
  domain separation (`leaf = sha256(0x00 ‖ did ‖ head_cid)`, `node = sha256(0x01 ‖ left ‖
  right)`), entries sorted by did, odd nodes promoted; confirmed vs tentative roots as
  `now`-parameterized views (roots recompute at read time so the recovery-window writes stay
  cheap). Format pinned by a TS cross-check (`gen-merkle-vectors`, raw `node:crypto` sha256)
  with a CI drift gate; differential-green (root/leaf/proof byte-identical) + contract tests.
- ⬜ **P3.4 Genesis import is single-op today** — `import_genesis` verifies one genesis op;
  importing a DID with existing history (`import(did, chain)`: replay genesis + each op) is
  the remaining piece. `submit_op` (append/recover) is done. Authorization is the embedded
  sig (P2.3), never the Starknet tx signer (`CLAUDE.md`). *Remaining.*

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

## 5. Exit criteria — ✅ met

- **Phase 2 complete:** P2.1–P2.5 differential-green vs `@did-plc/lib` (21/21 plc_core +
  9/9 drisl, accept **and** reject cases); `CLAUDE.md` build order item 2 → ✅ with the
  acceptance note. Drift gates added for the op-verify and recovery tables.
- **Phase 3 ready:** `plc_core::verify::verify_next_op(proposed, fork_point, nullified_count,
  first_nullified, created_at, now) → {signer_index, OpClass::{Append|Recovery}}` composes
  decode + linkage + signer-index + recovery for the non-genesis (`submit_op`) path. Phase 3
  supplies the chain context (head, nullified set from stored history) and maps `OpClass` +
  the 72h window onto the confirmed/tentative tiers (P3.3); genesis `import` verifies against
  the op's own rotation keys + DID derivation (a separate entry point to build in P3.4).

---

## 6. Session handoff (for the next session)

Phase 2 and most of Phase 3 landed, including the P3.2 commitment root. Test counts:
**plc_core 47/47, drisl 9/9, conformance 7/7**, all on the offline `scarb cairo-test` backend
(contracts test via `contract_state_for_testing`, no deploy). A SessionStart hook
(`.claude/hooks/`) installs the toolchain on the web — Scarb comes from its GitHub release
because the pinned installer host is egress-blocked.

### Done (modules in `cairo/packages/plc_core/src/`)
- **Phase 2:** `key_parse`, `sig_verify`, `op_decode`, `op_verify`, `link`, `recovery`,
  `verify` — full PLC op verification, differential vs `@did-plc/lib`.
- **Phase 3:** `state` (head/chain model + `apply_op` + tiers), `merkle` (sha256 Merkle
  commitment over the DID→head map — leaf/node/root/proof, format-pinned by
  `gen-merkle-vectors`), `anchor` (the `#[starknet::contract]` endpoint with
  import/submit/recovery + confirmed/tentative head **and root** views).

### Decisions made this session (don't relitigate)
- **p256 is malleable, k256 is low-S** (verified vs `@atproto/crypto`; `REFERENCE.md` §5
  corrected). `sig_verify` folds high-S→low-S for p256 only; guarded by a forced-high-S p256
  vector + a high-S-k256 reject vector.
- **Commitment accumulator = sha256 Merkle** (P3.2). Chosen for resolver portability (any
  language, no new crypto; matches the CID hash stack) over a Poseidon trie / storage proofs.
- **Contract storage** = per-DID `Vec<StoredOp>` (signed bytes + `created_at` + signer index);
  CID / rotation keys / tombstone all rederive from the bytes.
- **Timestamp** = block timestamp × 1000 (ms), used as the pragmatic `createdAt` the 72h
  window measures against (§1).

### Next, in order
1. ✅ **P3.2 — sha256 Merkle commitment root.** *Done.* Pure `merkle` module + `anchor`
   `tentative_root`/`confirmed_root` views over the DID→head map; format pinned and
   documented (`leaf = sha256(0x00 ‖ did ‖ head_cid)`, `node = sha256(0x01 ‖ left ‖ right)`,
   did-sorted, RFC 6962 odd-node promotion) with a TS cross-check (`gen-merkle-vectors`) and
   CI drift gate. Roots are read-time views (recomputed over the roster), so writes stay
   cheap — the write-vs-proof cost tradeoff was resolved toward cheap writes; an incremental
   on-chain tree is a later optimization to measure if root reads get hot.
2. **P3.4 — multi-op genesis `import`.** Today `import_genesis` is single-op; add
   `import(did, chain)` that replays genesis + each op (reusing `genesis_record` + `apply_op`)
   to anchor a DID with existing history in one call.
3. Then build order item 4 (sync indexer, `ingest/`) and item 5 (resolver library — the
   inclusion-proof verifier already lives in `merkle::verify_proof`, pinned here).

### Open question still pending (REFERENCE.md §6a)
Appchain timing — whether public Starknet's L1→L2 forced-inclusion is strong enough for CR.
Resolve before any settlement wiring; not blocking P3.2/P3.4.
