# @plc-anchor/witness — the read-side witness ("atproto identity DMARC")

The V1 product: given a `did:plc`, a resolver or PDS checks the directory's served document
against the on-chain anchor and gets back a **graduated status** it enforces unilaterally —
`confirmed` / `tentative-consistent` / `diverged` / `absent`. No network coordination, no
protocol change; a single checker turns it on alone, the way an email receiver enables DMARC.
(`REFERENCE.md` §1a, Mode 1.)

> **Governing invariant — never a false `diverged`.** The anchor mitigates a *systemic*
> risk (single-operator trust in `plc.directory`). A false `diverged` converts that into an
> *immediate operational failure* on one resolver, whose rational response is to disable the
> check — removing the mitigation entirely. So every ambiguous edge (clock lag, window-edge
> recovery skew) resolves to a non-alarming status; `diverged` fires only on an unexplained
> contradiction of already-confirmed history. See `REFERENCE.md` §4 and `docs/HISTORY.md`
> (item 5).

> **Verify-on-read** (`docs/ONCHAIN-REARCH-PLAN.md`). The anchor contract stores raw op bytes;
> the witness re-derives each DID's live/confirmed head from them here — exactly as it already
> re-derives the directory's — and rejects any bogus chain read-side. There is no on-chain Merkle
> proof to verify; the anchor's contribution is non-equivocation + an independent block-time stamp.

## What's here

- **`src/directory.ts`** — `deriveLiveChain`, the PLC chain validator (signatures + linkage + 72h
  recovery + the `imported`/settled guard), differential-green vs `@did-plc/lib`. Runs over BOTH
  the directory audit log and the anchor's on-chain op log. Plus the audit-log client + head
  selection (the directory's `createdAt` clock, for the skew check).
- **`src/starknet.ts`** — hand-encoded `starknet_call` read of the anchor's `chain(did)` view (raw
  ops + block-time stamps + provenance) via `decodeChain`, mirroring `ingest`'s ByteArray ABI codec
  (no SDK); selectors precomputed from the `starknet` crate (`src/selectors.ts`, Node has no Keccak).
- **`src/status.ts`** — `deriveAnchorHeads` (re-derive the anchor's confirmed/tentative head from
  its on-chain op log: op bodies cross-referenced content-addressed, block-time 72h window) + the
  graduated-status `check(did)` ladder (`confirmed`/`tentative-consistent`/`diverged`/`absent`).
  `diverged` fires only when the anchor's confirmed head is absent from the directory's live chain
  AND the directory head is older than a conservative skew horizon (default 14d) — every recent/edge
  case is `skew-pending` (`tentative-consistent`), honoring the never-false-`diverged` invariant.
- **`src/cli.ts`** — the `witness` CLI; `test/live.test.ts` — a gated live read against the
  Sepolia deployment (runs only with `WITNESS_LIVE_RPC` set).

## Usage

```sh
# Library:
import { check, AnchorReader, DirectoryClient } from "@plc-anchor/witness";
const anchor = AnchorReader.http(process.env.STARKNET_RPC, CONTRACT_ADDR);
const result = await check("did:plc:…", anchor, new DirectoryClient());
// → { status: "confirmed" | "tentative-consistent" | "diverged" | "absent", reason, evidence }

# CLI (exit 2 on `diverged`, else 0):
STARKNET_RPC=https://<sepolia-rpc> node src/cli.ts did:plc:… [--contract 0x…] [--directory URL]

# Live read against the deployment:
WITNESS_LIVE_RPC=https://<sepolia-rpc> node --test test/live.test.ts
```

Adoption is the DMARC ramp: start by logging the status, then quarantine on `diverged`, then
refuse to relay — each resolver decides unilaterally.

## Toolchain

TypeScript, run natively on Node ≥ 22 (type-stripping — no build step for tests). The pinned
core depends only on `node:crypto`.

```sh
npm test          # node --test  (the drift gate; no external deps needed)
npm run typecheck # tsc --noEmit  (needs `npm install` for @types/node)
```

The read-side re-derivation is **pinned** against `@did-plc/lib`: `make gen-nullified-vectors`
regenerates `test/vectors/nullified-vectors.json` (real signed chains, ground-truthed), and
`nullified.test.ts` drives both the directory and anchor derivations (`deriveLiveChain` /
`deriveAnchorHeads`, incl. read-side recovery-of-imported) against it. CI fails on drift. Do not
edit generated fixtures by hand — a divergence here is a fork.
