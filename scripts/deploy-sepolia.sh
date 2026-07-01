#!/usr/bin/env bash
# Back-compat shim → the generalized deploy.sh on Sepolia.
# Prefer:  NETWORK=sepolia scripts/deploy.sh
exec env NETWORK=sepolia "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "$@"
