# @plc-anchor/witness — the read-side witness ("atproto identity DMARC")

The V1 product (`REFERENCE.md` §1a Mode 1): given a `did:plc`, a resolver or PDS checks the
directory's served document against the on-chain anchor and gets back a **graduated status**
it enforces unilaterally — `confirmed` / `tentative-consistent` / `diverged` / `absent`. No
network coordination, no protocol change; a single checker turns it on alone, the way an
email receiver enables DMARC.

> **Governing invariant — never a false `diverged`.** The anchor mitigates a *systemic*
> risk (single-operator trust in `plc.directory`). A false `diverged` converts that into an
> *immediate operational failure* on one resolver, whose rational response is to disable the
> check — removing the mitigation entirely. So every ambiguous edge (clock lag, window-edge
> recovery skew) resolves to a non-alarming status; `diverged` fires only on an unexplained
> contradiction of already-confirmed history. See `docs/PHASE-5-PLAN.md` §0.

## Status (build order item 5, in progress)

- **P5.2 (done):** `src/merkle.ts` — sha256-Merkle inclusion-proof **verification**, pinned
  byte-identical to the contract's tree (`cairo/packages/plc_core/src/merkle.cairo`) via the
  shared `gen-merkle-vectors` fixture. This is the trust primitive: recompute the root from a
  proof and compare it to a root fetched independently, so the proof server stays untrusted.
- **P5.3 (done):** the data path. `src/starknet.ts` — hand-encoded `starknet_call` reads of
  the anchor views (`tentative_root` / `confirmed_root` / `head_cid` / `tentative_proof` / …),
  mirroring `ingest`'s ByteArray ABI codec (no SDK); selectors precomputed from the `starknet`
  crate (`src/selectors.ts`, Node has no Keccak). `src/directory.ts` — the PLC audit-log client
  + head selection (the directory's `createdAt` clock, for P5.4's skew check).
- **P5.4 (done):** `src/status.ts` — the graduated-status `check(did)` ladder
  (`confirmed`/`tentative-consistent`/`diverged`/`absent`). `diverged` fires only when the
  anchor's confirmed head is absent from the directory's live chain AND the directory head is
  older than a conservative skew horizon (default 14d) — every recent/edge case is
  `skew-pending` (`tentative-consistent`), honoring the never-false-`diverged` invariant.
- **P5.5 (next):** the CLI demonstrator + a live read against the Sepolia deployment.

## Toolchain

TypeScript, run natively on Node ≥ 22 (type-stripping — no build step for tests). The pinned
core depends only on `node:crypto`.

```sh
npm test          # node --test  (the drift gate; no external deps needed)
npm run typecheck # tsc --noEmit  (needs `npm install` for @types/node)
```

The Merkle format is **pinned**: `make gen-merkle-vectors` regenerates both the Cairo test
fixture and `test/vectors/merkle-vectors.json` from one source; CI fails on drift. Do not edit
the generated fixture or the leaf/node format by hand — a divergence here is a fork.
