# Mainnet go-live runbook

The step-by-step to **validate and deploy** DIDMARC to Starknet mainnet, keeping the existing
Sepolia stack alongside it. This is an executable runbook, not a design doc — the **what & why**
is `REFERENCE.md`, the **how it got built** is [`HISTORY.md`](HISTORY.md). Work it top to bottom;
every phase ends in a **✅ confirm gate** you must satisfy before moving on.

> **Golden rules.** (1) `anchor` is **not upgradeable** — a redeploy is a *new address with an
> empty roster*; migration = re-import from genesis (cheap, chains self-certify). (2) Authorization
> is the op's embedded signature, never the tx signer — the operator wallet is a **fee-payer only**.
> (3) Never a false `diverged`: prefer degrading to status-quo over any risk of a false alarm.

---

## Progress (2026-07-02) — RESUMING: verify-on-read v2 cutover, then Phases 4–8

The protocol reached mainnet end-to-end on the pre-rearchitecture (in-contract-verifying) contract
(Phases 1–3 below). Fee measurement then showed **per-DID import ≈ 6.9 STRK/op, ~100% in-contract
EC verification** — not storage/DA (~free) — so the full 18 991-DID roster would cost six figures
to verify on-chain, for a backup witness. The **verify-on-read rearchitecture**
([`ONCHAIN-REARCH-PLAN.md`](ONCHAIN-REARCH-PLAN.md)) is now **adopted and implemented** (store-only
contract; the witness re-derives validity read-side). Before Phases 4–8 we deploy the **v2**
contract (a new class/address — same migration path as any redeploy) via **Phase R** below.

- **Phase 1 ✅** — `plc-mainnet` operator wallet live & funded (deployed tx `0x5d92f3e2…`).
- **Phase 2 ✅ (v1, superseded)** — pre-rearch `anchor` deployed:
  `0x04db57b605f64e9ffac02c423d864dfe37d8c40c8f18203a55a6c402cfc1d9aa`. Stays live/correct until v2
  cutover; superseded by the store-only v2 (Phase R).
- **Phase 3 ✅ (v1)** — canary `did:plc:rzeldxi4pe24uahas3z65wnp` anchored & witnessed
  `tentative-consistent`. Re-run against v2 in Phase R.
- **Secrets:** single local source of truth in `secrets/mainnet.env` (gitignored); operator key
  stays only in the sncast accounts file. RPC = keyed Alchemy mainnet 0.10.x (verified `SN_MAIN`).

---

## Phase R — verify-on-read v2 cutover (do before Phase 4)

The v2 contract is **store-only** (`import`/`submit_op`/`chain`, no in-contract crypto). It is a
new class/address with an empty roster — the standard redeploy migration; re-import from genesis
(now *much* cheaper). The witness/ingest/console code already targets v2.

- [ ] On a Scarb-equipped box: `make ci` green (esp. `cairo-build` + `cairo-test` — the sandbox
      that wrote this change has no Cairo toolchain, so this is the first real compile of the v2
      contract + rewritten `tests/anchor.cairo`).
- [ ] **Sepolia first.** `NETWORK=sepolia scripts/deploy.sh` → new v2 class/address; write
      `deployments/sepolia.json`; commit. Re-import the corpus canary
      (`cargo run -p ingest --features live -- --did <canary> --submit`).
- [ ] Sepolia validation: `cargo test -p ingest --features live --test live_e2e -- --ignored`
      (asserts byte-identical on-chain storage via `chain`); `witness check <canary>` →
      `tentative-consistent`; `WITNESS_LIVE_RPC=<sepolia> make adversarial-live` behaves.
- [ ] **Confirm cost.** Read the import `actual_fee` on Sepolia v2 and verify the ~10–50× drop vs
      the pre-rearch numbers (the whole point). Record it.
- [ ] **Mainnet.** `NETWORK=mainnet … scripts/deploy.sh` → v2 class/address; update
      `deployments/mainnet.json` + `secrets/mainnet.env` `ANCHOR_CONTRACT_ADDRESS`; commit.
- [ ] Re-run Phase 3's canary onboarding + witness/adversarial-live against the mainnet v2 address;
      restart the 72h confirmed-head clock. Point `witness-ts`/`console`/CLI defaults at the v2
      address.

**✅ Gate:** v2 store-only contract live on Sepolia **and** mainnet; canary reads back
byte-identical + `tentative-consistent`; import fee confirms the drop; deployment JSONs committed.
Then proceed to Phase 4 with the v2 mainnet address.

---

## Target end-state

Two isolated console environments, one static site. A Fly app has exactly **one**
`ANCHOR_CONTRACT_ADDRESS` and one roster DB, so the two networks are two apps.

| Hostname | Fly app | Network | Contract | Roster volume |
|---|---|---|---|---|
| `testnet.plc.didmarc.dev` | `didmarc-console` *(existing, untouched)* | Sepolia | `deployments/sepolia.json` | `roster_data` (existing) |
| `plc.didmarc.dev` | `didmarc-console-prod` *(new)* | **mainnet** | `deployments/mainnet.json` | fresh volume |
| `didmarc.dev`, `www.` | `didmarc` *(existing)* | — (static) | — | — |

Deploy trigger: **manual `fly deploy` from `main`, tagged releases** (`v1.0.0-mainnet`).
Secrets: a **single local source of truth per network** pushed by `scripts/secrets.sh`
(mainnet secrets never leave Fly + your machine; GitHub gets Sepolia-only e2e secrets).

---

## Secrets model (read once before Phase 1)

Goal: stop juggling critical bits. Each secret has **exactly one home** and one push command.

- **The operator private key lives only in sncast's accounts file** (`~/.starknet_accounts/…`,
  already `.gitignore`d). It is never typed twice, never in an env file, never in GitHub. The
  sync script reads it from there with `jq` when it needs to set the Fly secret.
- **Everything else per network** lives in a gitignored `secrets/<network>.env`
  (`STARKNET_RPC`, `ANCHOR_CONTRACT_ADDRESS`, `STARKNET_ACCOUNT_ADDRESS`, `CONSOLE_ADMIN_TOKEN`).
  `ANCHOR_CONTRACT_ADDRESS` is copied from `deployments/<network>.json` after each deploy.
- **`scripts/secrets.sh`** (built in Phase 5) maps `NETWORK → Fly app` and pushes the right subset:
  - `NETWORK=mainnet scripts/secrets.sh push-fly` → `fly secrets import` to `didmarc-console-prod`
  - `NETWORK=sepolia scripts/secrets.sh push-gh` → `gh secret set` for the `e2e-sepolia.yml` job
    **(testnet only — mainnet is never pushed to GitHub, so CI can never spend real funds)**
  - `NETWORK=<net> scripts/secrets.sh show` → presence-only audit, no values printed

`secrets/` and `*.env` get added to `.gitignore` in Phase 5.

---

## Phase 0 — Repo readiness (no chain writes)

- [ ] `make ci` green on `main` (the consensus gate is the source of truth for test health).
- [x] **Fail-closed fix — console.** `console/src/main.ts` no longer falls back to Sepolia in
      production: `resolveContractAddress()` throws at boot if `ANCHOR_CONTRACT_ADDRESS` is unset
      and `NODE_ENV=production` (the Sepolia constant is a dev-only convenience). *(landed)*
- [x] **Fail-closed fix — witness.** `witness-ts/src/cli.ts` resolves the contract as
      `--contract` → `$ANCHOR_CONTRACT_ADDRESS` → Sepolia default; mainnet reads require an
      explicit mainnet address (documented in the CLI header). *(landed)*
- [x] **Prod roster policy decided, not inherited.** Mainnet's first real target is confirmed:
      `ROSTER_CRITERION=pds_domain:eurosky.social`, `PDS_ENDPOINTS=https://eurosky.social`,
      `ACTIVE_DEFAULT=false` (spend gate off at boot). `IMPORT_BUDGET_PER_TICK` to be finalized
      against the Phase-1 fee measurement. These go in the new `console/fly.prod.toml` (Phase 4).
- [ ] Toolchain matches `.tool-versions`: Scarb/Cairo 2.18.0, snforge 0.61.0, USC 2.9.0,
      Rust 1.96.0; `sncast --version` == 0.61.0; `flyctl` + `gh` installed and authed locally.

**✅ Gate:** CI green on `main`; both fail-closed fixes merged; prod roster config written down.

---

## Phase 1 — Operator wallet (mainnet)

The wallet both deploys the contract and pays for `ingest --submit`. One funded account per network.

- [ ] `NETWORK=mainnet scripts/wallet.sh create` → prints the `plc-mainnet` address (no chain write).
- [ ] Fund that address with real **STRK** (a little ETH also fine). Size it from measured cost,
      don't guess: read the Sepolia console `/roster/aggregates` for the **average `actual_fee`**
      per import, multiply by expected mainnet import count, add generous headroom + a deploy-tx
      buffer. Record the number and the funding tx.
- [ ] `NETWORK=mainnet scripts/wallet.sh deploy` (typed `mainnet` confirm) → account contract live.
- [ ] `NETWORK=mainnet scripts/wallet.sh balance` → confirm the funded balance on-chain.

**✅ Gate:** `plc-mainnet` deployed + funded; address and balance confirmed on starkscan.

---

## Phase 2 — Deploy the `anchor` contract to mainnet

- [ ] Obtain a **keyed mainnet 0.10.x RPC** (public endpoints rate-limit `declare`). Put it in
      `secrets/mainnet.env` as `STARKNET_RPC`.
- [ ] `NETWORK=mainnet STARKNET_RPC=<keyed> scripts/deploy.sh` → type `mainnet` at the prompt.
      Declares the class, deploys an instance (no constructor), writes `deployments/mainnet.json`.
- [ ] Verify the printed **Contract Address** on `https://starkscan.co/contract/<addr>` (deployed,
      class hash matches).
- [ ] Copy `contractAddress` from `deployments/mainnet.json` into `secrets/mainnet.env` as
      `ANCHOR_CONTRACT_ADDRESS`.
- [ ] Commit `deployments/mainnet.json` (public data — addresses/hashes only, no keys).
- [ ] Sanity read against mainnet: an empty-roster head/root view returns cleanly (no DIDs yet).

**✅ Gate:** `deployments/mainnet.json` committed; contract verified on-chain; empty-roster read OK.

---

## Phase 3 — Canary DID + on-chain validation

Prove the write→read→witness loop on mainnet with **one** DID before any infra or roster automation.
**Start the 72h clock here** — a `confirmed` head (needed for the `diverged` headline) requires a
DID observed ≥72h; imported history is settled/tentative until then.

- [ ] Export the mainnet operator secrets into the env (`STARKNET_RPC`, `ANCHOR_CONTRACT_ADDRESS`,
      `STARKNET_ACCOUNT_ADDRESS`, `STARKNET_ACCOUNT_PRIVATE_KEY` — the key from the sncast file).
- [ ] Onboard one known DID (whole resolved history as a settled `import`, the 4a-correct path):
      `cargo run -p ingest --features live -- --did did:plc:<canary> --submit`.
- [ ] `witness check <did> --rpc <mainnet-rpc> --contract <mainnet-addr>` → `tentative-consistent`
      (head byte-identical to the directory's published head — the resolver cross-check, live).
- [ ] `WITNESS_LIVE_RPC=<mainnet> WITNESS_LIVE_CONTRACT=<mainnet-addr> WITNESS_LIVE_DID=<did>
      make adversarial-live` → the malicious-mirror read alarms, the honest read stays quiet.
- [ ] (T+72h, tracked in Phase 8) the canary head hardens to `confirmed`; re-run the witness to
      see the `confirmed`/`diverged` branch exercised against mainnet.

**✅ Gate:** canary reads back byte-identical; `adversarial-live` behaves; 72h timer noted.

---

## Phase 4 — Production console infra (Fly)

Keep `didmarc-console` (Sepolia) exactly as-is. Stand up a **separate** prod app with its own volume.

- [ ] Create `console/fly.prod.toml` from `console/fly.toml` with: `app = "didmarc-console-prod"`,
      the mainnet `[env]` roster policy from Phase 0, and `ACTIVE_DEFAULT = 'false'`. (Do **not**
      put secrets in the toml.)
- [ ] From the repo root: `fly launch --no-deploy --config console/fly.prod.toml --dockerfile console/Dockerfile`.
- [ ] `fly --config console/fly.prod.toml volumes create roster_data --region fra --size 1`
      (a **fresh** volume — the prod roster starts empty).
- [ ] Set secrets via the Phase-5 tool: `NETWORK=mainnet scripts/secrets.sh push-fly`
      (RPC, contract, account address, operator key, and a fresh
      `CONSOLE_ADMIN_TOKEN=$(openssl rand -hex 32)` — writes are fail-closed without it).
- [ ] `fly deploy --config console/fly.prod.toml --dockerfile console/Dockerfile` (from repo root).
- [ ] `fly --config console/fly.prod.toml checks list` → `/healthz` green.
- [ ] Hit `/roster/aggregates` and **confirm the reported anchor address is the mainnet one**
      (guards against the Phase-0 fallback footgun surviving).

**✅ Gate:** prod app healthy, roster empty, and confirmed reading the **mainnet** contract.

---

## Phase 5 — Secrets tooling

- [ ] Add `secrets/` and `*.env` to `.gitignore`.
- [ ] Write `scripts/secrets.sh` (reuse `scripts/lib/starknet-common.sh` for `resolve_network`
      and the `NETWORK → app` map: sepolia→`didmarc-console`, mainnet→`didmarc-console-prod`):
      - `push-fly` — load `secrets/<network>.env`, pull the operator key from the sncast accounts
        file (`account_address`/jq), `fly secrets import` to the network's app.
      - `push-gh` — **sepolia only** (`confirm_mainnet`-style refusal for mainnet): `gh secret set`
        the four `e2e-sepolia.yml` secrets + the `WITNESS_LIVE_DID` var.
      - `show` — presence-only audit (`fly secrets list` names, never values).
- [ ] Dry-run `NETWORK=sepolia scripts/secrets.sh show` against the existing app to validate the
      app map before trusting it for mainnet.

**✅ Gate:** one command re-syncs each environment's secrets; the key still has a single home.

---

## Phase 6 — Release & rollback process

- [ ] Document in this file: deploys are manual `fly deploy` from `main`; tag each production
      cutover (`git tag v1.0.0-mainnet && git push --tags`).
- [ ] **Rollback of the app** = `fly deploy` a prior image / `fly releases` rollback (stateless;
      the roster volume persists).
- [ ] **Rollback of the contract** is *not* an upgrade: a new class → new address → empty roster.
      The console's contract-switch reconcile resets `anchored`/`onboarding` → `approved` and
      re-imports from genesis (`POST /worker/reconcile` for the first migration). Note this is the
      expected migration path, not an emergency-only one.

**✅ Gate:** release + rollback steps written; a tag exists for the go-live commit.

---

## Phase 7 — Cutover to production

- [ ] Point DNS/cert: `fly certs add plc.didmarc.dev --config console/fly.prod.toml`; move the
      `plc.didmarc.dev` cert **off** `didmarc-console` and confirm `testnet.plc.didmarc.dev`
      still resolves to the testnet app.
- [ ] Confirm `plc.didmarc.dev` serves the prod console over HTTPS and reports the mainnet address.
- [ ] Seed the roster criterion (already in `fly.prod.toml`); verify discovery enumerates
      candidates **without** spending (Active still off).
- [ ] Flip **Active on** in the ⚙ panel and set the production `IMPORT_BUDGET_PER_TICK`. Watch the
      first real imports land: `ANCHORED <did> tx=<hash>` → `/roster/aggregates` cumulative +
      average `actual_fee` within the Phase-1 estimate.

**✅ Gate:** first mainnet DID `anchored`; measured fee within estimate; testnet still green.

---

## Phase 8 — Post-launch

- [ ] **T+72h:** canary + first-batch heads reach `confirmed`; re-run the witness and the
      `confirmed`/`diverged` adversarial branch against mainnet — the full status ladder proven live.
- [ ] Operator-wallet **funding-runway** alarm: watch balance vs the rolling average fee; top up
      before the budgeted batch drains it (a dry wallet stalls onboarding, a benign failure).
- [ ] Monitoring: the console Workers panel surfaces per-loop `error`/`lastRunAt`; Fly health
      checks cover liveness. Add an external uptime check on `plc.didmarc.dev/healthz`.
- [ ] Update `HISTORY.md` item 6 status → live on mainnet; record `deployments/mainnet.json` as
      the canonical address.

**✅ Gate:** status ladder proven live; funding + uptime monitoring in place; docs updated.

---

## Deferred (explicitly not blocking go-live)

Tracked in `HISTORY.md` "Open follow-ups": batched settled `import` for long chains
(`import_append`), trustless root reads (L1 storage proof, SECURITY-TODO 4c), precise skew bound,
paymaster/AA cost allocation (MVP = one project-funded account). None gate V1.
