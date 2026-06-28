# Cairo test backends

The Cairo tests run under one of two interchangeable backends. The committed
default is **offline**; switch to **snforge** on any machine with normal network
access.

| Backend | Dep | Runner | When |
|---|---|---|---|
| `offline` *(default)* | `cairo_test` (Scarb builtin) | `scarb cairo-test` | No registry access (sandbox, CI behind a proxy, the remote execution environment) |
| `snforge` | `snforge_std` | `snforge test` | Normal dev box with network; unlocks cheatcodes, fork tests, fuzzing |

The test **sources are identical** under both — they use only `#[test]` and
`assert!`, which both backends provide. Switching swaps the dev-dependency and
the runner, never the tests.

## Switching

```sh
make test-backend     # show the active backend
make test-snforge     # switch to real snforge
make test-offline     # switch back to the offline builtin
cd cairo && scarb build   # regenerate Scarb.lock for the new backend
```

`make cairo-test` and `make conformance` auto-detect the active backend (they
grep `cairo/Scarb.toml`), so the same command works either way.

The switch is just three manifest edits, done by
[`scripts/test-backend.sh`](scripts/test-backend.sh):

- `cairo/Scarb.toml` — the `[workspace.dependencies]` entry and the
  `[workspace.scripts] test` runner.
- `cairo/packages/{drisl,plc_core}/Scarb.toml` — the `[dev-dependencies]` entry.

## Why the offline default exists

`snforge_std` re-exports `snforge_scarb_plugin`, a Cairo **proc macro**. Scarb
loads proc macros as a `cdylib` via `dlopen` at compile time. In the offline
environment two things break that:

1. The `scarb` binary there is **static-musl** linked (`static-pie linked`,
   `x86_64-unknown-linux-musl`). A static-musl executable cannot `dlopen` shared
   objects at all — Scarb reports *"dlopen failed: Dynamic loading not
   supported."*
2. Even building a no-op stub plugin is impossible: the `x86_64-unknown-linux-musl`
   Rust target does not support the `cdylib` crate type.

So `snforge test` simply cannot run there, regardless of registry mirroring.
Scarb's builtin `cairo_test` provides the `#[test]` attribute with **no proc
macro and no registry fetch**, so it works in the sandbox. Since our tests don't
use any snforge-specific feature yet, the two backends are equivalent for the
current gate (10 tests: 8 `drisl` + 2 `plc_core` op_verify).

Revisit this when a test first needs a real snforge feature (a cheatcode, fork
state, or the fuzzer). At that point the offline backend can no longer run that
test, and CI must move to an environment where `snforge` is reachable.
