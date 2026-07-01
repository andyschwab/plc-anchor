#!/usr/bin/env bash
#
# Declare + deploy the `anchor` contract to a network (sepolia|mainnet), and record the result
# in deployments/<network>.json — the machine-readable source of truth for the contract address.
#
# WHY A FRESH DEPLOY EACH TIME: the `anchor` contract is NOT upgradeable (no `replace_class_hash`
# — REFERENCE.md §6, governance deferred). A contract change means a NEW class + a FRESH instance
# at a NEW address, starting with an EMPTY roster. Re-import is cheap and idempotent (chains are
# self-certifying, replayed from genesis):
#     NETWORK=<net> cargo run -p ingest --features live -- --did did:plc:<…> --submit
#
# PREREQS (run locally — sncast is not in the agent sandbox):
#   - sncast 0.61.0 + a deployed operator account (scripts/wallet.sh).
#   - a keyed 0.10.x RPC in STARKNET_RPC (declare is rate-limited on public endpoints).
#
# USAGE:
#   NETWORK=sepolia STARKNET_RPC=https://<keyed> scripts/deploy.sh
#   NETWORK=mainnet STARKNET_RPC=https://<keyed> scripts/deploy.sh   # asks you to type 'mainnet'
#
# AFTER A SUCCESSFUL DEPLOY:
#   1. deployments/<network>.json is updated (committed source of truth).
#   2. Point ANCHOR_CONTRACT_ADDRESS at the new address (Fly secret / GitHub secret / local env).
#   3. Re-import any DIDs onto the fresh (empty) roster.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/starknet-common.sh
source "$HERE/lib/starknet-common.sh"
resolve_network
require_sncast

: "${STARKNET_RPC:?set STARKNET_RPC to a keyed $NETWORK 0.10.x endpoint (declare is rate-limited on public RPCs)}"
confirm_mainnet

CONTRACT_NAME="anchor"
# `anchor` lives in the plc_core package; the Cairo workspace has two members, so sncast needs
# --package to disambiguate.
PACKAGE="${SNCAST_PACKAGE:-plc_core}"

first_hash() { printf '%s\n' "$1" | grep -oiE '0x[0-9a-f]{60,64}'; }

echo "==> [$NETWORK] Building the Cairo workspace (sierra artifacts) ..."
(cd "$REPO_ROOT/cairo" && scarb build)

echo "==> [$NETWORK] Declaring '$CONTRACT_NAME' (account: $ACCOUNT) ..."
# `|| true`: re-declaring an unchanged class exits non-zero ("already declared") — not fatal.
DECLARE_OUT="$(cd "$REPO_ROOT/cairo" && sncast --account "$ACCOUNT" declare \
  --contract-name "$CONTRACT_NAME" --package "$PACKAGE" --url "$RPC" 2>&1 || true)"
echo "$DECLARE_OUT"
CLASS_HASH="$(first_hash "$DECLARE_OUT" | head -n1 || true)"
if [[ -z "$CLASS_HASH" ]]; then
  echo "!! Could not parse a class hash. If it says 'already declared', copy the class hash and:" >&2
  echo "     sncast --account $ACCOUNT deploy --class-hash <CLASS_HASH> --url \$STARKNET_RPC" >&2
  exit 1
fi
echo "==> class hash: $CLASS_HASH"

echo "==> [$NETWORK] Deploying an instance (no constructor — auth is the op's embedded sig, §2) ..."
DEPLOY_OUT="$(cd "$REPO_ROOT/cairo" && sncast --account "$ACCOUNT" deploy \
  --class-hash "$CLASS_HASH" --url "$RPC" 2>&1 || true)"
echo "$DEPLOY_OUT"
# sncast prints contract_address then transaction_hash.
CONTRACT_ADDR="$(first_hash "$DEPLOY_OUT" | sed -n '1p' || true)"
DEPLOY_TX="$(first_hash "$DEPLOY_OUT" | sed -n '2p' || true)"
if [[ -z "$CONTRACT_ADDR" ]]; then
  echo "!! Deploy did not return a contract address — see output above. The class IS declared;" >&2
  echo "   retry just the deploy once the declare tx is accepted:" >&2
  echo "     sncast --account $ACCOUNT deploy --class-hash $CLASS_HASH --url \$STARKNET_RPC" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/deployments"
cat >"$DEPLOYMENTS_FILE" <<JSON
{
  "network": "$NETWORK",
  "contract": "$CONTRACT_NAME",
  "package": "$PACKAGE",
  "classHash": "$CLASS_HASH",
  "contractAddress": "$CONTRACT_ADDR",
  "deployTx": "${DEPLOY_TX:-}",
  "account": "$ACCOUNT",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "explorer": "$EXPLORER/contract/$CONTRACT_ADDR",
  "note": "anchor is not upgradeable; a redeploy is a new address with an empty roster (re-import DIDs)."
}
JSON

echo
echo "============================================================"
echo " [$NETWORK] Deployed. Recorded → deployments/$NETWORK.json"
echo "   class hash:       $CLASS_HASH"
echo "   contract address: $CONTRACT_ADDR"
echo "   explorer:         $EXPLORER/contract/$CONTRACT_ADDR"
echo "   NEXT: set ANCHOR_CONTRACT_ADDRESS=$CONTRACT_ADDR, then re-import DIDs."
echo "============================================================"
