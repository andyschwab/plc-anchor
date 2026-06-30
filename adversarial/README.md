# `adversarial/` — DIDMARC adversarial validation

Does the witness actually catch a lying PLC mirror — and, just as important, *not* cry wolf on
benign disagreement? This suite answers that against **real signed did:plc chains** and the
**real witness `check()`**, then renders the result as an engineer-facing narrative.

It adds **no new consensus logic.** Every decision traces to a module already differential-green
against `@did-plc/lib` and the Cairo contract; the suite composes them into named attacks.

## Shape

```
conformance/src/gen-adversarial-scenarios.mjs   # builds real chains + the anchor's Merkle
                                                 # commitment + the mirror's served log
                                                 #   → adversarial/scenarios.generated.json (committed)
adversarial/
  mirror.ts        # MaliciousDirectory: a DirectorySource serving an attacker-chosen audit log
  harness.ts       # reconstruct the AnchorView from the fixture (proofs stay real) + run check()
  report.ts        # render the narrative → docs/ADVERSARIAL-REPORT.md (the artifact)
  adversarial.test.ts  # CI pass/fail gate (incl. the §0 "benign must never alarm" wall)
```

**One source of truth (the generated fixture), three consumers:** the test gate, the narrative
report, and (later) the live testnet runner. Nothing is mocked but the transport — the directory
fetch and the chain reads. The decision logic is the shipping `check()`, and the Merkle proofs in
the fixture are verified by the witness's own `verifyProof`, so a wrong root/format fails here
exactly as it would on a real resolver.

## Commands

| Command | Does |
|---|---|
| `make adversarial` | run the suite + regenerate `docs/ADVERSARIAL-REPORT.md` |
| `make adversarial-check` | CI gate: scenarios behave as specified AND the committed report is current |
| `make gen-adversarial-scenarios` | regenerate the fixture from `@did-plc/lib` (commit the result) |
| `node adversarial/report.ts --stdout` | print the narrative without writing the file |

## The governing invariant

The witness must **never** raise a false `diverged` (Phase 5 plan §0): a false alarm makes an
operator disable the check, removing the protection entirely. So benign scenarios are first-class
here, not an afterthought — `adversarial.test.ts` asserts every `benign` scenario resolves to a
non-`diverged` status. That restraint is what makes the alarm worth acting on.

## Scenarios

**Read-side** (the witness `check()` is the defender — one per branch of the §4 status ladder):

| id | verdict | teaches |
|---|---|---|
| `confirmed-match` | `confirmed` | the happy path — directory == proven head |
| `young-did` | `tentative-consistent` | the two-tier model: nothing immutable yet |
| `honest-lag` | `tentative-consistent` | directory legitimately ahead — no false alarm |
| `equivocation` | `diverged` 🚨 | a mirror omits a confirmed op — the alarm |
| `vanishing-did` | `diverged` 🚨 | an anchored DID can't be erased |
| `window-edge-skew` | `tentative-consistent` | the §0 wall: skew-explained contradiction never alarms |
| `anchor-self-fault` | `tentative-consistent` | the witness distrusts its own unproven head |
| `coverage-gap` | `absent` | honest about scope (opt-in per DID) |

**Write-side** (the contract / ingest gate is the defender — "permissionless ≠ unsafe"),
ground-truthed against `@did-plc/lib` at generation time:

| id | reason | defender |
|---|---|---|
| `forged-signature` | `invalid-sig` | `plc_core::op_verify` / `sig_verify` |
| `weaker-key-recovery` | `recovery-weaker-key` | `plc_core::recovery` |
| `late-recovery` | `late-recovery` | `plc_core::recovery` |
| `integrity-mismatch` | `cid-mismatch` | ingest integrity gate (off-chain) |

## Next

The gated **live testnet runner**: a thin HTTP wrapper over `mirror.ts` so the real
`DirectoryClient` fetch transport is exercised against a malicious mirror at a real URL, paired
with a real Sepolia anchor read. Tentative-tier read scenarios run live immediately; the
confirmed-`diverged` headline needs a DID anchored ≥72h ahead. See `docs/PHASE-5-PLAN.md`.
