#!/usr/bin/env bash
#
# Declare + deploy the `anchor` contract to Starknet Sepolia.
#
# WHY THIS EXISTS: build-order item 5 / P5.1 added the `tentative_proof` / `confirmed_proof`
# views. The `anchor` contract is NOT upgradeable (no `replace_class_hash` entrypoint — see
# REFERENCE.md §6, governance deferred), so shipping a contract change means declaring a NEW
# class and deploying a FRESH instance at a NEW address.
#
#   ⚠️  CONSEQUENCE: the new instance starts with an EMPTY roster. Any DID anchored on the old
#       instance must be re-imported, e.g.:
#         cargo run -p ingest --features live -- --did did:plc:<...> --submit
#       (Re-import is cheap and idempotent — the chain is self-certifying and replayed from
#       genesis.) On testnet this is fine; a mainnet design would add a governed upgrade path
#       first (REFERENCE.md §6).
#
# PREREQS (run locally — sncast is not in the agent sandbox):
#   - sncast 0.61.0 + a funded Sepolia account named `plc-sepolia` (snfoundry.toml).
#   - `declare` is rate-limited on the public dRPC endpoint, so pass a keyed 0.10.x RPC:
#         export STARKNET_RPC=https://<keyed-sepolia-0.10.x-endpoint>   # Alchemy/Infura/etc.
#
# USAGE:
#   STARKNET_RPC=https://<keyed-endpoint> scripts/deploy-sepolia.sh
#
# AFTER A SUCCESSFUL DEPLOY:
#   1. Record the new class hash + contract address in snfoundry.toml (the commented block).
#   2. Update the `ANCHOR_CONTRACT_ADDRESS` GitHub secret (used by e2e-sepolia.yml) and your
#      local witness config to the new address.
#   3. Re-import any DIDs you want anchored (see the consequence note above).
set -euo pipefail

: "${STARKNET_RPC:?set STARKNET_RPC to a keyed Sepolia 0.10.x endpoint (declare is rate-limited on public dRPC)}"
ACCOUNT="${SNCAST_ACCOUNT:-plc-sepolia}"
CONTRACT_NAME="anchor"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Building the Cairo workspace (sierra artifacts) ..."
( cd "$REPO_ROOT/cairo" && scarb build )

echo "==> Declaring '$CONTRACT_NAME' (account: $ACCOUNT) ..."
# `|| true`: a re-declare of an unchanged class exits non-zero with "already declared" — not
# fatal, we still want the class hash from the output.
DECLARE_OUT="$(cd "$REPO_ROOT/cairo" && sncast --account "$ACCOUNT" declare \
  --contract-name "$CONTRACT_NAME" --url "$STARKNET_RPC" 2>&1 || true)"
echo "$DECLARE_OUT"

CLASS_HASH="$(printf '%s\n' "$DECLARE_OUT" | grep -oiE '0x[0-9a-f]{60,64}' | head -n1 || true)"
if [[ -z "$CLASS_HASH" ]]; then
  echo "!! Could not parse a class hash from the declare output above." >&2
  echo "   If it says 'already declared', copy the existing class hash and run:" >&2
  echo "     sncast --account $ACCOUNT deploy --class-hash <CLASS_HASH> --url \$STARKNET_RPC" >&2
  exit 1
fi
echo "==> class hash: $CLASS_HASH"

echo "==> Deploying an instance (no constructor — auth is the op's embedded sig, §2) ..."
DEPLOY_OUT="$(cd "$REPO_ROOT/cairo" && sncast --account "$ACCOUNT" deploy \
  --class-hash "$CLASS_HASH" --url "$STARKNET_RPC" 2>&1)"
echo "$DEPLOY_OUT"

CONTRACT_ADDR="$(printf '%s\n' "$DEPLOY_OUT" | grep -oiE '0x[0-9a-f]{60,64}' | head -n1 || true)"
echo
echo "============================================================"
echo " Deployed. NEXT STEPS (see header):"
echo "   class hash:       $CLASS_HASH"
echo "   contract address: ${CONTRACT_ADDR:-<see output above>}"
echo "   - update snfoundry.toml + the ANCHOR_CONTRACT_ADDRESS secret"
echo "   - re-import DIDs onto the fresh (empty) roster"
echo "============================================================"
