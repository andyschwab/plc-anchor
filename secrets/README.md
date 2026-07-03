# secrets/

Per-network operator config for the **deployed runtime** (the Fly console + the e2e CI job) —
the environments that can't read `deployments/*.json` or the sncast accounts file at run time.

- **`<network>.env`** — the single local source of truth for a network. **Gitignored; never
  pushed.** Create it from the template: `cp secrets/sepolia.env.example secrets/sepolia.env`.
- **`<network>.env.example`** — tracked template (blank values). Keeps both networks symmetric.

The operator **private key is never in these files** — it lives only in sncast's accounts file
(`~/.starknet_accounts/…`). Everything here keys off the one `NETWORK=sepolia|mainnet` switch, the
same switch `scripts/deploy.sh`, `scripts/wallet.sh`, and `scripts/ingest.sh` use.

## What actually needs to live here

Only two values have no other home — pin these:

| Key | Why it lives here |
|---|---|
| `STARKNET_RPC` | the keyed 0.10.x endpoint (not in any committed file) |
| `CONSOLE_ADMIN_TOKEN` | generated once (`openssl rand -hex 32`); console fail-closes writes without it |

The other two are **copies of canonical sources** and drift on redeploy — for local `ingest`
runs you don't need them at all (`scripts/ingest.sh` resolves both from source):

| Key | Canonical source |
|---|---|
| `ANCHOR_CONTRACT_ADDRESS` | `deployments/<network>.json` `.contractAddress` |
| `STARKNET_ACCOUNT_ADDRESS` | sncast accounts file, account `plc-<network>` |

They are pinned here only for the deployed console/CI. When `scripts/secrets.sh` lands (Phase 5)
it should **derive** them from those sources (reuse `anchor_contract_address` / `account_address`
in `scripts/lib/starknet-common.sh`) rather than trust a hand-copied value.

## Local vs deployed — which path uses what

- **Local CLI** (`scripts/ingest.sh`, `deploy.sh`, `wallet.sh`): resolve everything from `NETWORK`
  + `deployments/<net>.json` + the sncast account. **They do not read `secrets/<net>.env`.**
- **Deployed console + e2e CI**: read the pushed env (Fly secrets / GitHub secrets), sourced from
  `secrets/<net>.env` by `scripts/secrets.sh` (Phase 5).
