# plc-anchor

A censorship-resistant, cryptographically-verifiable **anchor** for the AT Protocol DID
PLC operation log, built on Starknet.

PLC per-DID operation chains are self-certifying (a DID is the hash of its genesis op; each
op is signed and hash-linked). So we verify them on-chain, per-DID, via one **permissionless
endpoint** — `import` a DID's full history from genesis, `submit_op` to append new signed
ops — and publish a proven commitment to the current DID→document mapping. Verification runs
as a Starknet contract: the network STARK-proves the blocks and settles to Ethereum, so we
run no bespoke prover and no sequencer. Resolvers cross-check `plc.directory` against the
proven root. It is an anchor for the DIDs that opt in, **not** a replacement for the
directory.

See **[REFERENCE.md](REFERENCE.md)** for the design (what & why) and **[CLAUDE.md](CLAUDE.md)**
for how to build and contribute.

## Quick start

```sh
make setup        # install/refresh toolchains (Scarb+snforge, Rust)
make ci           # build + test everything
```

Toolchain: Cairo/Scarb 2.18 · Starknet Foundry 0.61 · Rust 1.96
(pinned in [.tool-versions](.tool-versions) / [rust-toolchain.toml](rust-toolchain.toml)).

The Cairo tests ship with an **offline** test backend by default (Scarb's builtin
`cairo-test`, no registry access required); a networked dev box can switch to real
`snforge` with `make test-snforge`. See [cairo/TESTING.md](cairo/TESTING.md).

## Layout

```
cairo/         Scarb workspace: drisl (keystone) + plc_core (verification + anchor endpoint)
ingest/        Rust: firehose sync indexer (submits deltas for anchored DIDs)
oracle/        Rust: DRISL/CID differential oracle (atproto-dasl)
conformance/   vendored DASL vectors + TS oracle sidecar (@did-plc/lib)
```

## Status

Bootstrap complete: repo scaffolded, toolchains pinned and verified, DASL conformance
vectors vendored, all tests green. Next: the DRISL/DASL-CID keystone (REFERENCE.md §3).
