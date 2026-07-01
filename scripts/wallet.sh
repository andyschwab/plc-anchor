#!/usr/bin/env bash
#
# Manage the operator wallet for a network. One funded account per network (sepolia|mainnet),
# used both to deploy the anchor contract and to pay for `ingest --submit`.
#
# The account is a fee-payer only (REFERENCE.md §2). Keys live in sncast's accounts file
# (~/.starknet_accounts/ by default) — OUTSIDE the repo; never committed.
#
# USAGE:
#   NETWORK=sepolia scripts/wallet.sh create     # generate keypair + address (no chain write)
#   #  … fund the printed address with a little ETH or STRK …
#   NETWORK=sepolia scripts/wallet.sh deploy      # deploy the account contract on-chain
#   NETWORK=sepolia scripts/wallet.sh list        # sncast account list
#   NETWORK=sepolia scripts/wallet.sh balance     # STRK/ETH balance + explorer link
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/starknet-common.sh
source "$HERE/lib/starknet-common.sh"
resolve_network
require_sncast

cmd="${1:-help}"
case "$cmd" in
  create)
    echo "==> Creating operator account '$ACCOUNT' for $NETWORK (type: oz) ..."
    sncast account create --url "$RPC" --name "$ACCOUNT" --type oz
    echo
    echo "NEXT: fund the printed address (a little ETH or STRK), then:"
    echo "  NETWORK=$NETWORK scripts/wallet.sh deploy"
    ;;
  deploy)
    confirm_mainnet
    echo "==> Deploying account '$ACCOUNT' on $NETWORK ..."
    sncast account deploy --url "$RPC" --name "$ACCOUNT"
    echo "done — the account is live. Reuse it as the ingest fee-payer:"
    echo "  STARKNET_ACCOUNT_ADDRESS=<address>  STARKNET_ACCOUNT_PRIVATE_KEY=<key from $ACCOUNTS_FILE>"
    ;;
  list)
    sncast account list
    ;;
  balance)
    addr="${ADDRESS:-$(account_address || true)}"
    [ -n "$addr" ] || {
      echo "!! could not resolve the account address; pass ADDRESS=0x… (see: wallet.sh list)" >&2
      exit 1
    }
    echo "account: $addr  ($NETWORK)"
    echo "-- STRK balanceOf --"
    sncast call --url "$RPC" --contract-address "$STRK_TOKEN" --function balanceOf --calldata "$addr" || true
    echo "-- ETH balanceOf --"
    sncast call --url "$RPC" --contract-address "$ETH_TOKEN" --function balanceOf --calldata "$addr" || true
    echo "explorer: $EXPLORER/contract/$addr"
    ;;
  help | *)
    echo "usage: NETWORK=sepolia|mainnet scripts/wallet.sh {create|deploy|list|balance}"
    ;;
esac
