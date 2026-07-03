#!/usr/bin/env bash
#
# Shared network resolution + guards for the Starknet wallet/deploy scripts.
#
# The whole testnet/mainnet switch is a single variable: NETWORK=sepolia|mainnet. Source this
# and call `resolve_network` to populate the per-network values below; there is no `default`
# profile, so the network is always explicit (mainnet safety).
#
#   NETWORK              sepolia | mainnet (required)
#   STARKNET_RPC         keyed 0.10.x endpoint; overrides the public RPC (declare is rate-limited
#                        on public endpoints, so set this for deploys)
#   SNCAST_ACCOUNT       override the operator account name (default plc-<network>)
#
# The operator account is a *fee-payer only* — authorization is the op's embedded signature,
# never the tx signer (REFERENCE.md §2) — so the same account both deploys the contract and pays
# for `ingest --submit`. One funded wallet per network.

# Standard fee-token addresses (identical on Sepolia and mainnet).
export STRK_TOKEN="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
export ETH_TOKEN="0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"

resolve_network() {
  case "${NETWORK:-}" in
    sepolia)
      PROFILE="sepolia"
      ACCOUNT="${SNCAST_ACCOUNT:-plc-sepolia}"
      PUBLIC_RPC="https://starknet-sepolia.drpc.org"
      EXPLORER="https://sepolia.starkscan.co"
      ;;
    mainnet)
      PROFILE="mainnet"
      ACCOUNT="${SNCAST_ACCOUNT:-plc-mainnet}"
      PUBLIC_RPC="https://starknet-mainnet.drpc.org"
      EXPLORER="https://starkscan.co"
      ;;
    "")
      echo "!! set NETWORK=sepolia|mainnet" >&2
      exit 2
      ;;
    *)
      echo "!! unknown NETWORK '${NETWORK}' (want sepolia|mainnet)" >&2
      exit 2
      ;;
  esac
  # Keyed endpoint overrides the public RPC for rate-limited ops (declare).
  RPC="${STARKNET_RPC:-$PUBLIC_RPC}"
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  DEPLOYMENTS_FILE="$REPO_ROOT/deployments/$NETWORK.json"
  ACCOUNTS_FILE="${SNCAST_ACCOUNTS_FILE:-$HOME/.starknet_accounts/starknet_open_zeppelin_accounts.json}"
  export NETWORK PROFILE ACCOUNT PUBLIC_RPC RPC EXPLORER REPO_ROOT DEPLOYMENTS_FILE ACCOUNTS_FILE
}

# Require a typed confirmation before any mainnet write.
confirm_mainnet() {
  [ "$NETWORK" = "mainnet" ] || return 0
  echo "⚠️  This targets Starknet MAINNET (real funds)." >&2
  printf "   Type 'mainnet' to proceed: " >&2
  read -r reply
  [ "$reply" = "mainnet" ] || {
    echo "aborted." >&2
    exit 1
  }
}

require_sncast() {
  command -v sncast >/dev/null 2>&1 || {
    echo "!! sncast not found — install Starknet Foundry 0.61.0 (starkup)." >&2
    exit 127
  }
}

# Best-effort: the operator account's address from the sncast accounts file (needs jq).
account_address() {
  [ -f "$ACCOUNTS_FILE" ] && command -v jq >/dev/null 2>&1 || return 1
  jq -r --arg a "$ACCOUNT" '[.[] | .[$a]?.address // empty] | first // empty' "$ACCOUNTS_FILE" 2>/dev/null
}

# Best-effort: the operator account's private key from the sncast accounts file (needs jq). The
# sncast `oz` accounts file stores the key in plaintext under `.private_key`; same lookup shape as
# `account_address` (iterate the network buckets, match by account name).
account_private_key() {
  [ -f "$ACCOUNTS_FILE" ] && command -v jq >/dev/null 2>&1 || return 1
  jq -r --arg a "$ACCOUNT" '[.[] | .[$a]?.private_key // empty] | first // empty' "$ACCOUNTS_FILE" 2>/dev/null
}

# The deployed anchor address for $NETWORK, from the committed deployments/<net>.json (needs jq).
anchor_contract_address() {
  [ -f "$DEPLOYMENTS_FILE" ] && command -v jq >/dev/null 2>&1 || return 1
  jq -r '.contractAddress // empty' "$DEPLOYMENTS_FILE" 2>/dev/null
}
