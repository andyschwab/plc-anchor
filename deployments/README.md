# `deployments/` — the anchor contract, per network

The machine-readable **source of truth** for "what is the current `anchor` contract address on
network X." One file per network, written by `scripts/deploy.sh` on each deploy:

| File | Network |
|---|---|
| `sepolia.json` | Starknet Sepolia (testnet) |
| `mainnet.json` | Starknet mainnet — created on the first mainnet deploy |

## Schema

```json
{
  "network": "sepolia | mainnet",
  "contract": "anchor",
  "package": "plc_core",
  "classHash": "0x…",
  "contractAddress": "0x…",
  "deployTx": "0x…",
  "account": "plc-<network>",
  "deployedAt": "ISO-8601 UTC",
  "explorer": "https://…/contract/0x…",
  "note": "…"
}
```

## How it's consumed

`contractAddress` is what feeds `ANCHOR_CONTRACT_ADDRESS` everywhere it's read — the console
(`console/fly.toml` / Fly secret), the witness (`witness-ts`), `ingest --submit`, and the
`e2e-sepolia.yml` GitHub secret. After a (re)deploy, update those from this file.

> The `anchor` contract is **not upgradeable** (REFERENCE.md §6). A redeploy is a new class + a
> fresh instance at a **new address with an empty roster** — cheap to migrate to, since chains
> are self-certifying and re-imported from genesis (`ingest --did … --submit`). These files are
> public data (addresses, class/tx hashes) — safe to commit. **Private keys never live here**;
> they stay in sncast's accounts file outside the repo.
