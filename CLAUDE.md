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
- `witness-ts/` — the V1 witness/resolver library (TypeScript; build order item 5). Runs on
  Node ≥22 (type-stripping, no build step); `make witness-test`. The resolver-side
  `verifyProof` is pinned byte-identical to `merkle.cairo` via the shared `gen-merkle-vectors`
  JSON fixture.

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
3. ✅ **State commitment + confirmed/tentative roots + the permissionless `import`/`submit_op`
   endpoint** (embedded-sig authorization). Per-DID head + state (`plc_core::state`), the
   `anchor` `#[starknet::contract]` (`import_genesis`/`import`/`submit_op`/views), and
   confirmed/tentative tiers + the recovery/fork path (per-DID chain storage; 72h rule via
   `classify_next_op`) — offline-tested via `contract_state_for_testing`, recovery
   ground-truthed vs `@did-plc/lib`. **P3.2:** the sha256-Merkle DID→document commitment root
   (`plc_core::merkle` + `anchor::{tentative_root, confirmed_root}`) — RFC 6962 leaf/node
   domain separation, did-sorted, format-pinned by a TS cross-check (`gen-merkle-vectors`)
   with a CI drift gate. **P3.4:** `anchor::import(chain)` replays a DID's resolved history in
   one call (imported ops use the import block time — `createdAt` is not in the signed op).
   See [`docs/PHASE-2-3-PLAN.md`](docs/PHASE-2-3-PLAN.md) §2.
4. ✅ **Sync indexer (`ingest/`): firehose → submit deltas for anchored DIDs.** The off-chain
   feeder, built as a source-agnostic pipeline with trait seams (`OpSource`/`AnchorSink`) so the
   consensus-relevant logic stays offline-testable. **Keystone:** `ingest::reencode` rebuilds a
   directory-served operation's canonical DRISL signed bytes (PLC `prev` is a base32 **string**,
   not a tag-42 link — verified, no IPLD links in PLC ops) via `atproto-dasl`, **differential-green
   byte-for-byte against the 7-op conformance corpus** (genesis k256/p256/mixed/2-rotation,
   update, tombstone, legacy create). The pipeline filters to the anchored-DID roster (membership
   = off-chain policy, §2), skips directory-nullified ops, and enforces an **integrity gate** — a
   delta is submitted only if its re-encoded CID equals the directory's published CID — then
   routes genesis→`import_genesis` / append→`submit_op` and advances a resumable `after=<createdAt>`
   cursor. `HttpExportSource` (ureq) is the live `/export` path; `FixtureSource` drives the tests
   (ingest 14/14). **Live seam closed:** `StarknetSink` (`ingest/src/starknet_sink.rs`, `live`
   cargo feature) submits deltas to a deployed `anchor` via starknet-rs — `import_genesis`/`submit_op`
   with manually-encoded Cairo `ByteArray` calldata, waiting for tx acceptance. `DryRunSink` stays
   the offline default; the live path is feature-gated so the consensus tests pull no async/Starknet
   deps. Wired into the CLI two ways — `--roster` (firehose) and `--did <did:plc:...>` (single-DID
   onboarding via `/<did>/log/audit`, no firehose scan); both honor `--submit`. **Proven on-chain (Sepolia):** the live E2E
   (`ingest/tests/live_e2e.rs`, `--ignored`) drives a corpus genesis through the sink and reads back
   `head_cid` byte-identical to the corpus CID + a non-empty `tentative_root`; separately, a real
   4-op DID was anchored via `--did --submit` and its on-chain head matched the directory's
   published head (the resolver cross-check, live). Deployed address +
   RPC notes in [`snfoundry.toml`](snfoundry.toml); the gated manual E2E job is
   [`.github/workflows/e2e-sepolia.yml`](.github/workflows/e2e-sepolia.yml).
5. ✅ **Witness / resolver verification library (`witness-ts/`) — the V1 product**
   ("atproto identity DMARC"): given a DID, return the graduated status
   (`confirmed`/`tentative-consistent`/`diverged`/`absent`, §1a Mode 1) a resolver enforces
   unilaterally. A TypeScript package (Node ≥22, type-stripping — no build step; pinned core
   needs only `node:crypto`). **P5.1:** the `anchor` `tentative_proof`/`confirmed_proof` views
   (reuse `merkle_proof`); the contract isn't upgradeable so this is a fresh Sepolia deploy
   (`scripts/deploy-sepolia.sh`, `make deploy-sepolia`). **P5.2:** `src/merkle.ts` — the
   resolver-side `verifyProof`, **byte-identical to `merkle.cairo`**, pinned via the shared
   `gen-merkle-vectors` JSON fixture (one source, two consumers; CI drift-gated).
   **P5.3:** the data path — `src/starknet.ts` (hand-encoded `starknet_call` reads mirroring
   `ingest`'s ByteArray ABI; selectors precomputed from the `starknet` crate via
   `gen_selectors`, since Node has no Keccak) + `src/directory.ts` (audit-log head + the
   directory's `createdAt` clock). **P5.4:** `src/status.ts` — the §4 ladder under the
   **governing invariant: never a false `diverged`** (the window-edge skew case is
   indistinguishable from omission without the anchor's per-op time, so `diverged` fires only
   when a confirmed head is absent from the directory's live chain AND older than a
   conservative skew horizon; everything recent is `skew-pending`). **P5.5:** the `witness` CLI
   + a gated live read. Offline-tested (witness-ts 25/25 + 3 gated-live; tsc clean).
   Plan: [`docs/PHASE-5-PLAN.md`](docs/PHASE-5-PLAN.md); context: [`docs/PHASE-5-WITNESS-NOTES.md`](docs/PHASE-5-WITNESS-NOTES.md).
6. Deferred: Layer-2 admin/user tool (policy + cost allocation); governance; appchain.

**Current phase: build order item 5 (the V1 witness, `witness-ts/`) feature-complete and
offline-green (witness-ts 25/25; plc_core 55/55 with the new proof views; tsc clean). The
`anchor` contract carrying `tentative_proof`/`confirmed_proof` is deployed to Sepolia
(`0x00816c0b5bbf26d186b78f6ec0e1a8f8ae94ad58fc69595e7b0a334417e5c180`). The witness packages
root-fetch + `verifyProof` into the graduated status under the never-false-`diverged`
invariant. Remaining to call V1 "live": re-import DID(s) onto the fresh roster
(`ingest --did … --submit`), point the `ANCHOR_CONTRACT_ADDRESS` secret at the new address, and
run the gated live read (`WITNESS_LIVE_RPC=… node --test witness-ts/test/live.test.ts`). Open
follow-ups (deliberately deferred, `docs/PHASE-5-PLAN.md` §1): the off-chain prover service
(roster-scale) and the precise skew bound (the horizon is V1's conservative stand-in). See
`docs/PHASE-5-PLAN.md`.**
