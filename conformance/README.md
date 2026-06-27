# Conformance & differential harness

The single source of truth for correctness of the consensus-critical Cairo modules
(REFERENCE.md §3, §5). Three implementations must agree on the same inputs:

- **Cairo** (`cairo/packages/drisl`) — the implementation under test (snforge reads `vectors/`).
- **Rust oracle** (`oracle/`, `atproto-dasl`) — DRISL/CID authority.
- **TS sidecar** (this package, `@did-plc/lib`, `@atcute/cbor`) — authoritative PLC-op oracle.

`make conformance` runs the three-way agreement check. It is the acceptance gate for the
DRISL keystone and, once that lands, a required merge check.

## Vectors

### `vectors/dasl-cbor/` — DASL / dCBOR42 CID conformance
Vendored (copied, not submoduled — hermetic and PR-reviewable) from the DASL testing suite:

- **Source:** https://github.com/hyphacoop/dasl-testing — `fixtures/cbor/`
- **Commit:** `84a34aadfcf32ba548bb046d0403036c70313fa5`
- **Date:** 2026-06-15
- **License:** MIT, © Hypha Worker Co-operative Inc. (see `vectors/dasl-cbor/LICENSE`)
- **Count:** 104 test cases across cid / floats / map_keys / integer_range / indefinite /
  tags / simple / utf8 / short_form / numeric_reduction / concat.

Each case: `{ type: "roundtrip" | "invalid_in" | "invalid_out", data: <hex CBOR>, name, tags, desc }`.
Do **not** hand-edit vectors to make a test pass — regenerate from source and bump the commit
pin above. Weakening a vector to go green is a guardrail violation (see `CLAUDE.md`).

### `vectors/plc-ops/` — PLC operation fixtures
To be captured from `wss://plc.directory/export/stream` + `/export` (a sample plus a
hand-picked recovery/nullification scenario), frozen as regression fixtures for
`op_verify`/`recovery` and validated against `@did-plc/lib`. Currently empty.

## Refreshing vectors

```sh
git clone --depth 1 https://github.com/hyphacoop/dasl-testing /tmp/dasl-testing
cp /tmp/dasl-testing/fixtures/cbor/*.json conformance/vectors/dasl-cbor/
# then update the commit/date pin above
```
