# PLC Anchor — Project Reference

A censorship-resistant, cryptographically-verifiable **anchor** for the AT Protocol DID
PLC operation log, built on Starknet. It lets resolvers cross-check `plc.directory`
against a trust-minimized, independently-verifiable root. It is an anchor, **not** a
replacement for the directory.

---

## 1. What this is

PLC (Public Ledger of Credentials) is the default DID method for atproto. Every account's
identity is a signed, hash-linked log of operations served from a single directory
(`plc.directory`, operated by Bluesky PBC). The directory is never trusted for
*correctness* — every op is self-certifying — but it **is** trusted for **availability,
ordering, and timestamping**. That single-operator trust is the chokepoint.

This project re-verifies PLC operations on-chain and publishes a proven commitment to the
current DID→document mapping, with a permissionless write path so no operator can suppress
a valid op. It does not run the directory; it anchors the DIDs that opt in.

**Residual trust (narrow, deliberate):**
- **Ordering** — per-DID linearization of operations (cross-DID order is irrelevant; DIDs
  are independent).
- **Timestamp** — the `createdAt` that drives PLC's 72-hour recovery window. We report it
  pragmatically (§4).

Per-op validity is **proven**, not assumed.

---

## 2. The approach

Three facts make the design simple:

1. **PLC per-DID chains are self-certifying and independent.** A DID *is* the hash of its
   genesis op; every op is signed by a then-valid rotation key and hash-links to its
   predecessor. So a DID's entire history can be verified from genesis in isolation.
2. **Cairo has native secp256k1, secp256r1, and sha-256.** In-contract verification of a
   PLC op signature and CID is a library call.
3. **Starknet gives validity proofs + Ethereum settlement for free.** A contract's state
   transition is STARK-proven by the network and settled on L1.

From these:

- **One permissionless endpoint (a Starknet contract).** `import(did, chain)` verifies a
  DID's full op log from genesis and commits its head; `submit_op(op)` appends a new
  signed op. Anyone may import any DID's (public, self-certifying) history; **new** ops are
  authorized by the owner's rotation key directly, via Starknet **native account
  abstraction** — the PLC key *is* the signer. This single primitive is both the normal
  write path and the censorship-resistance escape hatch.
- **Verification runs as a contract.** The network proves the blocks and settles to
  Ethereum. We run no bespoke prover and — initially — no sequencer (deploy on public
  Starknet first; an appchain is a later option, §6).
- **Per-DID verification is lazy and on-demand.** No bulk genesis replay, no trusted
  snapshot. Each anchored DID is proven from its own genesis — the strongest trust
  property, kept exactly where it matters.
- **Membership is not a protocol concern.** You are anchored iff your chain has been
  submitted. *Which* DIDs to anchor and *who pays* live in an off-chain admin/user tool
  (§6, "Layer 2"), which allocates commitment costs via account abstraction / paymasters
  (e.g. a coalition like Eurosky sponsors a set; users self-fund).

### Why this is elegant

- The genesis-cost problem **disappears** — per-DID lazy verification on self-certifying
  chains, instead of replaying the whole directory.
- Membership complexity **disappears** — off-chain policy over a permissionless endpoint.
- No bespoke prover and no appchain required to start.
- The write path and the escape hatch are **the same primitive**.
- The narrowest possible residual trust (ordering + timestamp); everything else is proven.

---

## 3. Components & build order

The keystone is the long pole; everything composes around it. Consensus-critical modules
are differential-tested against the reference implementations before merge (§5).

1. **DRISL / DASL CID in Cairo (keystone).** Canonical dCBOR42 encoding + DASL CID
   derivation (sha-256 over DRISL bytes). Green against the DASL conformance suite. The
   acceptance test for everything downstream. → `cairo/packages/drisl`
2. **PLC op verification + recovery state machine.** Op types (genesis `plc_operation`,
   updates, legacy `create`, `plc_tombstone`); secp256k1/r1 signature verification over
   the DRISL-encoded unsigned op; did:key parsing; `prev` linkage; the 72h
   higher-priority-key nullification. Differential-tested vs `@did-plc/lib`.
   → `cairo/packages/plc_core`
3. **State commitment + anchor endpoint.** Per-DID head; a commitment over the DID→document
   map (resolution = root + inclusion proof); confirmed/tentative tiers (§4); the
   permissionless `import` / `submit_op` entrypoint with native-AA authorization.
   → `cairo/packages/plc_core`
4. **Sync indexer (off-chain, Rust).** Consume a PLC mirror's `/export/stream` (Eurosky /
   microcosm) by sequence cursor; for anchored DIDs, submit deltas. Where ongoing
   update cost lives and is allocated. → `ingest/`
5. **Resolver verification library.** Given a DID, return the document + an inclusion proof
   against the published root, with a confirmed/tentative flag. Must be cheap — this is the
   adoption surface; an anchor nobody checks is theater.
6. **Later, deliberately deferred:** the **Layer-2 admin/user tool** (anchoring policy +
   cost allocation); **governance** (§7); an **appchain** — only if credible neutrality
   demands owning the sequencer (public Starknet's L1 force-inclusion provides the CR
   guarantee until then).

Supporting: **`oracle/`** (Rust differential runner, `atproto-dasl`) is the CID/DRISL
authority for §1–2 testing.

---

## 4. The 72h recovery window — confirmed/tentative tiers

Within 72h of an op's `createdAt`, a higher-priority rotation key (lower index in
`rotationKeys`) can sign an op that nullifies a lower-priority branch — PLC's
fork/recovery mechanism. We surface this rather than hide it:

- **Confirmed root** — commits ops *past* the window. Immutable; what resolvers treat as
  final.
- **Tentative tip** — within-window ops, still nullifiable. Carried separately and flagged.

Resolvers get an explicit confirmed/tentative status, never a silently-revisable root.

---

## 5. Consensus-critical facts (verify before depending on these)

Reimplementing PLC verification is consensus-critical: any divergence from the reference
is a fork. The blessed, deterministic surface is the point — implement exactly it, reject
everything else.

- **DID derivation:** `did:plc:` + base32-lowercase-nopad( sha-256( DRISL(genesis op) ) ),
  truncated to the first **24** chars.
- **CIDs:** CIDv1 only; multihash sha2-256 (`0x12`, 32-byte digest `0x20`); codec dag-cbor
  /DRISL (`0x71`) or raw (`0x55`); base32 (`b` prefix). This is the DASL blessed set.
- **DRISL / dCBOR42 canonical:** minimal-length integers; length-first then lexicographic
  map-key ordering; 64-bit floats only (no NaN/Inf); no indefinite-length; Tag 42 for CID
  links (0x00-prefixed); simple values `true`/`false`/`null` only; string keys only.
- **Signatures:** ECDSA secp256k1 ("k256") or secp256r1 / NIST P-256 ("p256"), over the
  DRISL-encoded unsigned op; 64-byte r‖s, base64url no-pad. Rotation/verification keys are
  did:key encoded. **S-malleability is curve-asymmetric in the reference (verified against
  `@atproto/crypto`):** k256 requires **low-S** (the verifier rejects high-S); p256 is
  **malleable** — the reference accepts either S and atproto's p256 signer does not even
  canonicalize it, so high-S p256 ops are valid PLC ops and an anchor MUST accept them or
  it forks. (An earlier draft said "low-S required" for both; that was wrong for p256.)
- **Recovery:** rotation keys are 1–5, priority-ordered (index 0 = highest). A lower-index
  key nullifies ops signed by higher-index keys within 72h, forking to the last
  universally-accepted state.
- **Constraints:** max 10 verificationMethods/DID; max op size 7500 bytes (dCBOR-encoded).
- **Op sizes (context):** legacy `create` ~330 B; modern `plc_operation` ~1.4–2.0 KB.

**Differential oracles:** `@did-plc/lib` (TypeScript, authoritative for op validity /
recovery) and `atproto-dasl` (Rust, authoritative for DRISL/CID). DASL conformance vectors
are vendored under `conformance/vectors`.

**Spec sources:**
- PLC spec: `https://web.plc.directory/spec/v0.1/did-plc`
- PLC method repo: `https://github.com/did-method-plc/did-method-plc`
- Export/seq/websocket API: `https://github.com/bluesky-social/atproto/discussions/4508`
- atproto data model: `https://atproto.com/specs/data-model`
- DASL: `https://dasl.ing/` · CID `https://dasl.ing/cid.html` · dCBOR42 `https://dasl.ing/dcbor42.html`
- Reference impls: `github.com/hyphacoop/go-dasl`, `docs.rs/atproto-dasl`, `@atcute/cbor` (npm)

---

## 6. Governance (when we get there)

Pattern: SAFE-style multisig admin during a mutable window → timelock on upgrades →
permanent, maturity-gated freeze. On Starknet, upgrades are native (`replace_class_hash`);
"freeze" is a one-way storage flag that disables the upgrade entrypoint.

Two constraints that shape it (apply at design time, freeze later):
- **Freeze on a maturity gate, not a calendar** — DASL conformance green; N months of zero
  divergence vs the reference impls on a live mirror; an independent audit. An immutable
  contract with an encoding bug is a permanent fork.
- **Scope the frozen core narrowly** (proof verifier + root commitment); keep op-validation
  rules parameterizable / separately-governed, because the PLC/DASL blessed set is
  explicitly extensible.

Credible neutrality lives in the signer set: a geographically/organizationally diverse
coalition (Eurosky, microcosm, others) holding keys, with the pre-committed freeze path.

---

## 7. Ecosystem leverage

- **Firehose:** Eurosky mirrors the did:plc directory on EU infrastructure; microcosm runs
  independent mirrors. Either is a drop-in feed for the sync indexer — we don't run the
  directory.
- **Write-path UX:** eu-haul already submits PLC ops and surfaces rotation/recovery keys to
  users — reusable for the permissionless endpoint UX (same primitive).
- **Constituency:** a sovereignty-motivated coalition that actively wants a PLC anchor not
  controlled by a single operator. This is the natural Layer-2 operator/governance set.

Repos: `github.com/eurosky-social` (`u-at-proto`, `eu-haul`).

---

## 8. Tooling / stack

- **Cairo 2.x** · **Scarb** (build) · **Starknet Foundry / `snforge`** (tests, gas
  reporting).
- **Starknet** (public network first) · **native account abstraction** (PLC key as signer)
  · **paymasters** (commitment-cost allocation).
- **Crypto:** Cairo corelib `sha256` + `secp256k1` + `secp256r1` (syscalls, in-contract);
  Garaga only if an exotic curve is ever needed.
- **Off-chain (Rust):** sync indexer + differential oracle (`atproto-dasl`).
- **Differential references:** `@did-plc/lib`, `atproto-dasl`, `@atcute/cbor`; DASL
  conformance vectors.

---

*Scope discipline: this is an anchor — a permissionless, proven, verifiable write path and
state root for the DIDs that opt in — not a PLC replacement. Keep the verification core
exact, keep the endpoint permissionless, keep resolver verification cheap.*
