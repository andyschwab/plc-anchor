#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Installs the toolchain the project needs so `make cairo-test` / `make conformance` work in
# a fresh remote container:
#   - Scarb (pinned in .tool-versions) — fetched from the GitHub release, because the official
#     installer host (docs.swmansion.com) is blocked by the egress policy.
#   - conformance JS deps (the differential oracle + vector generators).
#   - Rust workspace deps (toolchain pinned in rust-toolchain.toml) — pre-warmed.
#
# snforge is intentionally NOT installed: the committed test backend is the offline builtin
# `scarb cairo-test` (see cairo/TESTING.md), and snforge's proc-macro cdylib can't dlopen in
# this sandbox. Remote-only, idempotent, synchronous.
set -euo pipefail

# Only run in Claude Code on the web. Local devs use starkup/asdf (CLAUDE.md).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$PATH"

# ── Scarb (pinned in .tool-versions) ─────────────────────────────────────────
SCARB_VERSION="$(awk '/^scarb /{print $2}' "$PROJECT_DIR/.tool-versions" 2>/dev/null || echo 2.18.0)"
if ! command -v scarb >/dev/null 2>&1 || ! scarb --version 2>/dev/null | grep -q "scarb ${SCARB_VERSION}\b"; then
  echo "session-start: installing Scarb ${SCARB_VERSION} from GitHub release..."
  TARBALL="scarb-v${SCARB_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
  URL="https://github.com/software-mansion/scarb/releases/download/v${SCARB_VERSION}/${TARBALL}"
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/scarb.tar.gz" "$URL"
  tar xzf "$TMP/scarb.tar.gz" -C "$TMP"
  cp "$TMP"/scarb-*/bin/* "$BIN_DIR/"
  rm -rf "$TMP"
fi

# Persist PATH so scarb is available throughout the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# ── Conformance JS deps (differential oracle + vector generators) ─────────────
if [ -f "$PROJECT_DIR/conformance/package.json" ]; then
  npm install --prefix "$PROJECT_DIR/conformance" --no-audit --no-fund
fi

# ── Rust workspace (toolchain pinned in rust-toolchain.toml) ──────────────────
# `cargo fetch` installs the pinned toolchain (via rustup) and caches deps. Non-fatal.
if command -v cargo >/dev/null 2>&1; then
  (cd "$PROJECT_DIR" && cargo fetch) || echo "session-start: cargo fetch failed (non-fatal)"
fi

echo "session-start: ready — $(scarb --version 2>/dev/null | head -1), $(node --version 2>/dev/null)"
