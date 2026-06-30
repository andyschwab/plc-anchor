# Phase 5 plan — the witness / resolver library (the V1 product)

Working plan for build-order item 5 (`REFERENCE.md` §3), "atproto identity DMARC" (§1a
Mode 1). Scope and rationale are settled in `REFERENCE.md` §1, §1a, §4, §5 and the pre-plan
context in [`PHASE-5-WITNESS-NOTES.md`](PHASE-5-WITNESS-NOTES.md); this doc is the
**sequencing, architecture, and acceptance** layer. It does not relitigate anything in
`CLAUDE.md` "Do NOT relitigate".

---

## 0. The governing invariant — never a false `diverged`

The anchor mitigates a **systemic** ecosystem risk: single-operator trust in `plc.directory`
for completeness/recency/non-equivocation. A false `diverged` converts that *latent systemic*
risk into an *immediate operational failure* on one specific resolver/PDS — and the rational
operator response to an operational failure is to **disable the check**. So a false positive
does not merely add noise; it removes the mitigation entirely and is self-defeating.

The asymmetry is total and it drives every ambiguous call in this library:

- **False negative** (we say `tentative-consistent`/`absent` when a real divergence exists) →
  degrades to the **status quo** the ecosystem already lives with. Tolerable.
- **False positive** (we say `diverged` on benign lag/skew) → **self-defeating**; the check
  gets turned off. Intolerable.

**Rule:** when a disagreement is even *plausibly* explained by clock lag or window-edge skew,
it is **not** `diverged`. `diverged` fires only on a contradiction of *already-confirmed*
history that skew cannot explain. This is the DMARC `none → quarantine → reject` discipline:
earn the right to alarm.

---

## 1. Decided scope (the three forks, resolved)

| Fork | Decision | Why |
|---|---|---|
| **Adoption surface** | **TypeScript first** | Resolvers/PDS live in TS; the reference oracle (`@did-plc/lib`) is TS. The proof-check is a ~40-line port. An anchor nobody checks is theater — ship where adopters are. |
| **Proof delivery** | **On-chain `proof()` view** | Reuses `merkle_proof()`; one RPC, trustless (resolver re-verifies against an independently fetched root). The roster-scaling cost is read-time only and shared by the root views; the `O(N log N)` sort already landed. The off-chain prover service is a *later* memoization layer with the identical format. |
| **Clock reconciliation** | **Conservative now, precise bound later** | The window-edge skew rule is the hardest part; front-loading the exact bound buys an adopter nothing they can feel while risking the one fatal failure mode (§0). V1 never false-alarms; the precise bound is a documented follow-up. |

**Explicitly out of V1** (named so we don't drift into them):
- The off-chain prover service (Mode-2-adjacent infra).
- The precise skew bound + its re-evaluation trigger (documented follow-up; V1 uses the
  conservative collapse).
- Availability (Mode 2) and partition-canonical (Mode 3).

---

## 2. Architecture

A **TypeScript witness library** + a thin CLI demonstrator. One small contract change feeds it.

```
resolver/PDS ──► witness-ts: check(did)
                   ├─ directory:  GET /{did}            (current document)
                   │              GET /{did}/log/audit  (ops + createdAt — the only clock source)
                   ├─ starknet RPC (call, gas-free):
                   │     is_anchored(did) · head_cid(did) · confirmed_head(did)
                   │     tentative_root() · confirmed_root()
                   │     proof(did)   ◄── NEW view
                   └─ verify_proof (ported from merkle.cairo) + status ladder (§4)
                 ──► { status, reason, evidence }
```

The Starknet node is the trust root for the proven state; the directory is the thing being
held accountable. The proof server (the contract here) is **untrusted** — the resolver
recomputes the root from the proof and compares it to a root it fetched itself.

---

## 3. Contract change — the `proof()` view

The chain exposes roots + heads but no way to *extract* an inclusion path. Add one view,
reusing the existing pure `merkle_proof()` / `sorted_leaves()`.

A proof is **root-specific** (there are two roots, confirmed + tentative), so expose both
tiers rather than overload one:

```cairo
// Inclusion path for `did`'s tentative head against tentative_root().
fn tentative_proof(self: @TContractState, did: ByteArray) -> (ByteArray, Array<ProofStep>);
// Inclusion path for `did`'s confirmed head against confirmed_root().
// Returns ("", []) if the DID has no confirmed head yet.
fn confirmed_proof(self: @TContractState, did: ByteArray) -> (ByteArray, Array<ProofStep>);
```

Each returns `(head_cid, steps)` so the resolver can rebuild the leaf
(`leaf_hash(did, head_cid)`) and walk `steps` to a root — no leaf index needed
(`verify_proof` uses `sibling_is_left`). Implementation: rebuild the entry set exactly as
`commitment_root` does, locate `did`'s leaf, return `merkle_proof(leaves, idx)`. Differential
test against the existing `generated_proofs_round_trip` shape, then **redeploy to Sepolia**.

> Note the `(did ‖ head_cid)` leaf is separator-less and sound only because did:plc is
> fixed-width (`REFERENCE.md` §5a). Don't change the leaf format here; the length-prefix work
> is a separate, format-breaking change reserved for variable-width subjects.

---

## 4. Status algorithm (V1, conservative)

Ported from `PHASE-5-WITNESS-NOTES.md` §2, with §0 as the tie-breaker on every ambiguous edge.

1. `is_anchored(did)` false → **`absent`** (coverage gap; no opinion, like DMARC `p=none`).
2. Fetch directory head `H_dir` (from the audit log / current document) and the on-chain
   `confirmed_head` / `head_cid`. Verify the inclusion proof against the matching root
   (`verify_proof`); a proof that fails to reconstruct the fetched root is a **fetch/consistency
   error**, surfaced as such — *not* `diverged`.
3. `H_dir` == anchor **confirmed** head → **`confirmed`** (strongest; immutable).
4. `H_dir` extends the confirmed chain and sits within the tentative window → **`tentative-consistent`**.
   This **subsumes finality lag**: a head the directory already calls confirmed while the
   anchor still calls tentative (histories agreeing) is `tentative-consistent`, never `diverged`.
5. Otherwise — `H_dir` contradicts the proven head (omits a confirmed op, or forks below a
   confirmed point):
   - If the disagreement is at a recovery near the 72h edge and is **plausibly explained by
     skew** (`skew = anchor_observation_time − directory_createdAt`, both clocks readable —
     chain block time vs the audit log) → **`tentative-consistent`** with reason
     `skew-pending`; re-evaluate after the anchor window closes. *(V1 uses the plausible-skew
     collapse, not a precise bound — §1.)*
   - Only an **unexplained** contradiction of already-`confirmed` history → **`diverged`**.

`diverged` is the sole actionable alarm (warn / quarantine / refuse to relay). Per §0, it must
be unreachable by lag or edge-skew.

**Output shape:**
```ts
type Status = 'confirmed' | 'tentative-consistent' | 'diverged' | 'absent';
interface CheckResult {
  status: Status;
  reason: string;          // human-readable; 'skew-pending' etc. machine-tags for the soft cases
  evidence: {
    directoryHead: string;
    anchorHead: string;
    confirmedRoot: string; // the root the resolver independently verified against
    proofVerified: boolean;
  };
}
```

---

## 5. Pinning & drift gate

The TS `verify_proof` + leaf/node hashing must stay byte-identical to the pinned Cairo format
(`merkle.cairo`), or a resolver forks. Reuse the existing discipline:

- The TS port consumes the **same `gen-merkle-vectors` output** the Cairo test pins against
  (`merkle_vectors_generated`). A CI gate asserts the TS recompute matches the vector
  leaf/root/proof, exactly as the Cairo side does — one source of truth, two consumers.
- The status ladder is differential-tested against `@did-plc/lib` for the directory-side
  decision (which ops are valid / recovered).

---

## 6. Testing

Differential, like everything consensus-touching, but the oracle is a **scenario table**:
`(directory decision via @did-plc/lib, anchor decision via the contract, skew) → expected status`.

- **Format conformance:** TS leaf/node/proof == the pinned merkle vectors (CI drift gate).
- **Status ladder:** one row per ladder branch (§4) — confirmed, lag→tentative-consistent,
  clean extension→tentative-consistent, omission→diverged, fork-below-confirmed→diverged.
- **Window-edge recovery vectors** (the §0 stress set): a recovery landing just inside/outside
  each clock's window. Every benign-skew row **must** resolve to a non-`diverged` status —
  this is the regression wall against the fatal failure mode.
- **Live read:** `check(did)` against the DID already anchored on Sepolia (`ingest --did`),
  asserting `confirmed` / `tentative-consistent` end-to-end (the gated manual job, alongside
  `e2e-sepolia.yml`).

### Adversarial validation suite (`adversarial/`)

Beyond the per-branch status tests above, the [`adversarial/`](../adversarial/) suite is the
"does this actually defend?" layer (and the engineer-facing narrative,
[`docs/ADVERSARIAL-REPORT.md`](ADVERSARIAL-REPORT.md)). It composes the already-differential-green
modules into **named attacks** on real signed did:plc chains — no new consensus logic:

- **read-side** (defender = the witness `check()`): one scenario per status-ladder branch,
  including the alarm (`equivocation`, `vanishing-did` → `diverged`) and the §0 restraint walls
  (`honest-lag`, `window-edge-skew`, `anchor-self-fault` → non-`diverged`). The malicious mirror
  is a `DirectorySource` (in-process) and, in `mirror.test.ts`, an HTTP server that the **real
  `DirectoryClient` fetch transport** hits — so the only thing the live runner adds is the
  Sepolia anchor read.
- **write-side** (defender = `plc_core::verify`/`recovery` or the ingest integrity gate):
  `forged-signature`, `weaker-key-recovery`, `late-recovery`, `integrity-mismatch`, each
  ground-truthed against `@did-plc/lib` at fixture-generation time (the generator throws if a bad
  op is ever accepted).
- **live** (`make adversarial-live`, gated on `WITNESS_LIVE_RPC` [+ `WITNESS_LIVE_DID`]): the real
  Sepolia anchor + an HTTP malicious mirror + the real `check()`. The runner reads the anchor's
  real head and synthesizes the lie relative to it, so expectations track on-chain reality — the
  confirmed-`diverged` headline asserts only when the DID has a confirmed head (anchored ≥72h),
  otherwise it confirms the same attack is correctly non-alarming and says so via `t.diagnostic`.

---

## 7. Sequencing

1. **P5.1 — `proof()` views** (`anchor.cairo`): `tentative_proof` / `confirmed_proof`,
   round-trip tested against the existing merkle gate. Redeploy to Sepolia.
2. **P5.2 — TS core** (`witness-ts/`): port `verify_proof` + leaf/node hashing; the drift gate
   against the merkle vectors. *No network yet — pure, vector-pinned.*
3. **P5.3 — data path**: directory client (`/{did}`, `/{did}/log/audit`) + Starknet RPC reads
   (roots, heads, proof).
4. **P5.4 — status ladder** (§4) with the conservative skew collapse; the scenario-table tests.
5. **P5.5 — CLI demonstrator** + the live Sepolia read.

P5.1–P5.2 are the dependency root (format-pinned, offline). P5.3–P5.5 layer the data path and
the product surface on top.

---

## 8. Exit criteria

- `tentative_proof` / `confirmed_proof` deployed to Sepolia; proofs round-trip against the
  on-chain roots.
- `witness-ts` produces leaf/root/proof byte-identical to the pinned merkle vectors (CI gate).
- The status scenario table is green, **including every window-edge benign-skew row resolving
  to a non-`diverged` status** (§0).
- `check(<live Sepolia DID>)` returns the correct graduated status end-to-end.
- README: how a resolver adopts it unilaterally (the DMARC `none → quarantine → reject` ramp).
