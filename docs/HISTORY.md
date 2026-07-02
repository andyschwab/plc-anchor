# Build history & decision record

A compressed log of what landed per build-order item, and the load-bearing decisions made
along the way. The **what & why** lives in [`REFERENCE.md`](../REFERENCE.md) (the constitution)
and the settled rules in [`CLAUDE.md`](../CLAUDE.md) "Do NOT relitigate"; this file is the
**when & how it got built**, so finished planning docs don't accumulate in `docs/`.

Build order is dependency order, not priority order — the V1 *product* is the witness (item 5),
but it stands on 1–4 (`REFERENCE.md` §3).

---

## Item 1 — DRISL + DASL CID in Cairo (the keystone)

`cairo/packages/drisl` (`drisl.cairo` codec, `cid.cairo` derivation). Canonical dCBOR42
encoding + DASL CID derivation (sha-256 over DRISL bytes), green against the vendored DASL
conformance suite. Acceptance gate: byte-identical CIDs/DIDs on 6 real-structure PLC ops
(secp256k1/p256 genesis, update, tombstone) round-tripped against `@did-plc/lib` /
`@ipld/dag-cbor`, in both the TS oracle and Cairo. (`REFERENCE.md` §3, §5.)

## Item 2 — PLC op verification + 72h recovery state machine

`cairo/packages/plc_core`: `key_parse`, `sig_verify`, `op_decode`, `op_verify`, `link`,
`recovery`, tied together by `verify::verify_next_op`. `did:key` parse, k256/p256 ECDSA over
the *unsigned* op, DRISL→typed-op decode + §5 constraints, legacy `create` normalization,
authorized-signer-index derivation, `prev` linkage (base32 CID string), and the 72h recovery
decision — all differential-green against `@did-plc/lib`.

**Key decisions**
- **S-malleability is curve-asymmetric** (verified vs `@atproto/crypto`): k256 requires
  **low-S**; p256 is **malleable** (high-S accepted). An earlier "low-S for both" draft was
  wrong for p256 and would have forked. `sig_verify` folds high-S→low-S for p256 only; guarded
  by a forced-high-S p256 vector + a high-S-k256 reject vector. (`REFERENCE.md` §5.)
- **Recovery stays in item 2** — pure verification logic, differential-testable in isolation,
  independent of on-chain commitment. Item 3 consumes its output (confirmed vs nullifiable).
- **`op_decode` reuses the keystone `drisl::decode`** (one canonical CBOR layer) rather than a
  second hand-rolled reader.

## Item 3 — State commitment + the permissionless anchor endpoint

`plc_core`: `state` (per-DID head/chain + `apply_op` + confirmed/tentative tiers), `merkle`
(the DID→head commitment), `anchor` (the `#[starknet::contract]`: `import_genesis` / `import` /
`submit_op` + the head/root/proof views). Recovery/fork path ground-truthed end-to-end vs
`@did-plc/lib`; offline-tested via `contract_state_for_testing`.

**Key decisions**
- **Authorization = the op's embedded signature, verified in-contract** — never the Starknet
  tx signer / fee payer (the permissionless property). `import` replays a resolved linear
  history in one call; forking successors rejected (`import-fork`). (`REFERENCE.md` §2.)
- **Commitment accumulator = sha256 Merkle** (not a Poseidon trie / storage proofs), chosen
  for resolver portability — any language, no new crypto, matches the CID hash stack. RFC 6962
  domain separation (`leaf = sha256(0x00 ‖ did ‖ head_cid)`, `node = sha256(0x01 ‖ left ‖
  right)`), did-sorted, odd-node promotion. Format pinned by the `gen-merkle-vectors` TS
  cross-check with a CI drift gate. (`REFERENCE.md` §3, §5a.)
- **Roots are read-time views** (`now`-parameterized), recomputed over the roster — writes stay
  cheap; an incremental on-chain tree is a later optimization if root reads get hot.
- **Storage = per-DID `Vec<StoredOp>`** (signed bytes + `created_at` + signer index + provenance);
  CID / rotation keys / tombstone all rederive from the bytes.
- **`createdAt` is not in the signed op** (directory-assigned metadata, absent from the op bytes
  and CID — confirmed against the corpus). The contract uses **Starknet block time** as the
  pragmatic `createdAt` the 72h window measures against; imported ops use the import block time.
  A freshly imported chain is therefore tentative until observed for 72h. **Correction (see the
  4a fix below):** an earlier note here claimed this was "sound" because it "only re-exposes the
  recovery window." That was wrong. Re-exposing the recovery window on *backfilled* history is
  precisely the hazard: an op authored years ago but stamped at import time looks fresh, so a
  *rotated-out* higher-priority rotation key — no longer the DID's controller — could fork below
  it within 72h of import and capture the DID. Fixed by marking imported ops **settled** (a
  recovery may not nullify them); see the 4a entry below. (`REFERENCE.md` §1, §4, §5.)

## Item 4 — Sync indexer (`ingest/`)

The off-chain feeder (`ingest/README.md`): consumes a PLC mirror's `/export`, filters to the
anchored-DID roster (membership = off-chain policy), and submits deltas to the anchor. Built
source-agnostic via trait seams (`OpSource` / `AnchorSink`) so the consensus-relevant logic
stays offline-testable.

**Key decisions**
- **Keystone = `ingest::reencode`** rebuilds a directory-served op's canonical DRISL signed
  bytes via `atproto-dasl`, differential-green byte-for-byte against the 7-op corpus. Confirmed
  PLC `prev` is a base32 **string**, not a tag-42 link — no IPLD links in PLC ops.
- **Integrity gate:** a delta is submitted only if its re-encoded CID equals the directory's
  published CID. The feeder can't be tricked into anchoring forged content by the source it reads.
- **Live submission is feature-gated** (`live` cargo feature → `StarknetSink`): the default
  build and the offline consensus tests pull no async / Starknet deps. `DryRunSink` is the
  offline default. Two CLI modes: `--roster` (firehose) and `--did` (single-DID onboarding).
- **Proven on-chain (Sepolia):** the live E2E read back a corpus genesis head byte-identical to
  the corpus CID; a real 4-op DID anchored via `--did --submit` matched the directory's
  published head (the resolver cross-check, live).

## Item 5 — Witness / resolver library (`witness-ts/`) — the V1 product

"atproto identity DMARC" (`REFERENCE.md` §1a Mode 1, `witness-ts/README.md`): given a DID,
return the graduated status (`confirmed` / `tentative-consistent` / `diverged` / `absent`) a
resolver enforces unilaterally. TypeScript, Node ≥22 (type-stripping, no build step); the
pinned core needs only `node:crypto`.

- `anchor`'s `tentative_proof` / `confirmed_proof` views (reuse `merkle_proof`); the contract
  isn't upgradeable, so this shipped as a fresh Sepolia deploy
  (`0x00816c0b5bbf26d186b78f6ec0e1a8f8ae94ad58fc69595e7b0a334417e5c180` — **superseded by the
  post-4a redeploy `0x01e3cd…`; see the 4a fix below**).
- `src/merkle.ts` — the resolver-side `verifyProof`, **byte-identical to `merkle.cairo`**,
  pinned via the shared `gen-merkle-vectors` fixture (one source, two consumers; CI drift-gated).
- `src/starknet.ts` (hand-encoded `starknet_call` reads; selectors precomputed via
  `gen_selectors`, since Node has no Keccak) + `src/directory.ts` (audit-log head + the
  directory's `createdAt` clock) + `src/status.ts` (the §4 ladder) + `src/cli.ts`.

**Key decisions**
- **Governing invariant: never a false `diverged`.** The anchor mitigates a *systemic* risk
  (single-operator trust in `plc.directory`); a false alarm converts that into an *immediate
  operational failure* on one resolver, whose rational response is to disable the check —
  self-defeating. So every ambiguous edge (clock lag, window-edge recovery skew) resolves to a
  non-alarming status. The asymmetry is total: a false negative degrades to the status quo
  (tolerable); a false positive removes the mitigation (intolerable). (`REFERENCE.md` §4.)
- **Clock reconciliation belongs in the read-side library, not the contract.** The contract
  sees only block time and stays conservative; the library reads *both* clocks (the directory
  audit log exposes `createdAt`; the chain exposes the anchor's observation time) to decide
  whether an edge disagreement is explained by skew. `diverged` fires only when a confirmed
  head is absent from the directory's live chain **and** older than a conservative skew horizon
  (default 14d); everything recent is `skew-pending`.
- **Conservative skew now, precise bound later.** The window-edge skew rule is the hardest part;
  front-loading the exact bound buys an adopter nothing while risking the one fatal failure mode.
  V1 uses the plausible-skew collapse; the precise bound is a documented follow-up.

## Validation — the adversarial suite (`adversarial/`)

Before item 6, the [`adversarial/`](../adversarial/README.md) suite validates the design against
attack/fork cases, rendered as the engineer-facing
[`docs/ADVERSARIAL-REPORT.md`](ADVERSARIAL-REPORT.md). 13 scenarios (8 read-side, one per
status-ladder branch; 5 write-side rejections ground-truthed vs `@did-plc/lib` — including
`recovery-of-imported`, the 4a capture) on real signed
did:plc chains, plus an HTTP malicious-mirror exercising the real `DirectoryClient` fetch path
offline and a gated live read vs Sepolia (`make adversarial-live`). **No new consensus logic** —
it composes the already-differential-green modules into named attacks. This is the keep-it-high-
priority artifact: it is the concrete demonstration that the witness alarms when it should and
stays silent when disagreement is benign.

## Item 6 — Layer-2 admin console (`console/`, `site/`) — MVP

The off-chain admin tool (`REFERENCE.md` §6, `console/README.md`): define **which** did:plc's we
anchor (membership = off-chain policy, §2 — the contract has no roster getter, so this owns it),
watch their §4 graduated status, and surface the **`diverged` alarm**. **Glue, not consensus** —
it composes the shipped pieces and re-implements none of them (the CLAUDE.md guardrail): status
via `@plc-anchor/witness` `check()`, writes via `ingest --did/--roster --submit`. TypeScript,
Node ≥22, `node:sqlite` (zero deps); `make console-test`.

**Key decisions**
- **The approve gate is the cost guardrail, enforced in code.** A roster DID moves
  `candidate → approved → onboarding → anchored{…} → removed`, validated against
  `ALLOWED_TRANSITIONS`. A dynamic filter only ever *proposes* a `candidate`; a human must
  approve before the onboarder writes on-chain — so a broad filter can never auto-anchor the
  network. **Onboarding never runs on a timer** (it spends on-chain); it is operator-triggered
  only (`POST /worker/onboard`). The read-only loops (discover, status refresh) are timer-driven.
- **The only net-new logic is the PDS-host parser** (`src/pdshost.ts`) — nothing in the repo
  parsed service endpoints before. It only *selects* DIDs (the `pds_host` filter) and carries no
  consensus weight; `ingest`'s integrity invariant still guards anything actually anchored.
- **Worker pieces are built over injectable seams** (`StatusChecker`, `CommandRunner`,
  `ExportClient` fetcher) so the lifecycle is offline-testable with no live ingest / Starknet /
  network; the one `@plc-anchor/witness` binding is isolated in `witness.ts`.
- **Deploy:** two Fly apps — `site/` (static `didmarc.dev` landing) and `console/`
  (`plc.didmarc.dev`, SQLite on a volume, secrets via `fly secrets`). The `plc.` subdomain
  reserves the method namespace (the §5a generality seam). Console image is Node-only for the
  first deploy; baking the Rust `ingest` binary in (for on-chain onboarding) is a documented
  multi-stage follow-up. **Appchain dropped** from the tracked open-questions — V1 is public
  Starknet (§2); an appchain is a far-future option only if neutrality ever demands owning the
  sequencer, not a live question.
- **Remaining for item 6:** the live Fly bring-up + a fresh **mainnet** contract deploy (migration
  = re-import from genesis, the already-proven path) + cost-allocation (paymaster/AA — MVP runs
  one project-funded account) + governance (`REFERENCE.md` §6/§7).

**Eurosky-MVP upgrade (criterion-driven, 20k-scale).** The hand-curated roster + per-DID approve
gate was re-shaped for the first real customer: **one fixed deploy-time criterion** — accounts on
the `eurosky.social` PDS (`ROSTER_CRITERION=pds_domain:<base>`, a **domain-suffix** match, not the
old exact-host filter) — made operable and cost-safe at ~20k. Load-bearing decisions:
- **The approve gate scaled by config, not clicks.** 20k manual approvals is untenable, so
  discovery **auto-approves** matches and the spend guardrail moved to an **Active/Inactive toggle
  + a per-tick import budget** on the onboarder (persisted, default Inactive at boot). The state
  machine and `ALLOWED_TRANSITIONS` are unchanged; onboarding is a no-op unless Active. The gate's
  *purpose* (a broad match can never auto-spend) is preserved — it's just enforced by the toggle.
- **Discovery = enumerate then tail.** `plc.directory` has no "list DIDs on PDS X" API, so the
  backlog comes from the PDS itself (`com.atproto.sync.listRepos`, `src/pds.ts`) and ongoing
  changes from a `/export` tail seeded at ~now (not genesis) filtered by the criterion. Per-PDS
  enumerate cursors + the tail cursor persist, so restarts resume mid-backlog.
- **Enrichment is display-only and non-consensus.** Handle / PDS host / key-count / last-op /
  tombstoned come from the directory audit log (cheap, cached via `enrichedAt`, throttled); the
  authoritative §4 status still comes from the witness `check()`. `listRepos`/enrichment self-
  reports never ride into anchored bytes — `ingest`'s integrity invariant re-verifies every import.
- **Cost is measured, not guessed.** `ingest` emits a machine-readable `ANCHORED <did> tx=<hash>`
  line; the console captures the tip tx and resolves `actual_fee` via `starknet_getTransactionReceipt`
  (`src/fees.ts`), rolling cumulative + average fee into `/roster/aggregates` so a small budgeted
  batch extrapolates before scaling.
- **Table went server-side.** `GET /roster` is paginated/filtered/sorted over indexed columns
  (`{rows,total}`); the UI is a debounced grid (queries stay in the low-ms at 20k). The `pds_host`
  filter CRUD was dropped (criterion is config).
- **Observability** (Fly logs are thin): each worker run (timer or manual) persists a last-run
  record — running/lastRunAt/durationMs/ok/summary/**error** — surfaced in `/roster/aggregates`
  and a UI Workers panel, so a failing loop (e.g. a refresh RPC error) is visible without SSH. The
  dashboard also shows enrichment progress and an **off-criterion** count: enrichment re-checks the
  DID's authoritative PDS host against the criterion and **flags** (never removes) migration
  stragglers — enumeration is criterion-blind (trusts `listRepos`), so this closes the loop as a
  visible count + a one-click grid filter, leaving disposition a manual decision.
- **Non-secret config is live-editable** (`src/settings.ts`, `GET/PUT /settings`, the ⚙ panel).
  A store-backed facade composes over the existing `active`/`budget` accessors; workers re-read
  config each tick and cadence changes reschedule live (self-scheduling timer), so the criterion,
  PDS endpoints, budget, intervals, enrich knobs, and directory/mirror URLs change with no
  redeploy. Precedence: hardcoded ← `SETTINGS_DEFAULTS_FILE` ← env ← persisted UI edits. Secrets +
  boot-only knobs (RPC, keys, contract address, port, DB path, ingest command, admin token) stay in
  env and are surfaced **read-only** (presence only). Env is now a *seed*, not the runtime source.

---

## Security fix 4a — imported history is settled (recovery-window capture)

The import path stamped every backfilled op with the import block time and measured the 72h
recovery window against it, so for 72h after onboarding the *entire* history looked freshly
authored. Because a PLC recovery is authorized by any *strictly-higher-priority* rotation key,
a key that was higher-priority at a historical fork point but had since been **rotated away**
(the canonical custodial→self-hosted migration leaves exactly such a key) could fork below the
real history within that window and nullify it — capturing the DID on-chain. The anchor would
then harden the forged head to `confirmed` and read `diverged` against an *honest* directory:
the anchor manufacturing the one alarm the §0 invariant exists to prevent. (This inverts the
earlier "re-exposing the recovery window is sound" claim in item 3, now corrected.)

**Fix — provenance, in two layers:**
- **Contract (`state`/`anchor`).** Each op carries an `imported` flag: `true` via
  `import`/`import_genesis` (settled backfill), `false` via `submit_op` (observed live).
  `apply_op` refuses a recovery that would nullify an imported op (`recovery-of-imported`).
  The 72h window is thus honored only for live-observed ops, whose block-time stamp
  approximates their real authored time. The guard is a *strictly conservative* refinement of
  `classify_next_op` (it only ever rejects) layered in `state`, so it leaves the
  differential-green PLC validation (`recovery`/`op_verify`) untouched — no vector regeneration.
  Regression test: `recovery_cannot_nullify_imported_history` (import `[genesis, opA]`, then the
  index-0 key's fork at genesis is rejected), contrasted with `recovery_through_contract` where
  the *live*-submitted opA is still recoverable.
- **Ingest (`onboard_via_import`).** Onboarding now imports a DID's whole resolved history as one
  settled `import` chain, instead of `import_genesis` + op-by-op `submit_op` (which would
  live-stamp historical successors and defeat the contract guard). `submit_op` is reserved for
  genuinely-new ops observed ~live while tailing.

**Residual (documented, tolerable direction).** A DID onboarded while its real tail op is still
inside its 72h window imports that tail as settled, so a *legitimate* recovery of it (at the
directory) can't be mirrored on-chain → a benign, operator-recoverable `diverged` on that one
DID (re-import to resolve). This is the §0-safe direction: it degrades to the status quo, never
to capture. The alternative (live-stamping the tail to keep it recoverable) re-opens a bounded
capture window — the unsafe direction — so it was rejected. The firehose/roster path is for
*tailing* already-onboarded DIDs from a recent cursor; using it to backfill ancient history
would live-stamp it and is a documented operational foot-gun, not the sanctioned onboarding path.

**Status:** landed and green — Cairo (`make cairo-test`: 54 `plc_core` tests incl.
`recovery_cannot_nullify_imported_history`, with `recovery_through_contract` still passing),
Rust (`cargo test -p ingest`, clippy `-D warnings`), and the adversarial scenario
`recovery-of-imported`. **Redeployed:** the `StoredOp` layout changed (gains `imported`), so the
pre-4a Sepolia instance (`0x00816c…`) was superseded by a fresh post-4a deploy
(`0x01e3cd42e8481a40b366ef32940e8bc050fd79c924c9b838a6dc0338a08fc5c3`, `deployments/sepolia.json`).
The roster starts empty; re-import DIDs from genesis (the already-proven path).

---

## Open follow-ups (deliberately deferred)

- **Off-chain prover service** (roster-scale memoization of the inclusion proofs the contract
  serves at read time; identical format). Mode-2-adjacent infra.
- **Precise skew bound** + its re-evaluation trigger — V1 ships the conservative collapse; this
  is the documented successor (resolvers depend on the exact rule, so it's pinned when settled).
- **Item 6 remainder** — live Fly bring-up + a fresh **mainnet** contract deploy, cost allocation
  (paymaster/AA; MVP = one funded account), and governance (`REFERENCE.md` §6/§7). The console
  MVP itself has landed (above).
- **Generalization seam** (`REFERENCE.md` §5a) — the `merkle` leaf is separator-less, sound only
  because did:plc is fixed-width; add a length prefix *before* admitting variable-width subjects.
- **Batched settled import for long chains** — `import` re-verifies every op's signature in one
  transaction, so a long history (roughly ≥5–6 ops) can exceed the sequencer's per-tx L2 gas cap
  (~1.21e9 on Sepolia; the ingest sink clamps the request under it and errors clearly past it).
  Most did:plc chains are short and import fine. A robust fix for the long tail is an
  `import_append(did, signed)` entrypoint that appends a **settled** op (same provenance as
  `import`, so the 4a guard holds) across several transactions — a contract change, hence a
  redeploy. Deferred until a real chain hits the ceiling.
- **Trustless root reads (SECURITY-TODO 4c)** — the witness reads the anchor root via
  `starknet_call`, which trusts the RPC; a fully trustless read verifies a **Starknet storage
  proof against the L1-settled state root** (read the Starknet core contract on Ethereum +
  Merkle-Patricia storage proof). Mode-2-adjacent infra; interim guidance is run-your-own-node /
  trust-your-RPC. (4b — the read-side recovery window's use of directory `createdAt` — is faithful
  PLC reproduction and is documented, not a follow-up.)

## Live-bring-up checklist (V1)

The post-4a anchor is deployed (`0x01e3cd…`, `deployments/sepolia.json`; the code defaults and
`deployments/sepolia.json` already point at it). To call V1 "live": point the
`ANCHOR_CONTRACT_ADDRESS` secret at it, re-import DID(s) onto the fresh (empty) roster
(`ingest --did … --submit`), and run the gated live reads (`WITNESS_LIVE_RPC=… make
adversarial-live` and `witness-ts/test/live.test.ts`). The confirmed-`diverged` headline needs a
DID anchored ≥72h
ahead so it has an immutable confirmed head.
