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
# The hash on a specific labeled line (e.g. "Contract Address:"). Robust against hashes that
# appear elsewhere in the output — an RPC warning, or a class hash quoted inside a *failed*
# deploy's error message ("Class with hash 0x… is not declared"), which is exactly how a failed
# deploy once got mis-recorded as the contract address.
labeled_hash() { printf '%s\n' "$2" | grep -iE "$1" | grep -oiE '0x[0-9a-f]+' | head -n1; }

echo "==> [$NETWORK] Building the Cairo workspace (sierra artifacts) ..."
(cd "$REPO_ROOT/cairo" && scarb build)

echo "==> [$NETWORK] Declaring '$CONTRACT_NAME' (account: $ACCOUNT) ..."
# `|| true`: re-declaring an unchanged class exits non-zero ("already declared") — not fatal.
DECLARE_OUT="$(cd "$REPO_ROOT/cairo" && sncast --account "$ACCOUNT" declare \
  --contract-name "$CONTRACT_NAME" --package "$PACKAGE" --url "$RPC" 2>&1 || true)"
echo "$DECLARE_OUT"
# Prefer the labeled "Class Hash:" line; a re-declare of an unchanged class exits non-zero without
# that line but names the hash in its "already declared" message, so fall back to any hash then.
CLASS_HASH="$(labeled_hash '^[[:space:]]*Class Hash:' "$DECLARE_OUT" || true)"
[[ -z "$CLASS_HASH" ]] && CLASS_HASH="$(first_hash "$DECLARE_OUT" | head -n1 || true)"
if [[ -z "$CLASS_HASH" ]]; then
  echo "!! Could not parse a class hash. If it says 'already declared', copy the class hash and:" >&2
  echo "     sncast --account $ACCOUNT deploy --class-hash <CLASS_HASH> --url \$STARKNET_RPC" >&2
  exit 1
fi
echo "==> class hash: $CLASS_HASH"

echo "==> [$NETWORK] Deploying an instance (no constructor — auth is the op's embedded sig, §2) ..."
# Parse the address ONLY from sncast's labeled "Contract Address:" line — never "first hash in the
# output", which on a *failed* deploy grabs the class hash quoted in the error message. So a failure
# leaves CONTRACT_ADDR empty and we exit without recording. Retry the one common transient: the
# freshly-declared class not yet visible to the RPC node ("... is not declared").
CONTRACT_ADDR=""
DEPLOY_TX=""
for attempt in 1 2 3 4; do
  DEPLOY_OUT="$(cd "$REPO_ROOT/cairo" && sncast --account "$ACCOUNT" deploy \
    --class-hash "$CLASS_HASH" --url "$RPC" 2>&1 || true)"
  echo "$DEPLOY_OUT"
  CONTRACT_ADDR="$(labeled_hash '^[[:space:]]*Contract Address:' "$DEPLOY_OUT" || true)"
  DEPLOY_TX="$(labeled_hash '^[[:space:]]*Transaction Hash:' "$DEPLOY_OUT" || true)"
  [[ -n "$CONTRACT_ADDR" ]] && break
  if [[ $attempt -lt 4 ]] && printf '%s' "$DEPLOY_OUT" | grep -qiE 'is not declared'; then
    echo "   class not visible to the RPC node yet (attempt $attempt/4) — waiting 15s, retrying ..." >&2
    sleep 15
    continue
  fi
  break  # a different, non-transient error — stop and report below
done
if [[ -z "$CONTRACT_ADDR" ]]; then
  echo "!! Deploy did not return a contract address — see output above. NOTHING was recorded." >&2
  echo "   The class IS declared ($CLASS_HASH); once its declare tx is visible, retry just the deploy:" >&2
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
