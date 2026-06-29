#!/usr/bin/env bash
# Switch the Cairo test backend between two environments.
#
#   offline  — Scarb's builtin `cairo_test`. No registry access required.
#              Use where scarbs.xyz:443 is unreachable (sandboxed/CI proxy,
#              this remote execution environment). The DEFAULT committed state.
#   snforge  — real Starknet Foundry (`snforge_std` + `snforge test`). Use in a
#              normal dev environment with network access. Unlocks cheatcodes,
#              fork tests, fuzzing — anything beyond plain `#[test]`/`assert!`.
#
# WHY THIS EXISTS: `snforge_std` pulls in the `snforge_scarb_plugin` proc macro,
# a cdylib that Scarb loads via dlopen. The Scarb binary in the offline
# environment is static-musl linked and cannot dlopen, and musl can't even
# produce a cdylib to stub it — so `snforge test` is unusable there. The test
# SOURCES are backend-agnostic (only `#[test]` + `assert!`), so we swap the
# dependency + runner, not the tests. See cairo/TESTING.md.
#
# Usage:  cairo/scripts/test-backend.sh [offline|snforge|status]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the cairo/ dir
ws="$here/Scarb.toml"
pkgs=("$here/packages/drisl/Scarb.toml" "$here/packages/plc_core/Scarb.toml")

current() {
  if grep -q '^snforge_std' "$ws"; then echo snforge; else echo offline; fi
}

case "${1:-status}" in
  status)
    echo "test backend: $(current)"
    ;;
  offline)
    sed -i 's/^snforge_std = "0.61.0"/cairo_test = "2.18.0"/' "$ws"
    sed -i 's/^test = "snforge test"/test = "cairo-test"/' "$ws"
    for p in "${pkgs[@]}"; do
      sed -i 's/^snforge_std\.workspace = true/cairo_test.workspace = true/' "$p"
    done
    echo "switched to: offline (scarb cairo-test)"
    echo "next: cd cairo && scarb build   # regenerates Scarb.lock"
    ;;
  snforge)
    sed -i 's/^cairo_test = "2.18.0"/snforge_std = "0.61.0"/' "$ws"
    sed -i 's/^test = "cairo-test"/test = "snforge test"/' "$ws"
    for p in "${pkgs[@]}"; do
      sed -i 's/^cairo_test\.workspace = true/snforge_std.workspace = true/' "$p"
    done
    echo "switched to: snforge (snforge test)"
    echo "next: cd cairo && scarb build   # fetches snforge_std, regenerates Scarb.lock"
    ;;
  *)
    echo "usage: $0 [offline|snforge|status]" >&2
    exit 2
    ;;
esac
