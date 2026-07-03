# plc-anchor

**DIDMARC — "atproto identity DMARC."** A cryptographically-verifiable **anchor** for the AT
Protocol DID PLC operation log, built on Starknet.

PLC per-DID operation chains are self-certifying (a DID is the hash of its genesis op; each op
is signed and hash-linked). That gives per-op authenticity — the DKIM analog. DIDMARC adds the
layer a single signature structurally can't: independent proof that `plc.directory` serves a
DID's **complete, current, non-equivocated** history. A **permissionless Starknet endpoint** holds
each DID's op log — `import` a DID's full history from genesis, `submit_op` to append — as a
**store-only, block-timestamped, non-equivocable log** (Starknet STARK-proves the blocks and
settles to Ethereum, so we run no bespoke prover and no sequencer). **Verify-on-read:** the witness
re-derives each DID's live/confirmed head from the on-chain bytes itself, so validity is a read-side
property (measured mainnet cost made in-contract verification prohibitive —
[docs/ONCHAIN-REARCH-PLAN.md](docs/ONCHAIN-REARCH-PLAN.md)).

The **V1 product is the read-side witness**: a resolver or PDS cross-checks `plc.directory`
against the anchored head and gets back a **graduated status** —
`confirmed` / `tentative-consistent` / `diverged` / `absent` — it enforces **unilaterally**, the
way an email receiver enables DMARC. `plc.directory` stays canonical; this is an anchor for the
DIDs that opt in, **not** a replacement for the directory.

## Quick start

```sh
make setup        # install/refresh toolchains (Scarb+snforge, Rust, npm)
make ci           # build + test everything (the full CI gate)
make help         # list all targets
```

Toolchain: Cairo/Scarb 2.18 · Starknet Foundry 0.61 · Rust 1.96 · Node ≥22
(pinned in [.tool-versions](.tool-versions) / [rust-toolchain.toml](rust-toolchain.toml)).

The Cairo tests ship with an **offline** test backend by default (Scarb's builtin
`cairo-test`, no registry access required); a networked dev box can switch to real `snforge`
with `make test-snforge`. See [cairo/TESTING.md](cairo/TESTING.md).

## Layout

| Path | What | Docs |
|---|---|---|
| `cairo/packages/drisl/` | DRISL/dCBOR42 + DASL CID (the keystone) | — |
| `cairo/packages/plc_core/` | the store-only `anchor` contract + the PLC verification/recovery/state modules (now the read-side **reference**) | — |
| `ingest/` | firehose sync indexer — submits deltas for anchored DIDs | [ingest/README.md](ingest/README.md) |
| `oracle/` | DRISL/CID differential oracle (`atproto-dasl`) | [oracle/README.md](oracle/README.md) |
| `conformance/` | vendored DASL vectors + the TS oracle sidecar (`@did-plc/lib`) | [conformance/README.md](conformance/README.md) |
| `witness-ts/` | **the V1 witness/resolver library** | [witness-ts/README.md](witness-ts/README.md) |
| `adversarial/` | attack/fork validation suite | [adversarial/README.md](adversarial/README.md) |

## Documentation map

- **[REFERENCE.md](REFERENCE.md)** — the design baseline (what & why): the threat model,
  operating modes, the approach, and the consensus-critical facts. The constitution.
- **[CLAUDE.md](CLAUDE.md)** — the operating manual (how): commands, layout, guardrails, and
  the settled decisions ("Do NOT relitigate").
- **[docs/ADVERSARIAL-REPORT.md](docs/ADVERSARIAL-REPORT.md)** — the adversarial validation
  narrative: every attack/fork scenario and how the witness responds. *(Generated — run
  `make adversarial`; don't hand-edit.)*
- **[docs/HISTORY.md](docs/HISTORY.md)** — build history & decision record: what landed per
  build-order item and the load-bearing decisions behind it.

## Status

**V1 (the witness) is feature-complete and shipped.** Build-order items 1–5 (`REFERENCE.md` §3)
have landed, each differential-green against the reference implementations, and the
[adversarial suite](docs/ADVERSARIAL-REPORT.md) validates the design against attack/fork cases.

The contract now runs **verify-on-read** (store-only op log; the witness re-derives validity
read-side — [docs/ONCHAIN-REARCH-PLAN.md](docs/ONCHAIN-REARCH-PLAN.md)), after mainnet fee
measurement showed the old in-contract EC verification was ~100% of import cost. The **v2
store-only `anchor` is deployed to Sepolia** (`0x06b16c52…`,
[deployments/sepolia.json](deployments/sepolia.json)) **and mainnet**; a measured Sepolia import
ran **≈ 2.33 STRK vs 27.6 STRK pre-rearch (~11.8×)**. Next major milestone (deferred): item 6 — the
Layer-2 admin/user console productionization ([docs/MAINNET-CHECKLIST.md](docs/MAINNET-CHECKLIST.md)
Phases 4–8) and governance.
