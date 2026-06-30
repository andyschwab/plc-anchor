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
  mirror.ts        # MaliciousDirectory (in-process DirectorySource) + startMaliciousMirror
                   #   (an HTTP server speaking the PLC /{did}/log/audit route) — one log, two modes
  harness.ts       # reconstruct the AnchorView from the fixture (proofs stay real) + run check()
  report.ts        # render the narrative → docs/ADVERSARIAL-REPORT.md (the artifact)
  adversarial.test.ts  # CI pass/fail gate (incl. the §0 "benign must never alarm" wall)
  mirror.test.ts       # CI: the HTTP wrapper + the REAL DirectoryClient fetch path, end-to-end
  live.test.ts         # gated: REAL Sepolia anchor + HTTP malicious mirror + REAL check()
```

**One source of truth (the generated fixture), consumed three ways:** the test gate, the narrative
report, and the live runner. Nothing is mocked but the transport — and even that is exercised for
real in `mirror.test.ts` (the witness's own `DirectoryClient` fetches the malicious mirror over a
loopback HTTP socket) and in `live.test.ts` (against Sepolia). The decision logic is the shipping
`check()`, and the Merkle proofs in the fixture are verified by the witness's own `verifyProof`,
so a wrong root/format fails here exactly as on a real resolver.

## Commands

| Command | Does |
|---|---|
| `make adversarial` | run the suite (offline) + regenerate `docs/ADVERSARIAL-REPORT.md` |
| `make adversarial-check` | CI gate: scenarios behave as specified AND the committed report is current |
| `make adversarial-live` | gated live read vs Sepolia (see env vars below) |
| `make gen-adversarial-scenarios` | regenerate the fixture from `@did-plc/lib` (commit the result) |
| `node adversarial/report.ts --stdout` | print the narrative without writing the file |

### Live read (gated)

The offline suite is the CI gate; the live read proves the same data path against the deployed
anchor. It reads the anchor's real head, then has an HTTP malicious mirror lie *relative to it*:

```sh
WITNESS_LIVE_RPC=https://<keyed-sepolia> \
WITNESS_LIVE_DID=did:plc:<anchored> \
  make adversarial-live
# optional: WITNESS_LIVE_CONTRACT=0x… (defaults to the recorded deployment)
```

Tentative-tier scenarios (honest mirror, unanchored→`absent`) run immediately. The
confirmed-`diverged` headline requires a DID with a **confirmed** head (anchored ≥72h ago); for a
still-within-window DID the same attack correctly yields a non-alarming status, and the runner
reports that via `t.diagnostic` rather than failing.

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

## Status

Offline suite (18 tests) + the gated live runner (4 tests) are green. Open follow-up: a richer
live corpus once a DID has been anchored ≥72h (to exercise the confirmed-`diverged` headline
against the real contract end-to-end). See `docs/PHASE-5-PLAN.md`.
