# `oracle/` — DRISL/CID differential oracle

The Rust leg of the three-way agreement check (`REFERENCE.md` §3, §5). It loads the vendored
DASL conformance vectors, recomputes each CID with `atproto-dasl`, and asserts it matches the
vector's expected output — the independent Rust authority that the Cairo `drisl` implementation
and the TS sidecar (`@did-plc/lib`, `@atcute/cbor`) must both agree with.

Three implementations, one set of inputs, run together by `make conformance`:

| Leg | Implementation | Authority for |
|---|---|---|
| Cairo | `cairo/packages/drisl` | the implementation under test |
| **Rust** | **`oracle/` (`atproto-dasl`)** | **DRISL / CID** |
| TS | `conformance/` sidecar (`@did-plc/lib`) | PLC-op validity / recovery |

> **Status: stub.** The binary currently confirms the vectors directory is present and
> well-formed; the `atproto-dasl` recompute is wired as `make conformance` matures. The
> authoritative differential CID checks today run through the Cairo tests + the TS sidecar
> (`conformance/README.md`). Keep this crate's `atproto-dasl` pin in lockstep with `ingest`'s
> (the shared workspace lockfile pins it).

## Running

```sh
cargo run --bin oracle      # report whether the conformance vectors are present
make conformance            # the full three-way agreement check (the consensus gate)
```
