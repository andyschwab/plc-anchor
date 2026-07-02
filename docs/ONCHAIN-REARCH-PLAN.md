# On-chain rearchitecture plan — verify-on-read (RFC)

**Status: ADOPTED (2026-07-02) — implemented, offline-green, pending v2 Sepolia→mainnet deploy.**
This deliberately **reopened a `REFERENCE.md`-settled decision** ("verification runs as a Starknet
contract"; "crypto is a corelib library call" — REFERENCE.md §1/§2/§8, echoed in `CLAUDE.md` *Do
NOT relitigate*), driven by the measured mainnet cost evidence below. `REFERENCE.md` and `CLAUDE.md`
carry the amendment banners; this file is the rationale of record.

**As-built deltas from this proposal (see §7):** (1) the reader validates the anchor chain by
**content-addressed cross-reference** against op bodies it already fetches (no new on-chain DRISL
decoder — reuses `deriveLiveChain`); (2) the on-chain **Merkle root/proofs are dropped** (the
reader validates the whole per-DID chain, so per-DID inclusion proofs are redundant); (3) the
contract keeps a **cheap `sha256` DID derivation** (not EC crypto — negligible cost) so the
`import`/`submit_op` signatures and the `ingest` sink are unchanged; (4) the Cairo
`op_verify`/`recovery`/`state`/`merkle` modules are **retained as the differential-green PLC
reference** the read side mirrors (deleting them is a follow-up, not this change).

**Author context:** written 2026-07-02, immediately after the V1 mainnet bring-up (Phases 1–3 of
[`MAINNET-CHECKLIST.md`] live: contract `0x04db…d9aa`, one canary DID anchored & witnessed).

---

## 1. The finding that motivates this

We deployed to mainnet and measured real fees by decomposing tx receipts
(`l1_gas`/`l1_data_gas`/`l2_gas` × the block's per-unit prices):

| tx | total | l2_gas (execution) | l1_data_gas (storage/DA) |
|---|---|---|---|
| declare (class) | 84.78 STRK | **84.78 (100.0%)** | 0.0001 (192 units) |
| import, 1 DID / 4 ops | 27.60 STRK | **27.59 (100.0%)** | 0.0037 (8 928 units) |

**Data availability / on-chain storage is effectively free. The entire cost is Cairo
execution — and for an import that execution is the in-contract signature verification**
(secp256k1/secp256r1 ECDSA syscalls + sha256 + DRISL encoding). Per-DID cost ≈ (#ops) ×
(EC-verification), ≈ **6.9 STRK/op** measured. Extrapolated to the full 18 991-DID eurosky roster
that is **hundreds of thousands of STRK** — for what V1 explicitly is: a *backup witness*.

This inverts the intuition the original design was built on (that posting history to L1 for DA
is the cost). It is not. **We are paying Starknet to re-run crypto that the op log already
self-certifies.**

## 2. The thesis

> **Move verification from write-time (the contract) to read-time (the resolver/witness).**
> The contract stops doing EC crypto entirely and becomes a cheap, **non-equivocable log +
> commitment store**. Readers re-derive and validate the self-certifying chain off-chain, for
> free (their CPU, no gas).

Because DA is nearly free, we can afford to keep the **raw op bytes on-chain** as the
bulletin-board contents — no need to move data off-chain or add an availability dependency. The
contract's job shrinks to: *store what was submitted, expose it, and commit a root over it.* No
`sha256`/`secp256k1`/`secp256r1` syscalls on the write path.

Per-import cost then collapses from "~7 STRK/op of EC verification" toward "a storage write +
base tx overhead" (l1_data_gas is ~0.004 STRK for 4 ops; the residual is a small L2 base). Plausibly
a **10–50× reduction**, and **`import_append` batching compounds it** by amortizing the base tx
overhead across many DIDs. (Batching is already a tracked follow-up in `HISTORY.md`.)

## 3. What is preserved vs. what changes

**Preserved — the whole V1 value proposition (REFERENCE.md §1a):**
- **Non-equivocation.** The op bytes live on the public chain; everyone sees identical bytes.
- **Trustlessness.** A reader re-derives *everything* from the on-chain bytes — checks each
  signature, confirms the head, recomputes the root. A malicious submitter who posts a bogus
  chain is caught by *the reader's* validation (sigs won't verify / won't link), so a bad entry
  is **rejected by readers** instead of **rejected by the contract**. No trust in the submitter,
  no trust in us.
- **Unilateral reads, no coordination.** Unchanged — a resolver reads the anchor and cross-checks
  the directory on its own.
- **Golden rule "never a false `diverged`."** Preserved *because* readers validate: the anchored
  head is only treated as authoritative once the reader has verified the chain that produces it.

**Changes:**
1. **The contract no longer arbitrates validity or forks.** Today `op_verify` + `recovery` +
   `state::apply_op` run in-contract (the 72h higher-priority rule, tombstones,
   recovery-of-imported). In the new model the contract stores submitted ops verbatim and the
   **72h recovery adjudication moves read-side** (deterministic; the logic already exists in
   `witness-ts`/`ingest`, differential-green). This is the biggest semantic shift and the main
   risk surface.
2. **Anti-spam.** Write-time verification currently gates junk. Without it, a permissionless
   writer can store unverified/garbage ops (cheap DA, but storage bloat + they'd be rejected by
   readers anyway). Mitigations, in order of preference: (a) **operator-gated writes for V1** —
   the permissionless write path is *already* an explicit backstop, not the V1 headline
   (REFERENCE.md §1a), so gating writes to the console operator costs us nothing we were shipping;
   (b) a minimal, cheap on-chain sanity check (e.g. structural/CID well-formedness, *not* EC
   verification); (c) fee/stake friction.
3. **The reader becomes the source of truth for validity.** Fine — it already is on the read
   side, and the Cairo verification is a *duplicate* of logic that lives in `witness-ts`, `ingest`,
   and the references. We delete the expensive duplicate.

## 4. Design sketch

- **Contract (`anchor` v2):**
  - `submit(did, ops: Array<ByteArray>)` / `append(did, op)` — store bytes, update the DID→head
    pointer to the *submitted* tip, push into the roster root. **No crypto.** (Optionally a cheap
    structural check.)
  - Storage: keep `chains: Map<did, Vec<StoredOp{signed, created_at}>>` (DA is free) — drop the
    `signer_index`/verification-derived fields the contract no longer computes.
  - Root: keep the sha256-Merkle DID→head commitment (readers verify inclusion). The root is over
    *submitted* heads; readers validate the head before trusting it.
  - Views: `head_cid`, `chain(did)` (return the raw ops so readers can validate without re-fetching
    from the untrusted directory), `tentative_root`/`confirmed_root`.
  - **Two-tier confirmed/tentative (§4) stays**, but "confirmed" now means "on-chain ≥72h and no
    superseding submission the reader accepts," adjudicated read-side.
- **Reader (`witness-ts`):** gains the full chain-validation + 72h recovery adjudication it needs
  to treat an on-chain chain as authoritative. Most of this exists; the gap is the recovery-window
  arbitration currently only in Cairo. The `merkle.cairo`↔`verifyProof` byte-identity pin
  (gen-merkle-vectors) still applies to the root.
- **`ingest`:** stops needing `--features live` to run EC verification pre-submit for correctness
  (it still validates locally as a courtesy / to avoid posting junk), just submits bytes.

## 5. Open questions / risks (resolve before adopting)

1. **Read-side recovery adjudication.** Porting the 72h higher-priority + recovery-of-imported
   rules out of Cairo into the reader, and proving it differential-green against the current
   contract behavior on the adversarial suite. **This is the crux — do not adopt until this is
   green.**
2. **DoS via unvalidated writes.** Decide (a) operator-gated V1 vs (b) minimal on-chain sanity
   check. Leaning (a) since permissionless write is a backstop anyway.
3. **"Confirmed" semantics** without in-contract time arbitration — does block-time stamping on a
   raw-bytes store still give a sound 72h window read-side? (SECURITY-TODO 4a interplay: imported
   = settled must still be expressible.)
4. **Does any consumer need on-chain-*guaranteed*-valid heads** (not reader-validated)? For the
   witness, no. Confirm no other planned mode (availability/canonical-in-partition, §1a) silently
   assumes contract-side validity.
5. **Migration.** `anchor` is not upgradeable → v2 is a new class/address/empty roster; re-import
   is cheap (and about to get *much* cheaper). Same migration path the runbook already documents.

## 6. Recommendation

Pursue it — the evidence is decisive and it makes V1's economics match its role (a backup should
not cost six figures). But treat §5.1 (read-side recovery adjudication, differential-green) as a
hard gate, and land it as a `REFERENCE.md` amendment (§1/§2/§8) with sign-off, not a quiet change.
The current mainnet contract stays live and correct in the meantime; this is a v2, not a hotfix.

**Sequencing:** (1) prototype the verify-on-read reader path + port recovery adjudication, prove it
against the adversarial suite; (2) measure a "store-only" import on a testnet v2 to confirm the
10–50× cut; (3) amend REFERENCE.md; (4) v2 contract + re-import. None of this blocks leaving the
current V1 witness running as-is.

## 7. As-built (2026-07-02)

Implemented on `claude/rearchitecture-rfc-review-3ra7en`, **offline-green** (`witness-test`,
`console-test`, `rust-test`, `adversarial`); the Cairo contract + tests are written but need a
`make cairo-test` on a Scarb-equipped box (the sandbox has no toolchain), then the v2 deploy.

**§5.1 crux (read-side recovery adjudication) — resolved the cheap way.** The reader *already*
re-derives PLC recovery for the directory (`deriveLiveChain`, differential-green vs `@did-plc/lib`).
So the anchor chain runs through the **same** validator: `deriveLiveChain` gained an inert
`imported` guard (the read-side mirror of `state::apply_op`'s `recovery-of-imported`) and now
returns its live ops; `deriveAnchorHeads` (`status.ts`) feeds it the on-chain ops — bodies
cross-referenced content-addressed, `createdAt` = the anchor's block time — and derives the
confirmed head (latest live op past the 72h window). No new consensus module. Pinned in
`witness-ts/test/nullified.test.ts` (real signed chains, incl. the read-side recovery-of-imported).

**What shipped, by file:**
- `cairo/packages/plc_core/src/anchor.cairo` — store-only: `import_genesis`/`import`/`submit_op`
  push bytes (block-time + `imported`); new `chain(did)` view; dropped head/root/proof views + all
  EC verification. `tests/anchor.cairo` rewritten to the storage contract.
- `witness-ts` — `directory.ts` (generalized `deriveLiveChain` + `imported` guard + live ops);
  `status.ts` (`deriveAnchorHeads`, chain-based `AnchorView`, `deriveAnchor` seam); `starknet.ts`
  (`chain(did)` read via `decodeChain`, proof/root reads removed); `merkle.ts` deleted; `index.ts`.
- `ingest` — `starknet_sink.rs` gains `call_chain`/`StoredOpView`; sink calldata unchanged;
  `gen_selectors` → `{is_anchored, chain}`; `live_e2e.rs` asserts byte-identical storage.
- `adversarial` + `conformance/src/gen-adversarial-scenarios.mjs` — de-Merkled; read scenarios use
  the `deriveAnchor` seam; write scenarios reframed (defender = read-side re-derivation);
  `anchor-self-fault` reframed (corrupt on-chain log ⇒ no confirmed head ⇒ tentative-consistent).

**Open follow-ups (non-blocking):** delete the now-off-path Cairo `merkle`/`op_verify`/… modules +
their `gen-merkle-vectors` once v2 is proven live (kept for now as the differential reference);
optional storage-spam mitigation on the permissionless write path (operator-gating / fee friction —
readers already reject junk); the future trustless-root read (finding 4c) becomes a Starknet
storage proof over the op storage directly.
