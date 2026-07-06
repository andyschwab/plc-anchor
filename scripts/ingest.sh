#!/usr/bin/env bash
#
# Run `ingest --submit` against a network with ONE switch: NETWORK=sepolia|mainnet — the same
# switch deploy/wallet use. It resolves all four live-sink env vars from a single source of truth
# and execs cargo, so you never hand-swap them (a partial swap — mainnet anchor + a Sepolia
# operator account left in the shell — is the classic `ContractNotFound` on estimate_fee).
#
#   STARKNET_RPC                  keyed 0.10.x endpoint (falls back to the public RPC)
#   ANCHOR_CONTRACT_ADDRESS   ←   deployments/<net>.json  (.contractAddress; the committed truth)
#   STARKNET_ACCOUNT_ADDRESS  ←   sncast accounts file, account plc-<net> (.address)
#   STARKNET_ACCOUNT_PRIVATE_KEY ← sncast accounts file, account plc-<net> (.private_key)
#
# The resolved values are EXPORTED (overriding anything already in the shell) so a stale leftover
# from the other network can't leak in. The operator is a fee-payer only (REFERENCE.md §2).
#
# USAGE:
#   NETWORK=sepolia scripts/ingest.sh --did did:plc:<…> --submit
#   NETWORK=mainnet scripts/ingest.sh --did did:plc:<…> --submit   # asks you to type 'mainnet'
#   NETWORK=sepolia scripts/ingest.sh --did did:plc:<…>            # dry-run (no --submit)
#
# Everything after the network resolution is passed straight through to `ingest`, so all its flags
# (--roster, --source, --cursor, --count, --submit) work unchanged.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/starknet-common.sh
source "$HERE/lib/starknet-common.sh"
resolve_network

command -v jq >/dev/null 2>&1 || {
  echo "!! jq required to resolve the operator account + anchor address from source." >&2
  exit 127
}

contract="$(anchor_contract_address || true)"
[ -n "$contract" ] || {
  echo "!! no anchor address in $DEPLOYMENTS_FILE — deploy first (scripts/deploy.sh)." >&2
  exit 1
}
addr="$(account_address || true)"
key="$(account_private_key || true)"
if [ -z "$addr" ] || [ -z "$key" ]; then
  echo "!! could not resolve operator account '$ACCOUNT' (address/key) from $ACCOUNTS_FILE." >&2
  echo "   create + fund + deploy it first: NETWORK=$NETWORK scripts/wallet.sh {create,deploy}" >&2
  exit 1
fi

# Export the resolved config, overriding any leftover exports from the other network.
export STARKNET_RPC="$RPC"
export ANCHOR_CONTRACT_ADDRESS="$contract"
export STARKNET_ACCOUNT_ADDRESS="$addr"
export STARKNET_ACCOUNT_PRIVATE_KEY="$key"

echo "==> [$NETWORK] ingest → anchor $contract  (operator $ACCOUNT $addr, rpc ${RPC%%\?*})" >&2

# Only a --submit run writes on-chain; gate just that behind the mainnet confirmation.
for a in "$@"; do [ "$a" = "--submit" ] && confirm_mainnet && break; done

exec cargo run -p ingest --features live -- "$@"
