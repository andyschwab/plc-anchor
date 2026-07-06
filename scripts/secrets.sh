#!/usr/bin/env bash
#
# Re-sync one network's operator secrets to its DEPLOYED runtime with a single NETWORK switch.
# Each secret has exactly one home; this pushes the right subset to the right place:
#
#   NETWORK=mainnet scripts/secrets.sh push-fly  → fly secrets import → the console app (prod)
#   NETWORK=sepolia scripts/secrets.sh push-fly  → fly secrets import → the console app (testnet)
#   NETWORK=sepolia scripts/secrets.sh push-gh   → gh secret set → the e2e-sepolia.yml job
#   NETWORK=<net>   scripts/secrets.sh show      → presence-only audit (never prints a secret value)
#
# WHERE EACH VALUE COMES FROM (one home apiece — no hand-copies to go stale):
#   STARKNET_RPC                  ← secrets/<net>.env      (the keyed endpoint; the only real input)
#   CONSOLE_ADMIN_TOKEN           ← secrets/<net>.env      (generated once; push-fly only)
#   ANCHOR_CONTRACT_ADDRESS       ← deployments/<net>.json (derived here, at push time)
#   STARKNET_ACCOUNT_ADDRESS      ← sncast plc-<net>       (derived here)
#   STARKNET_ACCOUNT_PRIVATE_KEY  ← sncast plc-<net>       (derived here; never in any env file)
#
# The two addresses are DERIVED from their canonical sources rather than read from secrets/<net>.env,
# so a redeploy can't leave a stale copy in the pushed secret. If the env file still carries an old
# copy that disagrees, this warns and uses the canonical value.
#
# GitHub gets Sepolia-only secrets — mainnet is NEVER pushed to GitHub, so CI can never spend real
# funds (push-gh refuses mainnet). Needs: jq, flyctl (push-fly/show), gh (push-gh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/starknet-common.sh
source "$HERE/lib/starknet-common.sh"
resolve_network

warn() { echo "!! $*" >&2; }
die()  { echo "!! $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found — $2"; }

ENV_FILE="$REPO_ROOT/secrets/$NETWORK.env"

# Source the per-network env file (STARKNET_RPC + CONSOLE_ADMIN_TOKEN). Capture any *_ADDRESS copies
# it still carries so we can warn if they've drifted from the canonical sources.
load_env() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — cp secrets/$NETWORK.env.example secrets/$NETWORK.env and fill it in."
  ENV_ANCHOR=""; ENV_ACCT=""
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  ENV_ANCHOR="${ANCHOR_CONTRACT_ADDRESS:-}"
  ENV_ACCT="${STARKNET_ACCOUNT_ADDRESS:-}"
}

# Populate ANCHOR / ACCT / KEY from the canonical sources (empty if unavailable — callers guard).
# Warns if the env file's stale copy disagrees.
resolve_derived() {
  need jq "needed to read deployments/*.json + the sncast accounts file"
  ANCHOR="$(anchor_contract_address || true)"
  ACCT="$(account_address || true)"
  KEY="$(account_private_key || true)"
  if [ -n "${ENV_ANCHOR:-}" ] && [ -n "$ANCHOR" ] && [ "$ENV_ANCHOR" != "$ANCHOR" ]; then
    warn "secrets/$NETWORK.env ANCHOR_CONTRACT_ADDRESS ($ENV_ANCHOR) is stale — using deployments/$NETWORK.json ($ANCHOR)."
  fi
  if [ -n "${ENV_ACCT:-}" ] && [ -n "$ACCT" ] && [ "$ENV_ACCT" != "$ACCT" ]; then
    warn "secrets/$NETWORK.env STARKNET_ACCOUNT_ADDRESS ($ENV_ACCT) is stale — using sncast $ACCOUNT ($ACCT)."
  fi
}

require_derived() {
  [ -n "$ANCHOR" ] || die "no anchor address in $DEPLOYMENTS_FILE — deploy first (scripts/deploy.sh)."
  [ -n "$ACCT" ] && [ -n "$KEY" ] || die "could not resolve operator account '$ACCOUNT' from $ACCOUNTS_FILE (address/key). Create it: NETWORK=$NETWORK scripts/wallet.sh create."
}

cmd="${1:-help}"
case "$cmd" in
  push-fly)
    confirm_mainnet
    need fly "install flyctl (https://fly.io/docs/flyctl/install)"
    load_env
    resolve_derived
    require_derived
    : "${STARKNET_RPC:?set STARKNET_RPC in $ENV_FILE (the keyed $NETWORK endpoint)}"
    : "${CONSOLE_ADMIN_TOKEN:?set CONSOLE_ADMIN_TOKEN in $ENV_FILE (openssl rand -hex 32) — the console fail-closes writes without it}"
    echo "==> [$NETWORK] pushing 5 secrets → fly app '$FLY_APP' (one import = one restart) ..." >&2
    # `fly secrets import` reads KEY=VALUE lines from stdin and applies them atomically.
    printf '%s\n' \
      "STARKNET_RPC=$STARKNET_RPC" \
      "ANCHOR_CONTRACT_ADDRESS=$ANCHOR" \
      "STARKNET_ACCOUNT_ADDRESS=$ACCT" \
      "STARKNET_ACCOUNT_PRIVATE_KEY=$KEY" \
      "CONSOLE_ADMIN_TOKEN=$CONSOLE_ADMIN_TOKEN" \
      | fly secrets import --app "$FLY_APP"
    echo "==> done. Audit names: NETWORK=$NETWORK scripts/secrets.sh show" >&2
    ;;

  push-gh)
    # Sepolia only — mainnet operator secrets must never reach GitHub (CI must never spend real funds).
    [ "$NETWORK" = "sepolia" ] || die "push-gh is Sepolia-only — refusing to push $NETWORK secrets to GitHub (CI must never hold mainnet funds)."
    need gh "install the GitHub CLI (https://cli.github.com) and 'gh auth login'"
    load_env
    resolve_derived
    require_derived
    : "${STARKNET_RPC:?set STARKNET_RPC in $ENV_FILE (the keyed sepolia endpoint)}"
    echo "==> [sepolia] setting 4 secrets on the repo for e2e-sepolia.yml ..." >&2
    # Target the current repo (gh infers from the git remote; override with GH_REPO if needed).
    gh secret set STARKNET_RPC                 --body "$STARKNET_RPC"
    gh secret set ANCHOR_CONTRACT_ADDRESS      --body "$ANCHOR"
    gh secret set STARKNET_ACCOUNT_ADDRESS     --body "$ACCT"
    gh secret set STARKNET_ACCOUNT_PRIVATE_KEY --body "$KEY"
    # WITNESS_LIVE_DID is a NON-secret repo variable (the adversarial-live target DID). Optional:
    # if unset the DID-specific scenarios skip (only the unanchored→absent check runs). Pass it
    # inline: WITNESS_LIVE_DID=did:plc:… NETWORK=sepolia scripts/secrets.sh push-gh
    if [ -n "${WITNESS_LIVE_DID:-}" ]; then
      gh variable set WITNESS_LIVE_DID --body "$WITNESS_LIVE_DID"
      echo "==> set repo variable WITNESS_LIVE_DID=$WITNESS_LIVE_DID" >&2
    else
      echo "note: WITNESS_LIVE_DID unset — DID-specific adversarial-live scenarios will skip. Set it inline to enable." >&2
    fi
    echo "==> done." >&2
    ;;

  show)
    # Presence-only audit. Public addresses are printed (they're on-chain); the RPC (keyed), the
    # admin token, and the private key are reported present/MISSING only — never their value.
    [ -f "$ENV_FILE" ] && load_env || warn "no $ENV_FILE yet (cp the .env.example)."
    resolve_derived || true
    present() { [ -n "${1:-}" ] && echo "present" || echo "MISSING"; }
    echo "== [$NETWORK] resolved config (local sources) =="
    echo "  STARKNET_RPC                 $(present "${STARKNET_RPC:-}")   (secrets/$NETWORK.env)"
    echo "  CONSOLE_ADMIN_TOKEN          $(present "${CONSOLE_ADMIN_TOKEN:-}")   (secrets/$NETWORK.env)"
    echo "  ANCHOR_CONTRACT_ADDRESS      ${ANCHOR:-MISSING}   (deployments/$NETWORK.json)"
    echo "  STARKNET_ACCOUNT_ADDRESS     ${ACCT:-MISSING}   (sncast $ACCOUNT)"
    echo "  STARKNET_ACCOUNT_PRIVATE_KEY $(present "${KEY:-}")   (sncast $ACCOUNT)"
    echo "  → fly app: $FLY_APP"
    if command -v fly >/dev/null 2>&1; then
      echo "== fly secrets (names/digests only) on '$FLY_APP' =="
      fly secrets list --app "$FLY_APP" 2>&1 || warn "could not list fly secrets (app not created / not logged in?)"
    fi
    if [ "$NETWORK" = "sepolia" ] && command -v gh >/dev/null 2>&1; then
      echo "== gh secrets (names only) =="
      gh secret list 2>&1 || warn "could not list gh secrets (not authed?)"
    fi
    ;;

  help | *)
    echo "usage: NETWORK=sepolia|mainnet scripts/secrets.sh {push-fly|push-gh|show}"
    echo "  push-fly  push 5 secrets → the network's fly console app ($FLY_APP)"
    echo "  push-gh   push 4 secrets → GitHub repo (SEPOLIA ONLY) for e2e-sepolia.yml"
    echo "  show      presence-only audit of local sources + remote secret names"
    ;;
esac
