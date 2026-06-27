# CLAUDE.md — operating manual for agents in this repo

This is the **how**. `REFERENCE.md` is the **what & why** — the design baseline. Treat it
as the constitution; link to it rather than re-deriving it.

**What this is:** a censorship-resistant, cryptographically-verifiable anchor for the AT
Protocol did:plc op log. PLC per-DID chains are self-certifying, so we verify them on-chain
per-DID via one **permissionless Starknet endpoint** (`import` a DID's history from
genesis; `submit_op` to append), commit a proven DID→document root, and let resolvers
cross-check the directory against it. Verification runs as a Starknet contract — the
network proves the blocks and settles to Ethereum; we run no bespoke prover and (initially)
no sequencer. Not a PLC replacement. (REFERENCE.md §1–2.)

## Commands (via the root `Makefile`)

| Command | Does |
|---|---|
| `make setup` | install/refresh toolchain deps |
| `make cairo-build` / `make cairo-test` | Scarb build / snforge tests (reports gas) |
| `make rust-test` | fmt-check + clippy(-D warnings) + cargo test |
| `make conformance` | three-way DRISL/CID agreement (the consensus gate) |
| `make ci` | everything CI runs |

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

- **The approach:** per-DID, lazy, on-chain verification via a permissionless endpoint; no
  bulk genesis replay; no in-protocol membership; public Starknet first (appchain deferred). (§2)
- **Crypto is a corelib library call** — `sha256`/`secp256k1`/`secp256r1` syscalls, because
  verification runs in a contract. No pure-Cairo crypto, no Garaga unless an exotic curve
  appears. (§8)
- **Blessed CID set only:** CIDv1, sha2-256 (0x12, 32B), dag-cbor (0x71) / raw (0x55),
  dCBOR42 canonical. Reject everything else. (§5)
- **Two-tier roots:** confirmed (past 72h, immutable) vs tentative tip. (§4)
- **Recovery:** lower-index rotation key nullifies within 72h. (§5)
- **Native AA:** the user's PLC rotation key is the Starknet signer; paymasters allocate
  commitment cost. (§2)
- **Membership = off-chain policy** over the permissionless endpoint (Layer 2). (§2, §6)
- **Frozen core scoped narrowly**, freeze on a maturity gate not a calendar. (§6)

## Guardrails

- Consensus-critical modules (`drisl`, `op_verify`, `recovery`) must be **differential-green**
  against the references (`atproto-dasl`, `@did-plc/lib`) before merge.
- **Never weaken or hand-edit a conformance vector to make a test pass.** Regenerate from
  source and bump the pin (`conformance/README.md`).
- Pin the differential authorities in lockfiles; bump deliberately.
- Measure contract cost with `snforge` gas output, on real entrypoints.

## Build order & status (REFERENCE.md §3)

1. ⏳ **DRISL + DASL CID in Cairo**, green against the conformance suite. *Long pole; next.*
2. PLC op verification + 72h recovery state machine (differential vs `@did-plc/lib`).
3. State commitment + confirmed/tentative roots + the permissionless `import`/`submit_op`
   endpoint (native-AA authorization).
4. Sync indexer (`ingest/`): firehose → submit deltas for anchored DIDs.
5. Resolver verification library (the adoption surface).
6. Deferred: Layer-2 admin/user tool (policy + cost allocation); governance; appchain.

**Current phase: bootstrap done → 1 (keystone).**
