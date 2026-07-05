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

## Progress (2026-07-05) — verify-on-read v2 LIVE (Sepolia + mainnet); Phases 4–8 next

The protocol first reached mainnet on the pre-rearchitecture (in-contract-verifying) contract.
Fee measurement showed **per-DID import ≈ 6.9 STRK/op, ~100% in-contract EC verification** (not
storage/DA, which is ~free) — six figures to verify the full 18 991-DID roster on-chain. The
**verify-on-read rearchitecture** ([`ONCHAIN-REARCH-PLAN.md`](ONCHAIN-REARCH-PLAN.md)) moved
verification read-side; the **v2 store-only contract is now deployed to Sepolia (`0x06b16c52…`) and
mainnet** (Phase R done). **Measured Sepolia import ≈ 2.33 STRK vs 27.6 STRK pre-rearch — ~11.8×**
(`l1_gas 0`, `l1_data_gas` ~free, `l2_gas 81.65M`; residual is ordinary store-only execution).
Cost-mitigation levers for the bulk backfill are tracked in `ONCHAIN-REARCH-PLAN.md` §7 — profile
1-op vs 4-op and decide *before* importing the 19k roster (each lever is a redeploy).
**`deployments/mainnet.json` is current** — it records the live v2 address
(`0x03add24b78ab50d532dd78435d473bc61b990925f171071b0afdefe464f1e124`, redeployed once more on
2026-07-03 after the first v2 mainnet deploy to pick up a fix, per its git history) —
that outstanding item from the prior update of this doc is **done**.
**`make ci` reconfirmed green (2026-07-05)** on this checkout: 9 `drisl` + conformance/adversarial/
witness/console all pass. **Outstanding:** land the mainnet v2 canary (Phase R's last bullet), then
the console productionization (Phases 4–8 below) — nothing else blocks starting Phase 4.

**Open decision carried forward from `ONCHAIN-REARCH-PLAN.md` §7 — resolve before Phase 7's full
rollout, not before Phase 4.** The current v2 average (~2.33 STRK, likely lower in practice since
most DIDs have 1–2 ops) is affordable for the ~19k-DID eurosky roster as-is, and none of the
`import_batch` / caller-supplied-DID / per-op-write-trim levers gate V1. But each lever is a
**contract change ⇒ another redeploy ⇒ empty roster again**, so paying full v2 price across all
19k DIDs and *then* adopting a lever means re-importing all of them a second time. Decide **before
raising `IMPORT_BUDGET_PER_TICK` off its Phase-7 canary-scale value**, not before Phases 4–6 (which
only need the wallet, contract, and console up — not the bulk import): either (a) accept the
current v2 cost and run the full backfill, or (b) spend one more redeploy on the cheap, low-risk
per-op trims (no API change) and/or `import_batch` first. This is a cost/timeline call, not an
engineering blocker — flag it for a go/no-go before Phase 7's budget ramp.

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

- [x] On a Scarb-equipped box: `make ci` green (Cairo included — 44 `plc_core` + 9 `drisl`).
- [x] **Sepolia first.** `NETWORK=sepolia scripts/deploy.sh` → v2 `0x06b16c52…` (class `0x513df4e…`),
      `deployments/sepolia.json` committed. Canary `did:plc:rzeldxi4pe24uahas3z65wnp` re-imported.
- [x] Sepolia validation: `live_e2e` byte-identical storage; `witness check` non-alarming;
      `adversarial-live` behaves. (The confirmed-`diverged` branch needs the canary ≥72h — re-run then.)
- [x] **Confirm cost.** Sepolia v2 import (tx `0x10031214…c0e571`) ≈ **2.33 STRK** vs 27.6 STRK
      pre-rearch = **~11.8×** (`l1_gas 0`, `l1_data_gas 5 952`, `l2_gas 81.65M`). Recorded in
      `ONCHAIN-REARCH-PLAN.md` §7 with the mitigation levers for the bulk backfill.
- [x] **Mainnet.** v2 deployed (`0x03add24…`) and committed to `deployments/mainnet.json`. Code
      defaults auto-resolve from `deployments/<net>.json`, so witness/console/CLI point at v2
      automatically; `scripts/ingest.sh` reads the same file for the write path.
- [~] Re-run canary onboarding + witness/adversarial-live against the mainnet v2 address; restart
      the 72h clock. Onboard with `NETWORK=mainnet scripts/ingest.sh --did … --submit` — the
      single-switch wrapper resolves the anchor (deployments JSON) **and** the operator account
      (sncast `plc-mainnet`) together, so the two can't drift out of sync (that mismatch — mainnet
      anchor, Sepolia operator — was the `ContractNotFound` on `estimate_fee`).

**✅ Gate:** v2 store-only contract live on Sepolia **and** mainnet; Sepolia canary reads back
byte-identical + non-alarming; import fee confirms **~11.8×**. **Remaining:** land the mainnet
canary import via the wrapper, then proceed to Phase 4.

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
- **Only two values per network** live in a gitignored `secrets/<network>.env`: `STARKNET_RPC`
  (the keyed endpoint) and `CONSOLE_ADMIN_TOKEN` (generated once). The two addresses
  (`ANCHOR_CONTRACT_ADDRESS`, `STARKNET_ACCOUNT_ADDRESS`) are **not** hand-copied here — the sync
  tool derives them at push time from `deployments/<network>.json` and the sncast account, so a
  redeploy can't leave a stale copy. (Templates: `secrets/<network>.env.example`, tracked.)
- **`scripts/secrets.sh`** maps `NETWORK → Fly app` and pushes the right subset:
  - `NETWORK=mainnet scripts/secrets.sh push-fly` → `fly secrets import` to `didmarc-console-prod`
  - `NETWORK=sepolia scripts/secrets.sh push-gh` → `gh secret set` for the `e2e-sepolia.yml` job
    **(testnet only — push-gh refuses mainnet, so CI can never spend real funds)**
  - `NETWORK=<net> scripts/secrets.sh show` → presence-only audit, no values printed

---

## Phase 0 — Repo readiness (no chain writes)

- [x] `make ci` green on `main` (the consensus gate is the source of truth for test health).
      *(reconfirmed 2026-07-05 on this checkout: `drisl`/`plc_core` Cairo tests, conformance,
      adversarial, `rust-test`, `witness-test`, `console-test` all pass.)*
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

## Phase 1 — Operator wallet (mainnet)  ✅ done

The wallet both deploys the contract and pays for `ingest --submit`. One funded account per network.
**Done** — `plc-mainnet` is live and funded (deploy tx `0x5d92f3e2…`); it is the same wallet used
for both the superseded v1 contract and the current v2 (Phase R), so nothing here needs redoing.

- [x] `NETWORK=mainnet scripts/wallet.sh create` → prints the `plc-mainnet` address (no chain write).
- [x] Fund that address with real **STRK** (a little ETH also fine). Size it from measured cost,
      don't guess: read the Sepolia console `/roster/aggregates` for the **average `actual_fee`**
      per import, multiply by expected mainnet import count, add generous headroom + a deploy-tx
      buffer. Record the number and the funding tx.
- [x] `NETWORK=mainnet scripts/wallet.sh deploy` (typed `mainnet` confirm) → account contract live.
- [x] `NETWORK=mainnet scripts/wallet.sh balance` → confirm the funded balance on-chain.

**✅ Gate met:** `plc-mainnet` deployed + funded; address and balance confirmed on starkscan.

---

## Phase 2 — Deploy the `anchor` contract to mainnet  ✅ done (superseded by Phase R)

The steps below were executed for the original (pre-rearch) contract
(`0x04db57b6…d9aa`). **The live contract today is the v2 store-only redeploy from Phase R**
(`deployments/mainnet.json` → `0x03add24b…f1e124`) — same steps, same wallet, new address per the
"not upgradeable" golden rule. Kept here for history; no action needed.

- [x] Obtain a **keyed mainnet 0.10.x RPC** (public endpoints rate-limit `declare`). Put it in
      `secrets/mainnet.env` as `STARKNET_RPC`.
- [x] `NETWORK=mainnet STARKNET_RPC=<keyed> scripts/deploy.sh` → type `mainnet` at the prompt.
      Declares the class, deploys an instance (no constructor), writes `deployments/mainnet.json`.
- [x] Verify the printed **Contract Address** on `https://starkscan.co/contract/<addr>` (deployed,
      class hash matches).
- [x] Commit `deployments/mainnet.json` (public data — addresses/hashes only, no keys). This is the
      canonical anchor address; `scripts/ingest.sh` and `scripts/secrets.sh` read it from here, so
      there is **no** `ANCHOR_CONTRACT_ADDRESS` to hand-copy into `secrets/mainnet.env`.
- [x] Sanity read against mainnet: an empty-roster head/root view returns cleanly (no DIDs yet).

**✅ Gate met (historically, and again via Phase R for v2):** `deployments/mainnet.json`
committed and current; contract verified on-chain; empty-roster read OK.

---

## Phase 3 — Canary DID + on-chain validation  (done for v1; v2 status unclear — verify before Phase 4)

Prove the write→read→witness loop on mainnet with **one** DID before any infra or roster automation.
**Start the 72h clock here** — a `confirmed` head (needed for the `diverged` headline) requires a
DID observed ≥72h; imported history is settled/tentative until then.

> **Doc conflict, resolve first.** `HISTORY.md`'s verify-on-read entry says "v2 deployed to Sepolia
> and mainnet, canary re-imported and witnessed," but this checklist's Phase R still marks the
> mainnet canary re-run as `[~]` (open) with the concrete remaining command below. This session
> had no chain/RPC access to check the mainnet contract's tx history and resolve which is right.
> **Before starting Phase 4, run `witness check <canary-did> --rpc <mainnet-rpc> --contract
> 0x03add24b…f1e124` once** — a `tentative-consistent`/`confirmed` result means Phase R's `[~]` is
> stale and can be checked off; `absent`/an RPC "no such DID" means the canary import below still
> needs to run.

- [ ] Onboard one known DID (whole resolved history as a settled `import`, the 4a-correct path)
      with the single-switch wrapper — it resolves the anchor from `deployments/mainnet.json` and
      the operator address+key from the sncast `plc-mainnet` account, so there is nothing to
      hand-swap (a partial swap — mainnet anchor + a Sepolia operator left in the shell — is the
      classic `ContractNotFound` on `estimate_fee`):
      `NETWORK=mainnet scripts/ingest.sh --did did:plc:<canary> --submit`.
      *(The raw form `STARKNET_*=… cargo run -p ingest --features live -- --did … --submit` still
      works but ignores `NETWORK` and trusts four hand-set env vars — prefer the wrapper.)*
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

## Phase 5 — Secrets tooling  ✅ built

- [x] `.gitignore`: `secrets/*` ignored; tracked `*.env.example` + `secrets/README.md` kept so the
      structure is version-controlled and symmetric across networks.
- [x] `scripts/secrets.sh` (reuses `scripts/lib/starknet-common.sh` `resolve_network` + the
      `NETWORK → FLY_APP` map: sepolia→`didmarc-console`, mainnet→`didmarc-console-prod`):
      - `push-fly` — `fly secrets import` the 5 console secrets to the network's app. RPC + admin
        token come from `secrets/<net>.env`; the anchor address, operator address, and **operator
        key** are DERIVED at push time (`anchor_contract_address` / `account_address` /
        `account_private_key`), so nothing is hand-copied and a redeploy can't ship a stale value.
      - `push-gh` — **sepolia only** (refuses mainnet): `gh secret set` the four `e2e-sepolia.yml`
        secrets + optional `WITNESS_LIVE_DID` repo variable.
      - `show` — presence-only audit (local sources + `fly secrets list` / `gh secret list` names,
        never a value).
      Also `make ingest` / `make secrets` wrap the two scripts (`ARGS=` / `CMD=`).
- [ ] Dry-run `NETWORK=sepolia scripts/secrets.sh show` against the existing app to validate the
      app map before trusting it for mainnet.

**✅ Gate:** one command re-syncs each environment's secrets; the operator key still has a single
home (sncast) and the two addresses derive from their canonical sources. **Remaining:** the live
`show` dry-run against the real Sepolia app (needs flyctl + auth locally).

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
- [ ] **Cost-mitigation go/no-go** (see the Progress section decision, `ONCHAIN-REARCH-PLAN.md` §7):
      confirm whether the full ~19k-DID backfill runs on the current v2 contract as-is, or waits on
      one more redeploy for `import_batch`/caller-supplied-DID/per-op trims. Decide **before** the
      budget ramp below, not before this phase's DNS/console steps.
- [ ] Flip **Active on** in the ⚙ panel and set the production `IMPORT_BUDGET_PER_TICK` — start at
      canary/small-batch scale, only ramp toward covering the full roster once the go/no-go above is
      resolved. Watch the first real imports land: `ANCHORED <did> tx=<hash>` →
      `/roster/aggregates` cumulative + average `actual_fee` within the Phase-1 estimate.

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

Tracked in `HISTORY.md` "Open follow-ups" / `ONCHAIN-REARCH-PLAN.md` §7: verify-on-read cost
mitigations for the bulk backfill (`import_batch`, caller-supplied DID to drop the on-chain
`sha256`, per-op write trims — decide via a 1-op-vs-4-op profile before importing the 19k roster),
trustless root reads (L1 storage proof, SECURITY-TODO 4c), precise skew bound, paymaster/AA cost
allocation (MVP = one project-funded account). None gate V1.
