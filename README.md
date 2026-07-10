# plc-anchor

**DIDMARC — "atproto identity DMARC."** An independent, on-chain record of atproto (`did:plc`)
identity histories on Starknet, and a witness library that checks the PLC directory against it.

**[didmarc.dev](https://didmarc.dev)** (overview) · **[plc.didmarc.dev](https://plc.didmarc.dev)** (console)

## The problem

An atproto identity is a signed, hash-linked log of operations served from a single directory,
`plc.directory`. The signatures prove each operation is authentic, but they can't prove the
directory showed you *all* of them, the *latest* ones, or the *same* ones it showed everyone
else. A directory (or a mirror) can omit a key rotation, erase a DID, or serve different
histories to different viewers — without forging a single signature.

## What DIDMARC does

The fix mirrors DMARC's: PLC's signatures are the DKIM half (per-op authenticity), and DIDMARC
adds the alignment check. A **permissionless Starknet contract** stores each opted-in DID's full
operation log, block-timestamped and append-only (`import` a DID from genesis, `submit_op` to
append — anyone can pay to write, but authorization is always the op's own embedded signature).
The **witness** — the V1 product — cross-checks what the directory serves against that on-chain
record and returns a graduated status:

- `confirmed` — matches an on-chain head old enough (72h) to be immutable
- `tentative-consistent` — consistent so far, nothing immutable yet; never a false alarm
- `diverged` — the directory contradicts proven history: the alarm
- `absent` — the DID isn't anchored; no opinion

A resolver or PDS enforces the status **unilaterally** — no network coordination, no protocol
change — the way a single email receiver enables DMARC. `plc.directory` stays canonical; this
is a witness that holds it accountable, **not** a replacement.

**Verify-on-read:** the contract only stores bytes; all signature/CID verification runs in the
witness when it reads them back. Starknet's own proofs make the stored log non-equivocable and
settle it to Ethereum, so there is no bespoke prover and no sequencer. (In-contract verification
measured at ~100% of import cost on mainnet, which forced the move —
[docs/ONCHAIN-REARCH-PLAN.md](docs/ONCHAIN-REARCH-PLAN.md).)

## Check a DID

With Node ≥ 22 (no build step, no install for the core):

```sh
cd witness-ts
STARKNET_RPC=https://<starknet-rpc> node src/cli.ts did:plc:…   # [--contract 0x…] [--directory URL]
```

Prints the status with its evidence; exits `2` on `diverged`, `0` otherwise. `--contract`
defaults to the recorded Sepolia deployment ([deployments/](deployments/README.md)) — pass the
mainnet address to check a mainnet-anchored DID. Library API: [witness-ts/README.md](witness-ts/README.md).

## Build & test

```sh
make setup        # install/refresh toolchains (Scarb+snforge, Rust, npm)
make ci           # build + test everything (the full CI gate)
make help         # list all targets
```

Toolchain: Cairo/Scarb 2.18 · Starknet Foundry 0.61 · Rust 1.96 · Node ≥22
(pinned in [.tool-versions](.tool-versions) / [rust-toolchain.toml](rust-toolchain.toml)).

The Cairo tests default to an **offline** backend (Scarb's builtin `cairo-test`, no registry
access needed); switch to real `snforge` with `make test-snforge`. See
[cairo/TESTING.md](cairo/TESTING.md).

## Layout

| Path | What | Docs |
|---|---|---|
| `witness-ts/` | **the V1 witness/resolver library + CLI** | [witness-ts/README.md](witness-ts/README.md) |
| `cairo/packages/plc_core/` | the store-only `anchor` contract + the PLC verification/recovery modules (the reference the witness mirrors) | — |
| `cairo/packages/drisl/` | DRISL/dCBOR42 canonical CBOR + DASL CID (the encoding keystone) | — |
| `ingest/` | firehose sync indexer — feeds anchored DIDs' new ops on-chain | [ingest/README.md](ingest/README.md) |
| `console/` | admin console: roster policy + status dashboard | [console/README.md](console/README.md) |
| `adversarial/` | attack/fork validation suite | [adversarial/README.md](adversarial/README.md) |
| `conformance/` | vendored test vectors + the differential oracles | [conformance/README.md](conformance/README.md) |
| `oracle/` | Rust leg of the differential check | [oracle/README.md](oracle/README.md) |
| `site/` | the [didmarc.dev](https://didmarc.dev) landing page | — |
| `deployments/` | current contract address per network | [deployments/README.md](deployments/README.md) |

## Documentation map

- **[REFERENCE.md](REFERENCE.md)** — the design baseline (what & why): threat model, operating
  modes, and the consensus-critical facts.
- **[docs/ADVERSARIAL-REPORT.md](docs/ADVERSARIAL-REPORT.md)** — every attack/fork scenario and
  how the witness responds, run against real signed chains. *(Generated — run
  `make adversarial`; don't hand-edit.)*
- **[CLAUDE.md](CLAUDE.md)** — the contributor/agent operating manual: commands, guardrails,
  settled decisions.
- **[docs/HISTORY.md](docs/HISTORY.md)** — build history & decision record.

## Status

**V1 (the witness) is feature-complete and shipped**, and the store-only `anchor` contract is
**deployed to Starknet Sepolia and mainnet** ([deployments/](deployments/README.md)). Every
consensus-critical module is differential-tested against the reference implementations
(`@did-plc/lib`, `atproto-dasl`) in CI, and the [adversarial suite](docs/ADVERSARIAL-REPORT.md)
validates the design against attack and fork cases. In progress: productionizing the admin
console ([docs/MAINNET-CHECKLIST.md](docs/MAINNET-CHECKLIST.md)) and governance.
