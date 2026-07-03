# secrets/

Per-network operator config for the **deployed runtimes** — the Fly console and the e2e-sepolia CI
job — the environments that can't read `deployments/*.json` or the sncast accounts file at run time.
Everything keys off the one `NETWORK=sepolia|mainnet` switch, the same switch `deploy.sh`,
`wallet.sh`, and `ingest.sh` use.

## Files

- **`<network>.env`** — the single local source of truth for a network. **Gitignored; never
  pushed.** Create it from the template: `cp secrets/sepolia.env.example secrets/sepolia.env`.
- **`<network>.env.example`** — tracked template (blank values); keeps both networks symmetric.

Each `<network>.env` holds only the two values that have no other home:

| Key | Why it lives here |
|---|---|
| `STARKNET_RPC` | the keyed 0.10.x endpoint (not in any committed file) |
| `CONSOLE_ADMIN_TOKEN` | generated once (`openssl rand -hex 32`); console fail-closes writes without it |

Everything else is **derived at push time** from its canonical source — never hand-copied, so a
redeploy can't leave a stale value in a pushed secret:

| Value | Canonical source |
|---|---|
| `ANCHOR_CONTRACT_ADDRESS` | `deployments/<network>.json` `.contractAddress` |
| `STARKNET_ACCOUNT_ADDRESS` | sncast accounts file, account `plc-<network>` |
| `STARKNET_ACCOUNT_PRIVATE_KEY` | sncast accounts file (never written to any env file) |

## `scripts/secrets.sh` — one command per environment

| Command | Pushes | To |
|---|---|---|
| `NETWORK=mainnet scripts/secrets.sh push-fly` | 5 secrets | fly app `didmarc-console-prod` |
| `NETWORK=sepolia scripts/secrets.sh push-fly` | 5 secrets | fly app `didmarc-console` |
| `NETWORK=sepolia scripts/secrets.sh push-gh`  | 4 secrets (+ `WITNESS_LIVE_DID` var) | GitHub repo → e2e-sepolia.yml |
| `NETWORK=<net> scripts/secrets.sh show`       | nothing | presence-only audit (never prints a value) |

- **`push-gh` is Sepolia-only** — it refuses mainnet, so CI can never hold mainnet funds.
- If a `<network>.env` still carries an old `ANCHOR_CONTRACT_ADDRESS` / `STARKNET_ACCOUNT_ADDRESS`
  copy that disagrees with the canonical source, `push-*` **warns and uses the canonical value**.
- `WITNESS_LIVE_DID` (the non-secret adversarial-live target) is set by `push-gh` only if you pass
  it inline: `WITNESS_LIVE_DID=did:plc:… NETWORK=sepolia scripts/secrets.sh push-gh`.
- Needs `jq`; `push-fly`/`show` need `flyctl`; `push-gh` needs `gh` (`gh auth login`).

## Local vs deployed — which path reads what

- **Local CLI** (`ingest.sh`, `deploy.sh`, `wallet.sh`): resolve everything from `NETWORK` +
  `deployments/<net>.json` + the sncast account. **They do not read `secrets/<net>.env`.**
- **Deployed console + e2e CI**: read the pushed secrets (Fly / GitHub), synced from
  `secrets/<net>.env` by `scripts/secrets.sh`.
