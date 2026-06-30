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

## Status

Vertical slice: the alarm (`equivocation` → `diverged`) and the restraint (`honest-lag` →
`tentative-consistent`), offline. Next: the remaining read-side scenarios (vanishing DID,
window-edge skew, coverage gap), the write-side rejections (driven through the contract), and the
gated live testnet runner (a thin HTTP wrapper over `mirror.ts` + a real Sepolia read). See the
build sequence in the design discussion / `docs/PHASE-5-PLAN.md`.
