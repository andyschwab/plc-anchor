# PLC Anchor — Project Reference

> Working name: **PLC Anchor** (placeholder). A censorship-resistant, cryptographically-verifiable anchor for the AT Protocol DID PLC operation log, built as a Starknet validity rollup / appchain.
>
> **How to use this doc:** drop it in the repo root as `REFERENCE.md` (or seed `CLAUDE.md` from the "Build order" and "Conventions" sections). It captures the design decisions, their rationale, the measured facts, and the spec sources, so a coding agent doesn't relitigate settled choices or hallucinate the protocol details. Verify the load-bearing numbers (see "Measured facts") before relying on them — some are point-in-time.

---

## 1. What this is, and what it is not

PLC (Public Ledger of Credentials) is the default DID method for atproto. Every account's identity is a signed, hash-linked log of operations served from a single directory (`plc.directory`), operated by Bluesky PBC. The directory is never trusted for *correctness* — every op is self-certifying (the DID is the hash of its genesis op; each op references its predecessor by hash and is signed by a then-valid rotation key) — but it **is** trusted for **availability, ordering, and timestamping**. That single-operator trust is the chokepoint.

**This project builds an anchor, not a replacement.** It does not run the directory. It:

1. Consumes the op log from an existing mirror.
2. Re-verifies and folds the log in Cairo, producing a **proven** commitment (state root) to the current DID→document mapping.
3. Provides an **alternative, censorship-resistant write path** via Ethereum→Starknet messaging (L1 force-inclusion), so no anchor operator can suppress a valid op.
4. Lets resolvers cross-check the directory against a trust-minimized, independently-verifiable root.

It does **not** by itself make PLC decentralized. It removes the single-party trust assumptions for *availability, ordering, and verifiable state*, and gives censored users an escape hatch. Adoption (resolvers actually reading the anchor) is the success condition; an anchor nobody checks is theater.

### Risk surface (explicit)

Because this is a **validity rollup**, the state transition is *proven*, not optimistically assumed. The resolved DID documents are correct by construction. The residual trust we knowingly accept is narrow:

- **Ordering** — per-DID linearization of operations. (Cross-DID order is irrelevant; DIDs are independent.)
- **Timestamp** — the `createdAt` that drives PLC's 72-hour recovery/nullification window. PLC currently relies on the directory's server clock; we relax this to "report it pragmatically" (see §6).

We do **not** relax per-op validity. That is proven.

---

## 2. Measured facts (verify before depending on these)

Point-in-time measurements taken June 2026 against the live directory and an OP-stack gas oracle. Re-measure; they move.

- **Total operations:** ~**105.2M** (max sequence number from `wss://plc.directory/export/stream`). This is the full audit log incl. nullified/forked ops and mass-registration spam (e.g. `pds.trump.com` registered 17M+ junk DIDs).
- **Per-op size:** legacy `create` ops ~330 B; modern `plc_operation` ops ~1.4–2.0 KB (multiple rotation keys, verification methods, service endpoints). Bimodal.
- **Full directory size:** ~50–115 GB depending on encoding (DRISL/dag-cbor canonical vs. JSON export).
- **Op rate:** ~1 op/sec average over the directory's lifetime. DA and proving costs at this volume are rounding error.
- **DA cost reference:** ~$0.02/MB measured on Optimism (`GasPriceOracle.getL1Fee`, `0x420…000F`) at near-floor blob fees. Sensitive to the blob-fee market (1–2 orders of magnitude under congestion).
- **Curves:** PLC rotation and verification keys are **secp256k1** or **secp256r1 (NIST P-256)**, did:key-encoded. Both are native in Cairo.
- **Hashing / encoding:** CIDs are **sha-256** (multihash `0x12`, 32 bytes) over **DRISL/dag-cbor** (codec `0x71`); `raw` is `0x55`. This is the DASL blessed set.
- **Recovery window:** 72 hours. Within the window a higher-priority rotation key can nullify a lower-priority op (this is the fork/recovery mechanism).

---

## 3. Why Starknet specifically

Not vendor preference — three concrete fits:

1. **Native curve support.** Cairo's corelib has both secp256k1 and secp256r1 (P-256 is present because Starknet does WebAuthn/passkey accounts). In-circuit verification of a PLC op signature is a library call, not a hand-rolled SNARK circuit over a foreign curve — which is the expensive, bug-prone part everywhere else. Garaga covers anything exotic.
2. **Validity proofs (STARK).** The fold is *proven*, so the resolved state is trustless, not "trust unless challenged." This is what collapses the risk surface to ordering + timestamp (§1). Succinct verification on Ethereum L1; STARKs are post-quantum by design, which matters for a long-horizon identity/key system.
3. **Native account abstraction.** A user's *existing PLC rotation key* (secp256k1/p256) can authorize their on-chain op submission directly via a custom account contract — the PLC key **is** the Starknet signer, no second keypair.

**Prover:** S-two (Stwo) is live on Starknet mainnet, fully open source, integrable via `crates.io`. Use `stwo-cairo` for proving Cairo VM execution and `proving-utils` for bootloader/aggregation.

**Appchain vs. public L2:** the cost case for an appchain is weak here (volume is trivial). The case is governance — owning the sequencer set / settlement contract for credible neutrality. Decide deliberately (§7). If appchain: **SN Stack** (StarkWare sequencer flavor) or **Madara** (`madara-alliance/madara`), **rollup mode with Ethereum blob DA** — not validium, because strong availability is the entire premise.

> Caveat: an appchain inherits Starknet's *tech*, not public Starknet's decentralized sequencer rotation. Censorship resistance must therefore come from the L1 escape hatch (§5.5), not from the sequencer.

---

## 4. Architecture overview

```
  ┌─────────────────┐   op log (websocket /export/stream)
  │  PLC mirror      │ ─────────────────────────────┐
  │ (Eurosky /       │                              ▼
  │  microcosm /own) │                    ┌──────────────────────┐
  └─────────────────┘                     │  Ingestion service    │
                                          │  (off-chain)          │
  ┌─────────────────┐  force-include op   │  - normalize          │
  │  Censored user   │ ──────────┐        │  - feed prover/seq    │
  └─────────────────┘            ▼        └──────────┬───────────┘
                       ┌──────────────────┐          │
                       │ L1 StarknetMsg    │          ▼
                       │ (Ethereum)        │   ┌────────────────────────┐
                       │ escape hatch      │──▶│  Cairo core (on-chain)  │
                       └──────────────────┘   │  - DRISL/CID verify     │
                                              │  - sig verify (k1/p256) │
                                              │  - prev linkage         │
                                              │  - recovery/nullify SM  │
                                              │  - per-DID head         │
                                              │  - confirmed/tentative  │
                                              │    state roots          │
                                              └──────────┬─────────────┘
                                                         │ STARK proof
                                                         ▼
                                              ┌────────────────────────┐
                                              │  Ethereum L1 settlement │
                                              │  verify proof + root    │
                                              └────────────────────────┘
                                                         │
                                                         ▼
                                              resolvers verify root + inclusion proof
```

---

## 5. Components to build

### 5.1 DRISL / DASL CID in Cairo — **the keystone**

The single highest-risk, highest-value module. Everything composes around it.

- Port **DRISL** (Deterministic Representation for Interoperable Structures and Links — DASL's dag-cbor profile, aka dCBOR42) canonical encoding to Cairo.
- Port **DASL CID** derivation: sha-256 over DRISL bytes, with the blessed multihash/codec metadata.
- Cairo has **sha-256** (syscall/corelib) — do **not** hand-roll the hash.
- DASL is a *deliberately minimal, deterministic* strict subset of IPLD/IPFS CIDs. This is the point: it exists to kill the "multiple CIDs for the same input" ambiguity that makes reimplementation dangerous. One blessed config, reject everything else.
- **Differential oracle:** the DASL conformance suite / compliance matrix. Get the Cairo encoder green against those vectors. This is the acceptance test for the module and a precondition for everything downstream.

Spec sources: `https://dasl.ing/` (cid.html, dcbor42.html), `https://atproto.com/specs/data-model`. Reference impls to differential-test against: `github.com/hyphacoop/go-dasl`, `docs.rs/atproto-dasl`, `@atcute/cbor` (npm).

### 5.2 PLC operation verification

Implements the PLC op state machine faithfully. This is a *consensus-critical* reimplementation — any divergence from the reference impl is a fork.

- Op types: genesis (`plc_operation`), updates, legacy `create`, and `tombstone` (deactivation).
- Signature verification: secp256k1 / secp256r1 over the DRISL-encoded unsigned op. did:key parsing for rotation + verification keys.
- `prev` hash-linkage validation (references predecessor op CID).
- **Recovery / nullification:** within the 72h window, a higher-priority rotation key can sign an op that nullifies a lower-priority branch. The fold must apply this, not just check signatures in isolation.
- Constraints from spec: max 10 verificationMethods/DID; rotation-key format rules; op-rate limits are directory-side (not our concern).

Spec sources: `https://web.plc.directory/spec/v0.1/did-plc`, `github.com/did-method-plc/did-method-plc`. Export/seq/websocket API: `github.com/bluesky-social/atproto/discussions/4508`.

### 5.3 State commitment

- Per-DID head (latest confirmed op CID + materialized document fields).
- A commitment over the DID→document map (Merkle or Verkle root). Resolution = root + inclusion proof.
- **Two-tier roots** for the 72h window (§6).

### 5.4 Genesis replay (the "all at once" decision)

Goal: a genesis root **proven** to be the correct fold of the entire signed history — no trusted snapshot.

- **DID-sharded:** each DID's op chain is independent → parallelize across DIDs, prove per-DID subtrees, aggregate. Maps directly onto S-two proof aggregation. Embarrassingly parallel; wall-clock is a function of cores.
- Cost is **off-chain prover compute**, one-time. On-chain is one aggregated proof verify + one root post (trivial).
- **GO/NO-GO GATE — do this first:** prove a single representative op end-to-end in Cairo on S-two; read step count + wall-time; multiply by 105M. Total ≈ (steps/op) × 105M × (prover $/step). Estimate band: low-thousands to low-tens-of-thousands USD of cloud proving, ~10× uncertainty — the one-op benchmark collapses it.
- **Fallback if benchmark says no:** cheap checkpoint root (commit to "canonical log through seq N," falsifiable by anyone replaying off-chain against a mirror) and prove *forward* from there. The data is self-certifying and widely mirrored, so a checkpoint is already falsifiable; proven genesis buys "nobody ever has to trust the snapshot" — value is as much political as technical for a credibly-neutral anchor.

### 5.5 L1 escape hatch (censorship resistance — the actual guarantee)

- An Ethereum contract accepts a PLC op and emits an L1→L2 message; the Starknet core processes it via an `l1_handler` entrypoint. Once posted to L1, inclusion is backed by Ethereum's own censorship resistance.
- This is the **real** CR mechanism. The sequencer is a convenience/performance layer; correctness and inclusion do not depend on it.
- Design the L1 path as canonical fallback, not an afterthought. Mirror the eu-haul op-submission + recovery-key UX for the user-facing flow (same primitive).

### 5.6 Governance & upgradeability (see §7)

### 5.7 Ingestion service (off-chain)

- Consume `wss://plc.directory/export/stream` (or a mirror's equivalent) using sequence-number cursors.
- Normalize, batch, feed the prover/sequencer.
- Language: Rust (aligns with stwo / atproto-dasl) or TS (aligns with eurosky/atcute tooling). Lean Rust for the proving path.

### 5.8 Resolver-side verification library

- Given a DID, return the document + a proof against the published root, with a confirmed/tentative flag.
- Must be cheap enough that a resolver treats the anchor as a trust-minimized cross-check against the directory. Without this, adoption fails.

---

## 6. The 72h window — confirmed/tentative tiers

Operationalizes "be pragmatic about the recovery window":

- **Confirmed root:** commits ops *past* the 72h recovery window. Immutable. This is what resolvers treat as final.
- **Tentative tip:** within-window ops, still subject to nullification by a higher-priority key. Carried separately and flagged.
- Resolvers reading the anchor get an explicit confirmed/tentative status rather than a silently-revisable root. This also avoids the dual-finality trap (never commit a finalized root you later have to rewrite).

---

## 7. Governance: multisig → timelock → maturity-gated freeze

Pattern: SAFE-style multisig admin during a mutable window, then permanent immutability. On Starknet:

- Upgrades are native via **`replace_class_hash`** (class-swap, not an EVM proxy). "Freeze" = a one-way storage flag that permanently disables the upgrade entrypoint.
- Multisig is an account contract under native AA (OpenZeppelin Cairo multisig component, or Argent/Braavos multisig).
- **Timelock** on upgrades during the mutable window so even signers can't act instantly or quietly.

Two constraints that shape the design:

1. **Freeze on a maturity gate, not a calendar.** An immutable contract with a dCBOR/spec bug is a permanent consensus fork. Trigger the freeze on competence milestones: DASL conformance suite green in Cairo; N months of zero divergence differentially testing the fold against the reference impl + a live mirror; independent audit. Pre-commit the *path* to immutability for credibility; condition the *act* on the milestones.
2. **Immutability fights PLC's own evolution.** The data-model spec states more blessed CID hash types are likely, and DASL CIDs are explicitly extensible. A fully-rigid frozen verifier can't follow a PLC spec change. **Scope the frozen core narrowly** (proof verifier + root commitment) and either parameterize the blessed-set or keep op-validation rules in a separately-governed, still-minimal module. Choose the seam deliberately.

**Credible neutrality lives in the signer set.** During the mutable window the multisig signers *are* the trust root. A geographically/organizationally diverse coalition (Eurosky, microcosm, others) holding keys, with the pre-committed freeze, is how you avoid recreating the chokepoint one layer up.

---

## 8. Ecosystem leverage (Eurosky / microcosm)

- **Ingestion feed:** Eurosky already mirrors the did:plc directory and runs its own firehose on EU infrastructure; microcosm hosts independent PLC mirrors. Either is a drop-in feed — don't run the directory.
- **Write-path UX:** eu-haul already submits PLC operations and surfaces rotation/recovery keys to users. Reusable for the escape-hatch flow (same primitive).
- **Modular stack:** `eurosky-social/u-at-proto` is modular Docker compose with a `plc/` service; an anchor-indexer slots in as another module mirrors run alongside.
- **Constituency:** a sovereignty-motivated coalition (Free Our Feeds origin; EU-Commission migration concerns; W Social closed-source anxiety) that actively wants a PLC anchor not controlled by Bluesky PBC. This is the operator/governance coalition — the hard part of credible neutrality, half-solved.

Repos: `github.com/eurosky-social` (`u-at-proto`, `eu-haul`). Mirror context: `atproto.com/blog/introducing-hubble-a-public-mirror-for-the-whole-atmosphere`.

---

## 9. Build order (critical path)

1. **Benchmark one op** end-to-end in Cairo on S-two → prices the genesis replay → go/no-go on "all at once" (§5.4).
2. **DRISL + DASL CID in Cairo**, green against the conformance suite (§5.1). *Long pole. Precondition for everything.*
3. **PLC op verification + recovery state machine** (§5.2), differential-tested against the reference impl on a live mirror feed.
4. **State commitment + confirmed/tentative roots** (§5.3, §6).
5. **Genesis replay** (DID-sharded, aggregated) per the §5.4 decision.
6. **L1 escape hatch** `l1_handler` + Ethereum submission contract (§5.5).
7. **Settlement/appchain wiring** — rollup mode, blob DA; appchain (Madara/SN Stack) vs. public-L2 decision (§3, §7).
8. **Governance**: multisig + timelock + freeze flag; define maturity gate; assemble signers (§7).
9. **Resolver verification library** (§5.8) — the adoption surface.

---

## 10. Suggested repo layout

```
plc-anchor/
├── REFERENCE.md                 # this document
├── CLAUDE.md                    # agent conventions (seed from §9 + Conventions)
├── cairo/
│   ├── Scarb.toml
│   ├── src/
│   │   ├── drisl.cairo          # DRISL/dCBOR42 canonical encoding (keystone)
│   │   ├── cid.cairo            # DASL CID derivation (sha-256)
│   │   ├── op_verify.cairo      # sig (k1/p256) + linkage
│   │   ├── recovery.cairo       # 72h nullification state machine
│   │   ├── state.cairo          # per-DID head + confirmed/tentative roots
│   │   ├── escape_hatch.cairo   # l1_handler force-inclusion
│   │   └── governance.cairo     # multisig gate + one-way freeze
│   └── tests/                   # snforge; DASL conformance vectors as fixtures
├── prover/                      # stwo-cairo + proving-utils; DID-sharded replay + aggregation
├── ingest/                      # mirror /export/stream consumer (Rust)
├── l1/                          # Ethereum submission + settlement contracts
├── resolver/                    # client-side root + inclusion-proof verification
└── conformance/                 # vendored DASL test vectors + differential harness
```

---

## 11. Tooling / stack

- **Cairo** (2.x) · **Scarb** (build) · **Starknet Foundry / `snforge`** (contract tests).
- **S-two**: `starkware-libs/stwo`, `stwo-cairo`, `proving-utils` (bootloader/aggregation).
- **Curves**: corelib secp256k1 + secp256r1; **Garaga** for exotic EC.
- **Hash**: Cairo sha-256 syscall.
- **L1↔L2**: Starknet messaging (`StarknetMessaging` contract, `l1_handler`).
- **Appchain (if chosen)**: Madara (`madara-alliance/madara`) or SN Stack RaaS; rollup mode, Ethereum blob DA.
- **DASL refs**: `hyphacoop/go-dasl`, `atproto-dasl` (Rust), `@atcute/cbor`.

---

## 12. Open questions / risks

- **DRISL-in-Cairo fidelity** (§5.1) — the dominant implementation risk. Mitigated by DASL's minimal deterministic surface + conformance suite, but consensus-critical.
- **Genesis cost** (§5.4) — unmeasured until the one-op benchmark. Gates "all at once."
- **Frozen-core scope** (§7) — immutability vs. PLC evolution. Get the seam right before freezing.
- **Sequencer/operator model** (§3, §7) — appchain CR is DIY; L1 escape hatch is the guarantee, not the sequencer.
- **Resolver adoption** (§5.8) — without it, the anchor is an expensive mirror. The verification library must be cheap.
- **Governance of upgrades** — admin key is the centralization vector PLC people will scrutinize hardest; decide early.

---

## 13. Canonical references

- PLC spec: `https://web.plc.directory/spec/v0.1/did-plc`
- PLC method repo: `https://github.com/did-method-plc/did-method-plc`
- PLC export/seq/websocket API: `https://github.com/bluesky-social/atproto/discussions/4508`
- atproto DID spec: `https://atproto.com/specs/did`
- atproto data model (DASL alignment): `https://atproto.com/specs/data-model`
- DASL: `https://dasl.ing/` · CID `https://dasl.ing/cid.html` · dCBOR42 `https://dasl.ing/dcbor42.html`
- Stwo / S-two: `https://github.com/starkware-libs/stwo`
- SN Stack / appchains: `https://www.starknet.io/blog/sn-stack-announcement/`
- Madara: `https://github.com/madara-alliance/madara`
- Eurosky: `https://github.com/eurosky-social`
- Hubble / mirrors: `https://atproto.com/blog/introducing-hubble-a-public-mirror-for-the-whole-atmosphere`

---

*Scope discipline: this is an anchor — censorship-resistant write path + proven, verifiable state — not a PLC replacement. Keep the frozen core minimal, keep the escape hatch canonical, and keep the resolver verification cheap. Everything else is negotiable.*
