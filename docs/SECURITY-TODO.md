# Security review — findings & resolutions

A ledger of the security findings raised against DIDMARC and how each was resolved. Two rounds:
the **June 2026 internal audit** (items 1–6) and the **July 2026 design review** (4a–4c). All are
resolved; the substance lives in the code and in [`HISTORY.md`](HISTORY.md) /
[`REFERENCE.md`](../REFERENCE.md) — this file is the index the code comments cite by ID. The only
outstanding work is the one deliberately deferred item (4c), tracked in `HISTORY.md` follow-ups.

## July 2026 design review (4a–4c)

| id | sev | finding | resolution |
|---|---|---|---|
| **4a** | CRITICAL | `import` stamped backfilled ops with the import block time, giving the *entire* history a live 72h recovery window — so for 72h after onboarding a **rotated-out** higher-priority key could fork below the real history and capture the DID (and the anchor would then read `diverged` against an honest directory, the §0-forbidden false alarm). | **Fixed.** Imported ops are marked *settled* (`imported` flag) and a recovery may not nullify one (`recovery-of-imported`); ingest onboards via one settled `import` chain (`onboard_via_import`). *(verify-on-read update, 2026-07-02: the contract still records the `imported` flag; the guard is now **enforced read-side** by the witness — `deriveLiveChain`'s imported branch, mirror of `state::apply_op` — pinned in `witness-ts/test/nullified.test.ts`. The Cairo `state::apply_op` guard remains as the reference.)* Detail: `HISTORY.md` "Security fix 4a" + "Rearchitecture — verify-on-read"; `REFERENCE.md` §5. |
| **4b** | LOW | The read-side recovery re-derivation (`deriveLiveChain`) evaluates the 72h window using the directory-asserted `createdAt`; a hostile mirror could re-time a fork. | **Documented, no code change — faithful PLC.** `@did-plc/lib`'s `assureValidNextOp` uses the same directory clock, so changing the witness would *fork* the consensus-critical oracle. Bounded: signatures gate every fork, and the anchor's independent **block-time** confirmed head is the cross-check. Detail: `REFERENCE.md` §1 (read-path trust); `directory.ts`. |
| **4c** | MEDIUM | The witness reads anchor state via `starknet_call`, trusting the RPC. | **Documented; real fix deferred.** *(verify-on-read update, 2026-07-02: the Merkle root/proof are gone — the witness now reads the raw op log (`chain`) and re-derives the head; the op *contents* are content-addressed/trustless, but whether it's the DID's true/complete log still comes from the RPC.)* Trustless reads require a **Starknet storage proof against the L1-settled state root** — now over the op-log storage directly (Mode-2 infra; `HISTORY.md` follow-ups). Interim: run your own node, or trust your RPC. Detail: `REFERENCE.md` §1; `starknet.ts`. |

**Deployment consequence of 4a.** The `StoredOp` storage layout changed, so the pre-4a Sepolia
instance (`0x00816c…`) was superseded by a fresh **post-4a redeploy**
(`0x01e3cd42e8481a40b366ef32940e8bc050fd79c924c9b838a6dc0338a08fc5c3`, `deployments/sepolia.json`;
code defaults updated). The roster starts empty — re-import DIDs from genesis before live/mainnet.

## June 2026 internal audit (items 1–6)

| id | sev | finding | resolution |
|---|---|---|---|
| **1** | HIGH | The directory's `nullified` audit-log flag was trusted verbatim; a hostile directory could flip it to force a false `diverged`/`confirmed`. | **Fixed.** The witness discards the flag and re-derives PLC recovery locally from op contents (`deriveLiveChain` / `deriveNullified` + `crypto.ts`/`opverify.ts`), differential-green vs `@did-plc/lib`. |
| **2** | MEDIUM | `auditLog()` cast the HTTP body with no runtime validation or size bound; malformed fields flowed in as `undefined`/`NaN`. | **Fixed.** `parseAuditLog`/`isAuditEntry` (typed validation, hard error on malformed) + `readBoundedText` (streaming cap + `Content-Length` pre-check, 8 MiB). |
| **3** | MEDIUM | The ingest re-encoder (`json_to_ipld`) recursed with no depth limit and read unbounded response bodies. | **Fixed.** `MAX_DEPTH = 64`; `MAX_BODY_BYTES = 32 MiB` on both HTTP reads. |
| **4** | LOW | An unparseable `createdAt` silently defaulted to non-alarming, letting a malformed timestamp suppress `diverged` indefinitely. | **Fixed.** New explicit `error` status (`directory-timestamp-unparseable`), never absorbed into a verdict; CLI exit 1. |
| **5** | INFO | `verify.cairo` duplicated `submit_op`'s fork/authorization logic (silent-drift risk). | **Fixed.** Deleted `verify.cairo`; `state::apply_op` is the single path (`check_prev_link` kept as a tested standalone primitive). |
| **6** | INFO | Stale doc comment in `recovery.cairo` about the clock source. | **Fixed.** Corrected to distinguish `createdAt` (directory time) from `now` (block time in production). |
