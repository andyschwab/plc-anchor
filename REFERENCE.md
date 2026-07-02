# PLC Anchor — Project Reference

**DIDMARC — "atproto identity DMARC."** A cryptographically-verifiable **anchor** for the
did:plc operation log, built on Starknet. PLC ops already self-certify per-op (authenticity
— the DKIM analog); DIDMARC adds the layer PLC lacks: independent on-chain proof that
`plc.directory` is serving a DID's **complete, current, and non-equivocated** history, plus
a graduated status a resolver or PDS can enforce as policy (the SPF/DMARC analog).
`plc.directory` stays canonical; the anchor is a **unilaterally adoptable** witness that
holds it accountable — any one checker turns it on alone, the way an email receiver enables
DMARC. It is an anchor, **not** a replacement for the directory.

> *Name provisional: "DIDMARC" = DID Mapping Alignment, Reporting & Conformance,
> picked so the email-auth analogy reads at a glance. ("Alignment" over "Authentication":
> PLC already provides per-op authentication — the DKIM half — so the layer DIDMARC adds is
> the alignment check, mirroring DMARC's real mechanism.) Rename freely.*

---

## 1. What this is

PLC (Public Ledger of Credentials) is the default DID method for atproto. Every account's
identity is a signed, hash-linked log of operations served from a single directory
(`plc.directory`, operated by Bluesky PBC). The directory is never trusted for
*correctness* — every op is self-certifying — but it **is** trusted for **availability,
ordering, and timestamping**. That single-operator trust is the chokepoint.

This project re-verifies PLC operations on-chain and publishes a proven commitment to the
current DID→document mapping. The **V1 product is the witness**: a resolver or PDS fetches a
DID document from the directory (or a mirror) and checks it against the on-chain proof,
getting back a graduated status — `confirmed` / `tentative-consistent` / `diverged` /
`absent` (§4) — that it can act on. This needs **no network coordination and no protocol
change**: a single checker adopts it alone. A permissionless write path (`submit_op`, §2) is
retained as a **backstop** — a censorship escape hatch, and the seed of the later modes
(§1a) — not the V1 headline. The project does not run the directory; it anchors the DIDs
that opt in (a PDS naturally anchors its own users).

**Residual trust (narrow, deliberate):**
- **Ordering** — per-DID linearization of operations (cross-DID order is irrelevant; DIDs
  are independent).
- **Timestamp** — `createdAt` is **not in the signed op** (it is directory-assigned
  metadata, absent from the op bytes and the CID), so there is nothing to read and nothing
  of the directory's to trust. The anchor substitutes **Starknet block time** — the window
  is measured from when *we observed* the op, not when it was authored (§4). A weaker
  dependency than "trust their clock," but a real one: our window lags the directory's.

Per-op validity is **proven**, not assumed.

---

## 1a. Operating modes — V1 and the ladder beyond

The same proven-root foundation supports three modes. Build them **in order; only Mode 1 is
V1.** Modes 2–3 are stubbed here to record that the foundation makes them possible and to
keep V1 from foreclosing them — they are explicitly *not* the focus.

1. **Witness — "atproto identity DMARC" (V1, the product).** `plc.directory` stays the
   canonical source of truth and the write path. The anchor is a read-side accountability
   layer: it proves completeness, recency, and non-equivocation, and exposes a graduated
   status (§4) that any resolver/PDS enforces **unilaterally**. This is what we ship and
   what people adopt; everything in §3 serves it. Per-op authenticity is already PLC's
   (DKIM); what the witness adds is the SPF/DMARC layer a single signature structurally
   cannot — *was I shown the whole, current, non-equivocated history?*

2. **Availability (later).** A proven root plus the op bytes (from a mirror) already let the
   anchor answer a resolution with an inclusion proof. Promoting that to a real fallback —
   serving identity when the directory is unreachable — is the natural Mode 2. The
   foundation makes it possible; it is not V1. (Integrity, not availability, is the V1
   guarantee.)

3. **Canonical source in a partitioned PLC (final).** If PLC ever partitions — a regional or
   political split, or the single operator becoming untrusted — the permissionless write
   path and the proven root can serve as the neutral reconciliation point: a canonical head
   when there is no longer one agreed directory. This is the escape hatch grown into a
   source of truth. Strictly a last mode; designing for it now would over-build V1.

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
  authorized by the op's **embedded rotation-key signature, verified in-contract** — never
  by the Starknet transaction signer or fee payer, who may be anyone (that is the
  permissionless property). Native account abstraction and paymasters are gas/UX only (who
  *pays*), never authorization (who may *write*); do not require the PLC key to be the
  Starknet account signer. In witness mode the indexer (§3.4) supplies ops mirrored from the
  directory; `submit_op`'s permissionless authorization is the **backstop** (escape hatch,
  and the seed of Modes 2–3, §1a) — one primitive serving both the normal and the
  adversarial path.
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
**Build order is dependency order, not priority order:** the V1 *product* is the witness
library (5), but it stands on 1–4.

1. **DRISL / DASL CID in Cairo (keystone).** Canonical dCBOR42 encoding + DASL CID
   derivation (sha-256 over DRISL bytes). Green against the DASL conformance suite. The
   acceptance test for everything downstream. → `cairo/packages/drisl`
2. **PLC op verification + recovery state machine.** Op types (genesis `plc_operation`,
   updates, legacy `create`, `plc_tombstone`); secp256k1/r1 signature verification over
   the DRISL-encoded unsigned op; did:key parsing; `prev` linkage; the 72h
   higher-priority-key nullification. Differential-tested vs `@did-plc/lib`.
   → `cairo/packages/plc_core`
3. **State commitment + anchor endpoint.** Per-DID head; a commitment over the DID→document
   map (resolution = root + inclusion proof — the witness substrate); confirmed/tentative
   tiers (§4); the `import` / `submit_op` entrypoint with embedded-signature authorization
   (`submit_op` = the backstop write path, §2). → `cairo/packages/plc_core`
4. **Sync indexer (off-chain, Rust).** Consume a PLC mirror's `/export/stream` (Eurosky /
   microcosm) by sequence cursor; for anchored DIDs, submit deltas. **The normal anchoring
   path in witness mode**, and where ongoing update cost lives and is allocated. → `ingest/`
5. **Witness / resolver verification library — the V1 product.** Given a DID, return the
   document + an inclusion proof against the published root, as the graduated status
   (`confirmed` / `tentative-consistent` / `diverged` / `absent`, §4). This is "atproto
   identity DMARC" (§1a Mode 1) — the adoption surface and the headline deliverable, even
   though it is built last because it stands on 1–4. Must be cheap; an anchor nobody checks
   is theater. The status algorithm and the window-edge clock-reconciliation rule, as built,
   are recorded in [`docs/HISTORY.md`](docs/HISTORY.md) (item 5).
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

These tiers **are** the witness's output (§1a Mode 1). The graduated status a checker gets:

- **`confirmed`** — head committed past the 72h window; immutable. Strongest assertion.
- **`tentative-consistent`** — within-window op; the on-chain view agrees with the directory
  so far, but it is still nullifiable. **This subsumes the expected clock lag:** the anchor
  measures the 72h window from *its own* block-time observation (§1), which is strictly later
  than the directory's `createdAt`, so the anchor's confirmed/tentative boundary lags the
  directory's. A head the directory already calls `confirmed` while the anchor still calls
  `tentative` — histories otherwise agreeing — is `tentative-consistent`, **not** `diverged`.
- **`diverged`** — the directory's served head *contradicts* the proven head (an op omitted,
  or a head the anchor has already confirmed). The actionable alarm: warn / quarantine /
  refuse to relay. The genuinely hard case is a *recovery at the window edge*: because the
  anchor's clock lags, it can still honor a higher-priority-key nullification the directory
  has already rejected as too-late, so the two commit to different heads from clock skew
  alone (§5). The checker must not treat that as ordinary equivocation.
- **`absent`** — DID not anchored; no opinion (the coverage gap, like DMARC `p=none`).

A hard "reject unless `confirmed`" gate would reject every legitimate update from the last
72h; the product is the *graduated* status, enforced like DMARC's `none` / `quarantine` /
`reject`, not a binary stamp.

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
- **`createdAt` is not in the signed op** — it is directory-assigned metadata, absent from
  the op bytes and the CID (confirmed against the corpus). The contract has no authored
  timestamp to read; it uses **Starknet block time** (× 1000 ms) as the pragmatic
  `createdAt` the 72h window measures against, and imported ops are stamped with the import
  block time. **Imported ops are therefore treated as _settled_: a recovery may not nullify
  one (`state::apply_op` → `recovery-of-imported`).** The block-time stamp approximates real
  authored time only for *live-observed* ops; for backfilled history it is meaningless (an op
  authored years ago is stamped now), and honoring a recovery against it would re-open a
  window that closed years ago and let a *rotated-out* higher-priority key capture the DID —
  the 4a hazard (docs/HISTORY.md, docs/SECURITY-TODO.md). So the 72h window is honored only for
  live-observed ops. *Window-edge recovery is the remaining delicate corner:* the anchor's
  clock is strictly later than the directory's, so near the 72h edge the anchor can accept a
  higher-priority-key nullification of a *live* op the directory rejected as too-late
  (conservative — it only re-exposes the window for a live-observed op, never mutates settled
  history), producing a `diverged` (§4) from clock skew alone. Pin the exact rule when building
  the checker (item 5).
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

## 5a. Generality — one witness core, pluggable verifiers

DIDMARC has a clean **mechanism/policy seam**, and that is the axis we generalize on:

- **Generic core (method-agnostic):** the sha256 Merkle commitment (`merkle` already takes
  opaque `(subject, head)` bytes), the confirmed/tentative tiering + time-window machinery,
  the per-subject storage, the inclusion-proof format, the graduated status, the endpoint
  shape.
- **Per-method verifier (policy):** encoding, subject-id derivation, signature schemes,
  prev-linkage, the validity predicate, the recovery rule, constraints. PLC is the **first**
  verifier; a second method is a second implementation *in code*, pinned to its own
  reference oracle — **not** config/template variables (a parameterized validity engine has
  no reference to be differential-green against, and every leak is a fork). This is the §6
  "frozen core narrow, op-validation separately-governed" principle, made concrete.

**Choices:** generalize the mechanism, hand-write each policy. Don't build the generic
engine now — V1 is the PLC witness; just keep the seam clean (it nearly is).

**Next steps when we reach for it:**
- The `merkle` leaf uses a separator-less `did ‖ head_cid`, sound only because did:plc is
  fixed-width. Add a length prefix *before* admitting variable-width subjects — cheap now,
  format-breaking later.
- The natural second module is **in-domain**: a witness over atproto account **repositories**
  (signed repo/MST commit roots), same self-certifying shape, same constituency, and a
  reference impl already exists to stay differential-testable.

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
- **Starknet** (public network first) · **native account abstraction** + **paymasters**
  (gas/UX and commitment-cost allocation only — never authorization; the op's embedded
  signature, verified in-contract, is the sole authority).
- **Crypto:** Cairo corelib `sha256` + `secp256k1` + `secp256r1` (syscalls, in-contract);
  Garaga only if an exotic curve is ever needed.
- **Off-chain (Rust):** sync indexer + differential oracle (`atproto-dasl`).
- **Differential references:** `@did-plc/lib`, `atproto-dasl`, `@atcute/cbor`; DASL
  conformance vectors.

---

*Scope discipline: V1 is the **witness** — "atproto identity DMARC": independent proof that
`plc.directory` serves a complete, current, non-equivocated history, exposed as a graduated
status any resolver/PDS enforces unilaterally. `plc.directory` stays canonical; availability
(Mode 2) and canonical-source-in-a-partition (Mode 3) are later, not V1 (§1a). The
permissionless write path is the backstop, not the headline. Keep the verification core
exact, keep the endpoint permissionless, keep the witness check cheap.*
