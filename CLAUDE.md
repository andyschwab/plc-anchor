# CLAUDE.md — operating manual for agents in this repo

This is the **how**. `REFERENCE.md` is the **what & why** — the design baseline. Treat it
as the constitution; link to it rather than re-deriving it.

**What this is:** **DIDMARC — "atproto identity DMARC."** A cryptographically-verifiable
anchor for the did:plc op log on Starknet. PLC ops already self-certify per-op (the DKIM
analog); we add the layer PLC lacks — independent on-chain proof that plc.directory serves a
DID's **complete, current, non-equivocated** history, exposed as a graduated status
(`confirmed`/`tentative-consistent`/`diverged`/`absent`) any resolver or PDS enforces
**unilaterally**, no network coordination required. plc.directory stays canonical; we verify
per-DID via one **permissionless Starknet endpoint** (`import` from genesis; `submit_op` to
append — the latter a **backstop**, not the V1 headline), commit a proven DID→document root,
and let checkers cross-check the directory against it. Verification runs as a Starknet
contract — the network proves the blocks and settles to Ethereum; no bespoke prover,
(initially) no sequencer. **V1 is the witness only**; availability and
canonical-source-in-a-partition are later modes (REFERENCE.md §1a). Not a PLC replacement.
(REFERENCE.md §1–2.)

## Commands (via the root `Makefile`)

| Command | Does |
|---|---|
| `make setup` | install/refresh toolchain deps |
| `make cairo-build` / `make cairo-test` | Scarb build / Cairo tests (reports gas; runner per active backend) |
| `make rust-test` | fmt-check + clippy(-D warnings) + cargo test |
| `make conformance` | three-way DRISL/CID agreement (the consensus gate) |
| `make ci` | everything CI runs |
| `make test-backend` / `make test-{offline,snforge}` | show / switch the Cairo test backend ([cairo/TESTING.md](cairo/TESTING.md)) |

**Cairo test backend:** committed default is **offline** (Scarb builtin `cairo-test`, no
registry); switch to real `snforge` on a networked box with `make test-snforge`. `snforge_std`
pulls a proc-macro cdylib that the static-musl Scarb in the sandbox can't `dlopen`, so it can't
run there — the offline builtin gives `#[test]` with no proc macro. Tests are backend-agnostic
(only `#[test]`/`assert!`); revisit when one first needs a real snforge feature. (cairo/TESTING.md.)

## Layout

- `cairo/` — Scarb **workspace**: `packages/drisl` (keystone: DRISL/dCBOR42 + DASL CID) and
  `packages/plc_core` (contracts: op_verify, recovery, state, the anchor endpoint,
  governance).
- `Cargo.toml` + `ingest/` `oracle/` — one Rust **workspace** (shared lockfile pins
  `atproto-dasl`). `ingest` = the firehose sync indexer; `oracle` = the DRISL/CID
  differential authority.
- `conformance/` — vendored DASL vectors + the TS oracle sidecar (`@did-plc/lib`) +
  provenance.

## Toolchain (pinned in `.tool-versions` / `rust-toolchain.toml`)

Scarb/Cairo **2.18.0**, Starknet Foundry (snforge) **0.61.0**, universal-sierra-compiler
**2.9.0**, Rust **1.96.0**. Install via `starkup` (Scarb + snforge, asdf-managed) and
`rustup`.

## Do NOT relitigate (settled — see the cited REFERENCE.md sections)

- **V1 is the witness ("atproto identity DMARC"), not the escape hatch.** plc.directory
  stays canonical; the product is the read-side graduated status
  (`confirmed`/`tentative-consistent`/`diverged`/`absent`) a resolver/PDS enforces
  unilaterally. The permissionless write path is a backstop. Availability (Mode 2) and
  canonical-source-in-a-partition (Mode 3) are explicitly later, not V1. (§1a)
- **The approach:** per-DID, lazy, on-chain verification via a permissionless endpoint; no
  bulk genesis replay; no in-protocol membership; public Starknet first. (§2)
- **Appchain timing is an open question** — depends on whether public Starknet's L1→L2
  forced-inclusion guarantee is strong enough for CR. Resolve before §3 settlement wiring.
  Do not treat "appchain deferred" as settled. (§6a)
- **Crypto is a corelib library call** — `sha256`/`secp256k1`/`secp256r1` syscalls, because
  verification runs in a contract. No pure-Cairo crypto, no Garaga unless an exotic curve
  appears. (§8)
- **Blessed CID set only:** CIDv1, sha2-256 (0x12, 32B), dag-cbor (0x71) / raw (0x55),
  dCBOR42 canonical. Reject everything else. (§5)
- **Map key ordering:** implement CBOR-encoded-bytewise ordering (RFC 8949 §4.2.1), not a
  content-length sort. They coincide for PLC today (all keys < 24 bytes) but the
  encoded-bytewise rule is what must be in code — a content-length sort forks at ≥24B. (§5)
- **Signed vs unsigned — do not conflate:** DID/CID derivation hashes the *signed* op (sig
  field included); signature verification is over the *unsigned* op (sig removed, then
  DRISL-encoded). Two distinct byte strings; conflating them fails every check. (§5)
- **Two-tier roots:** confirmed (past 72h, immutable) vs tentative tip. (§4)
- **Recovery:** lower-index rotation key nullifies within 72h. (§5)
- **Authorization = the op's embedded signature, verified in-contract.** The Starknet
  transaction signer / fee payer is irrelevant and may be anyone — that is the
  permissionless property. Native AA + paymasters are for gas/UX only, never authorization.
  Do not require the PLC key to be the Starknet account signer. (§2)
- **Membership = off-chain policy** over the permissionless endpoint (Layer 2). (§2, §6b)
- **Frozen core scoped narrowly**, freeze on a maturity gate not a calendar. (§6b)

## Guardrails

- Consensus-critical modules (`drisl`, `op_verify`, `recovery`) must be **differential-green**
  against the references (`atproto-dasl`, `@did-plc/lib`) before merge.
- **Never weaken or hand-edit a conformance vector to make a test pass.** Regenerate from
  source and bump the pin (`conformance/README.md`).
- Pin the differential authorities in lockfiles; bump deliberately.
- Measure contract cost with `snforge` gas output, on real entrypoints.

## Build order & status (REFERENCE.md §3)

1. ✅ **DRISL + DASL CID in Cairo**, green against the DASL conformance suite
   (`cairo/packages/drisl`). ✅ **Acceptance gate closed:** byte-identical CIDs/DIDs on
   6 real-structure PLC ops (secp256k1/p256 genesis, update, tombstone) round-tripped
   against `@did-plc/lib` / `@ipld/dag-cbor` — 6/6 vectors pass in both TS oracle and
   Cairo. (REFERENCE.md §3, §5)
2. ✅ **PLC op verification + 72h recovery state machine** (differential vs `@did-plc/lib`).
   **Acceptance gate closed:** `did:key` parse, k256/r1 ECDSA over the unsigned op
   (k256 low-S; **p256 malleable**, matching the reference — §5 corrected), DRISL→typed-op
   decode + §5 constraints, legacy `create` normalization, authorized-signer-index
   derivation, `prev` linkage (base32 CID string), and the 72h recovery decision — all green
   against a 7-op corpus + recovery scenarios ground-truthed by `@did-plc/lib`, tied together
   by `plc_core::verify::verify_next_op`. 21/21 plc_core + 9/9 drisl tests pass.
   (`cairo/packages/plc_core`; sequencing in [`docs/PHASE-2-3-PLAN.md`](docs/PHASE-2-3-PLAN.md).)
3. ⏳ **State commitment + confirmed/tentative roots + the permissionless `import`/`submit_op`
   endpoint** (embedded-sig authorization). *In progress.* Done: per-DID head + state
   (`plc_core::state`), the `anchor` `#[starknet::contract]` (`import_genesis`/`submit_op`/
   views), and confirmed/tentative tiers + the recovery/fork path (per-DID chain storage;
   72h rule via `classify_next_op`) — offline-tested via `contract_state_for_testing`,
   recovery ground-truthed vs `@did-plc/lib`. Remaining: the sha256-Merkle DID→document
   commitment root (P3.2) and multi-op genesis `import` (P3.4). See
   [`docs/PHASE-2-3-PLAN.md`](docs/PHASE-2-3-PLAN.md) §2.
4. Sync indexer (`ingest/`): firehose → submit deltas for anchored DIDs.
5. Witness / resolver verification library — **the V1 product** ("atproto identity DMARC"):
   DID → document + inclusion proof against the published root, as the graduated status
   (§1a Mode 1). Built last (stands on 1–4) but the headline deliverable.
6. Deferred: Layer-2 admin/user tool (policy + cost allocation); governance; appchain.

**Current phase: 3 in progress — the permissionless endpoint (append + recovery + tiers) is
live and offline-tested; remaining: the sha256-Merkle commitment root (P3.2) and multi-op
genesis import (P3.4). See `docs/PHASE-2-3-PLAN.md` §2.**
