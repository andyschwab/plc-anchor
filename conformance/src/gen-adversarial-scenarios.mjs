// Generator for the DIDMARC adversarial-validation scenarios (testnet adversarial suite).
//
// Builds REAL signed did:plc chains with @did-plc/lib (the same authoritative stack the
// conformance corpus trusts), applies an attacker's twist, computes the anchor's real
// sha256-Merkle commitment (root + inclusion proof, byte-identical to merkle.cairo /
// witness-ts/src/merkle.ts), and emits a fully self-describing fixture: data + prose + the
// expected outcome. Deterministic (fixed keys) so the fixture is byte-stable and CI drift-checks.
//
// Two scenario classes:
//   - read  — a malicious/faulty PLC mirror; the defender is the witness `check()` (run offline
//             against this fixture). Covers every branch of the §4 status ladder.
//   - write — a malicious submission to the permissionless endpoint; the defender is the
//             contract (plc_core::verify / recovery) or the off-chain ingest integrity gate.
//             Ground-truthed HERE against @did-plc/lib `assureValidNextOp` (the same oracle the
//             contract is differential-green against, pinned by recovery_vectors_generated.cairo);
//             this generator THROWS if the oracle ever accepts an op it should reject.
//
// Output: adversarial/scenarios.generated.json. Re-run: make gen-adversarial-scenarios.
import { Secp256k1Keypair } from "@atproto/crypto";
import { createOp, createUpdateOp, assureValidNextOp } from "@did-plc/lib";
import { encode } from "@ipld/dag-cbor";
import { CID } from "multiformats";
import { sha256 as mfSha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "..", "adversarial", "scenarios.generated.json");

// ── The pinned Merkle format (mirrors merkle.cairo / witness-ts/src/merkle.ts) ───────────────
// Re-implemented here with raw node:crypto, independent of the witness — the offline runner
// verifies these proofs with witness-ts's verifyProof, so generator-builds / witness-verifies
// is itself the differential check that the resolver-side format agrees with the anchor.
const sha256 = (buf) => createHash("sha256").update(buf).digest();
const utf8 = (s) => Buffer.from(s, "utf8");
const hex = (buf) => Buffer.from(buf).toString("hex");
const ZERO_ROOT = "00".repeat(32);
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
const leafHash = (did, head) => sha256(Buffer.concat([LEAF_PREFIX, utf8(did), utf8(head)]));
const nodeHash = (l, r) => sha256(Buffer.concat([NODE_PREFIX, l, r]));
const emptyRoot = () => sha256(Buffer.alloc(0));

function merkleRoot(leaves) {
  if (leaves.length === 0) return emptyRoot();
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; ) {
      if (i + 1 < level.length) {
        next.push(nodeHash(level[i], level[i + 1]));
        i += 2;
      } else {
        next.push(level[i]); // promote odd node (RFC 6962)
        i += 1;
      }
    }
    level = next;
  }
  return level[0];
}

function merkleProof(leaves, index) {
  const proof = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    if (idx % 2 === 1) {
      proof.push({ sibling: level[idx - 1], siblingIsLeft: true });
    } else if (idx + 1 < level.length) {
      proof.push({ sibling: level[idx + 1], siblingIsLeft: false });
    }
    const next = [];
    for (let i = 0; i < level.length; ) {
      if (i + 1 < level.length) {
        next.push(nodeHash(level[i], level[i + 1]));
        i += 2;
      } else {
        next.push(level[i]);
        i += 1;
      }
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// Commit { did -> head } the way the anchor does (did-sorted leaves) and return the root plus
// the inclusion proof for `subjectDid`'s head. Sibling DIDs give the tree real depth so the
// proof exercises multi-level verifyProof, not the single-leaf degenerate case.
function commit(map, subjectDid) {
  const entries = Object.entries(map).sort((a, b) => Buffer.compare(utf8(a[0]), utf8(b[0])));
  const leaves = entries.map(([did, head]) => leafHash(did, head));
  const idx = entries.findIndex(([did]) => did === subjectDid);
  if (idx < 0) throw new Error(`subject ${subjectDid} not in commitment`);
  return {
    root: hex(merkleRoot(leaves)),
    proof: merkleProof(leaves, idx).map((s) => ({ sibling: hex(s.sibling), siblingIsLeft: s.siblingIsLeft })),
  };
}

const cidOf = async (op) => (await CID.create(1, 0x71, await mfSha256.digest(encode(op)))).toString(base32);

// ── A real single-key did:plc chain for the read-side scenarios ──────────────────────────────
const k0 = await Secp256k1Keypair.import("11".repeat(32), { exportable: true });
const atKey = await Secp256k1Keypair.import("44".repeat(32), { exportable: true });

const { op: genesis, did } = await createOp({
  signingKey: atKey.did(),
  rotationKeys: [k0.did()],
  handle: "didmarc-demo.test",
  pds: "https://pds.didmarc.test",
  signer: k0,
});
const opA = await createUpdateOp(genesis, k0, async (o) => ({ ...o, alsoKnownAs: ["at://didmarc-a.test"] }));
const opB = await createUpdateOp(opA, k0, async (o) => ({ ...o, alsoKnownAs: ["at://didmarc-b.test"] }));
// The attacker's forged branch off genesis — what a malicious mirror substitutes for the real
// history. A real, well-formed op; the lie is in *which* chain the directory serves.
const opForged = await createUpdateOp(genesis, k0, async (o) => ({ ...o, alsoKnownAs: ["at://attacker-controlled.test"] }));

const G = await cidOf(genesis);
const A = await cidOf(opA);
const B = await cidOf(opB);
const F = await cidOf(opForged);

// Fixed sibling subjects so the commitment tree has depth (proofs are multi-level, not trivial).
const SIBLINGS = {
  "did:plc:7iza6de2dwap2sbkpav7c6c6": "bafyreigenesissiblingbobxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxb",
  "did:plc:44tn5dyjrgw57aqqwm4z2tzp": "bafyreigenesissiblingcarolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxc",
  "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz": "bafyreigenesissiblingdavexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxd",
};

// A pinned clock for deterministic, reproducible runs.
const NOW = Date.parse("2026-06-30T00:00:00.000Z");
const SKEW_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const auditEntry = (cid, operation, createdAtMs, nullified = false) => ({
  did,
  cid,
  createdAt: iso(createdAtMs),
  nullified,
  operation,
});

// Build a read-side scenario's anchor view. Modes:
//   normal               — commit confirmed + tentative heads (real roots + proofs).
//   confirmedHead === ""  — nothing confirmed yet (empty confirmed tier); commit tentative only.
//   anchored: false       — the DID is not anchored at all (coverage gap).
//   faultProof: true      — confirmed head + a real proof, but a WRONG root, so the anchor's own
//                           inclusion proof fails to verify (an anchor-side integrity problem).
function anchorView({ confirmedHead, tentativeHead, anchored = true, faultProof = false }) {
  if (!anchored) {
    return { did, anchored: false, confirmedHead: "", tentativeHead: "", confirmedRoot: ZERO_ROOT, confirmedProof: [], tentativeRoot: ZERO_ROOT, tentativeProof: [] };
  }
  const t = commit({ [did]: tentativeHead, ...SIBLINGS }, did);
  if (confirmedHead === "") {
    return { did, anchored, confirmedHead: "", tentativeHead, confirmedRoot: hex(emptyRoot()), confirmedProof: [], tentativeRoot: t.root, tentativeProof: t.proof };
  }
  const c = commit({ [did]: confirmedHead, ...SIBLINGS }, did);
  return {
    did,
    anchored,
    confirmedHead,
    tentativeHead,
    // faultProof keeps the (correct) proof for the head but pairs it with a root it can't
    // reconstruct, so verifyProof fails — the witness can't trust its own confirmed head.
    confirmedRoot: faultProof ? ZERO_ROOT : c.root,
    confirmedProof: c.proof,
    tentativeRoot: t.root,
    tentativeProof: t.proof,
  };
}

const readScenarios = [
  {
    id: "confirmed-match",
    title: "Confirmed — the directory serves exactly what the anchor proved",
    threat: "The baseline: no attack, full agreement. What a healthy did:plc looks like through the witness — the strongest possible assertion.",
    class: "read",
    benign: true,
    setup: [
      `DID ${did} is anchored; its CONFIRMED head is opB (${B.slice(0, 16)}…), proven on Starknet and immutable past the 72h window.`,
      "The directory serves the same history, with opB as its current live head.",
    ],
    anchor: anchorView({ confirmedHead: B, tentativeHead: B }),
    directory: { auditLog: [auditEntry(G, genesis, Date.parse("2026-01-01T00:00:00Z")), auditEntry(B, opB, Date.parse("2026-02-01T00:00:00Z"))] },
    expect: { status: "confirmed", reason: "confirmed-head-match" },
    lesson:
      "The witness re-derives the anchor's confirmed root from an independently-fetched inclusion proof and finds the directory's live head is byte-identical. This is `confirmed` — the DMARC `pass`. A resolver can treat the directory's answer as cryptographically backed.",
  },
  {
    id: "young-did",
    title: "Young DID — anchored, but nothing is immutable yet",
    threat: "Not an attack — the two-tier model in action. A freshly-anchored DID whose ops are all still inside the 72h window, so the anchor has made nothing immutable. There is no confirmed history to contradict.",
    class: "read",
    benign: true,
    setup: [
      `DID ${did} is anchored, but its only op is recent — still nullifiable inside the 72h recovery window.`,
      "The anchor's CONFIRMED tier is empty; it holds only a TENTATIVE tip.",
      "The directory serves that same recent op.",
    ],
    anchor: anchorView({ confirmedHead: "", tentativeHead: A }),
    directory: { auditLog: [auditEntry(G, genesis, Date.parse("2026-06-29T00:00:00Z")), auditEntry(A, opA, Date.parse("2026-06-29T12:00:00Z"))] },
    expect: { status: "tentative-consistent", reason: "within-window-uncommitted" },
    lesson:
      "With nothing confirmed, the strongest honest answer is `tentative-consistent`, never an alarm. The anchor refuses to assert immutability it hasn't earned yet — there is no hard `reject-unless-confirmed` gate (REFERENCE.md §4).",
  },
  {
    id: "honest-lag",
    title: "Honest lag — the directory is legitimately ahead",
    threat: "Not an attack — the benign case the alarm must never fire on. The directory has accepted a new, valid op the anchor hasn't ingested/confirmed yet. A trigger-happy check would cry wolf here, and the operator would disable it (Phase 5 plan §0).",
    class: "read",
    benign: true,
    setup: [
      `DID ${did} is anchored, with opA (${A.slice(0, 16)}…) as its CONFIRMED head.`,
      "The directory honestly serves genesis → opA → opB: it has moved on to a newer op (opB) the anchor hasn't confirmed yet.",
      "opA — everything the anchor has proven — is still right there on the directory's live chain.",
    ],
    anchor: anchorView({ confirmedHead: A, tentativeHead: A }),
    directory: { auditLog: [auditEntry(G, genesis, Date.parse("2026-02-01T00:00:00Z")), auditEntry(A, opA, Date.parse("2026-03-01T00:00:00Z")), auditEntry(B, opB, Date.parse("2026-06-29T00:00:00Z"))] },
    expect: { status: "tentative-consistent", reason: "confirmed-head-in-live-chain" },
    lesson:
      "The histories AGREE on everything the anchor has proven — the only difference is newer ops the anchor hasn't caught up to. `tentative-consistent`, not an alarm. This restraint is what earns the alarm its credibility: `diverged` means something precisely because lag does not trigger it.",
  },
  {
    id: "equivocation",
    title: "Equivocation — a mirror omits a confirmed op",
    threat: "An attacker controls (or compromises) the PLC mirror a victim resolver queries, and serves a forged history that forks below — and omits — an op the anchor already made immutable.",
    class: "read",
    benign: false,
    setup: [
      `DID ${did} is anchored. Its real history is genesis → opA → opB.`,
      `The anchor has made opB (${B.slice(0, 16)}…) its CONFIRMED head — proven on Starknet, immutable past the 72h window.`,
      "The malicious mirror instead serves genesis → a forged op, omitting opA and opB entirely. The forged head is months old, so this cannot be ingest lag.",
    ],
    anchor: anchorView({ confirmedHead: B, tentativeHead: B }),
    directory: { auditLog: [auditEntry(G, genesis, Date.parse("2024-01-01T00:00:00Z")), auditEntry(F, opForged, Date.parse("2024-01-02T00:00:00Z"))] },
    expect: { status: "diverged", reason: "confirmed-head-absent" },
    lesson:
      "The witness verifies the confirmed head against an independently-fetched root, then finds it NOWHERE in the mirror's live chain — and the mirror's head is far too old to be lag. This is the sole actionable alarm — `diverged`, the DMARC `reject`. A resolver acts on it unilaterally: no PLC-side coordination, no trust in the mirror.",
  },
  {
    id: "vanishing-did",
    title: "Vanishing DID — a mirror erases an anchored identity",
    threat: "A censoring mirror returns an empty (or 404) audit log for a DID the anchor knows is anchored — trying to make an identity simply disappear from a resolver's view.",
    class: "read",
    benign: false,
    setup: [
      `DID ${did} is anchored with opB (${B.slice(0, 16)}…) as its CONFIRMED head.`,
      "The malicious mirror serves an EMPTY audit log — as if the DID never existed.",
    ],
    anchor: anchorView({ confirmedHead: B, tentativeHead: B }),
    directory: { auditLog: [] },
    expect: { status: "diverged", reason: "confirmed-head-absent" },
    lesson:
      "An anchored DID cannot be silently erased. The anchor still proves a confirmed head the (empty) directory serves nothing for, and an absent directory head is not within any skew horizon → `diverged`. Censorship by omission is exactly what the anchor makes detectable.",
  },
  {
    id: "window-edge-skew",
    title: "Window-edge skew — a contradiction that benign skew could explain (the §0 wall)",
    threat: "The hardest case, and the one a naive check gets fatally wrong. Near the 72h edge, the anchor (later clock) can accept a recovery the directory rejected — committing to a head the directory never served. That looks IDENTICAL to omission, but it is benign. Alarming here would be a false positive, and false positives get the check turned off.",
    class: "read",
    benign: true,
    setup: [
      `DID ${did} is anchored; the anchor's CONFIRMED head is opB (${B.slice(0, 16)}…).`,
      "The directory's live chain does NOT contain opB — but its head is RECENT (a few days old), well inside the conservative skew horizon.",
      "Without the anchor's exact per-op observation time, this is indistinguishable from a window-edge recovery the two sides timed differently.",
    ],
    anchor: anchorView({ confirmedHead: B, tentativeHead: B }),
    directory: { auditLog: [auditEntry(G, genesis, Date.parse("2026-06-20T00:00:00Z")), auditEntry(F, opForged, Date.parse("2026-06-25T00:00:00Z"))] },
    expect: { status: "tentative-consistent", reason: "skew-pending" },
    lesson:
      "Same contradiction as `equivocation`, but the directory's head is recent enough that clock skew could explain it — so the witness defers with `skew-pending`, NOT `diverged`. This is the governing invariant made executable: when skew can plausibly explain a disagreement, never alarm. Re-evaluate once the window closes.",
  },
  {
    id: "anchor-self-fault",
    title: "Anchor self-fault — the witness distrusts its own unproven head",
    threat: "Not a directory attack — a humility check. If the anchor returns a confirmed head whose inclusion proof does NOT reconstruct the independently-fetched root (a node bug, a stale read, a malicious RPC), the witness must not blame the directory for it.",
    class: "read",
    benign: true,
    setup: [
      `DID ${did} is anchored and the anchor claims a confirmed head — but its own inclusion proof fails to verify against the confirmed root the resolver fetched.`,
      "The directory, meanwhile, serves a totally different and old history.",
    ],
    anchor: anchorView({ confirmedHead: A, tentativeHead: A, faultProof: true }),
    directory: { auditLog: [auditEntry("bafyreiunrelatedoldheadxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", {}, Date.parse("2020-01-01T00:00:00Z"))] },
    expect: { status: "tentative-consistent", reason: "anchor-proof-unverified" },
    lesson:
      "Even with a directory that looks divergent, an UNPROVEN anchor head yields `tentative-consistent`, not `diverged`. The witness alarms only on what it can cryptographically stand behind — an anchor-side fault is the anchor's problem, never grounds to accuse the directory.",
  },
  {
    id: "coverage-gap",
    title: "Coverage gap — the DID isn't anchored at all",
    threat: "Not an attack — honesty about scope. DIDMARC is opt-in per DID (membership is off-chain policy). For a DID nobody anchored, the witness has no opinion to offer — and must say so rather than imply safety.",
    class: "read",
    benign: true,
    setup: [
      `DID ${did} has never been anchored.`,
      "The directory serves whatever it serves; the witness has no on-chain proof to compare against.",
    ],
    anchor: anchorView({ anchored: false, confirmedHead: "", tentativeHead: "" }),
    directory: { auditLog: [auditEntry(G, genesis, Date.parse("2026-01-01T00:00:00Z"))] },
    expect: { status: "absent", reason: "not-anchored" },
    lesson:
      "`absent` is the DMARC `p=none`: no coverage, no claim. The witness never fabricates confidence for a DID outside its roster — a resolver knows precisely where the protection applies and where it doesn't.",
  },
];

// ── Write-side: malicious submissions to the permissionless endpoint ─────────────────────────
// A second DID with three priority-ordered rotation keys [k0, k1, k2], so recovery-priority
// attacks are expressible. Ground-truth comes from @did-plc/lib `assureValidNextOp` — the same
// oracle the Cairo contract is differential-green against (recovery_vectors_generated.cairo).
const r0 = await Secp256k1Keypair.import("a1".repeat(32), { exportable: true });
const r1 = await Secp256k1Keypair.import("b2".repeat(32), { exportable: true });
const r2 = await Secp256k1Keypair.import("c3".repeat(32), { exportable: true });
const rAt = await Secp256k1Keypair.import("d4".repeat(32), { exportable: true });

const { op: rGenesis, did: rDid } = await createOp({
  signingKey: rAt.did(),
  rotationKeys: [r0.did(), r1.did(), r2.did()],
  handle: "recovery-demo.test",
  pds: "https://pds.recovery-demo.test",
  signer: r0,
});
// opA: a normal update signed by the index-1 key — the op a recovery would dispute.
const rOpA = await createUpdateOp(rGenesis, r1, async (o) => ({ ...o, alsoKnownAs: ["at://recovery-a.test"] }));
// Recovery candidates fork at genesis (prev = genesis), nullifying opA.
const recByK2 = await createUpdateOp(rGenesis, r2, async (o) => ({ ...o, alsoKnownAs: ["at://recovery-weak.test"] })); // weaker key
const recByK0 = await createUpdateOp(rGenesis, r0, async (o) => ({ ...o, alsoKnownAs: ["at://recovery-strong.test"] })); // valid key (used late)
// A valid append, which we then forge the signature of.
const appendByK1 = await createUpdateOp(rOpA, r1, async (o) => ({ ...o, alsoKnownAs: ["at://append-ok.test"] }));
const forgedSig = { ...appendByK1, sig: `${appendByK1.sig.slice(0, -4)}AAAA` };

const HOUR = 60 * 60 * 1000;
const rec = async (op, createdAt) => ({ cid: CID.create(1, 0x71, await mfSha256.digest(encode(op))), operation: op, createdAt });

// Assert the authoritative oracle rejects each adversarial op (throws otherwise — the CI gate).
async function assertRejected(label, chain, proposed) {
  let rejected = false;
  try {
    await assureValidNextOp(rDid, chain, proposed);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`adversarial: oracle UNEXPECTEDLY ACCEPTED "${label}" — fixture would be unsound`);
}

const recentChain = [await rec(rGenesis, new Date(Date.now() - 2 * HOUR)), await rec(rOpA, new Date(Date.now() - 1 * HOUR))];
const agedChain = [await rec(rGenesis, new Date(Date.now() - 100 * HOUR)), await rec(rOpA, new Date(Date.now() - 73 * HOUR))];
// Weaker-key recovery: opA recent, recovery signed by the index-2 (weaker) key.
await assertRejected("weaker-key-recovery", recentChain, recByK2);
// Late recovery: valid key, but the disputed op is older than the 72h window.
await assertRejected("late-recovery", agedChain, recByK0);
// 4a — recovery of imported history. The SAME recovery on the real aged chain is rejected by the
// oracle as late (opA's authored window closed), so rejecting it is correct. But the anchor stamps
// imported ops with the import time, not their real authored time, so its late-recovery check
// can't see that age — its in-contract defender is instead the provenance rule
// (recovery-of-imported), proven in Cairo by tests::anchor::recovery_cannot_nullify_imported_history.
// Same oracle fact, different in-contract defender depending on op provenance.
await assertRejected("recovery-of-imported (oracle rejects on real age)", agedChain, recByK0);
// Forged signature: a well-formed append whose signature has been tampered.
await assertRejected("forged-signature", recentChain, forgedSig);

// Integrity mismatch (ingest gate): a mirror publishes op bytes under a CID they don't hash to.
const tamperedOpA = { ...rOpA, alsoKnownAs: ["at://tampered-not-resigned.test"] };
const claimedCid = await cidOf(rOpA); // what the mirror claims
const actualCid = await cidOf(tamperedOpA); // what the served bytes actually hash to
if (claimedCid === actualCid) throw new Error("adversarial: tampered op unexpectedly kept its CID");

const writeScenarios = [
  {
    id: "forged-signature",
    title: "Forged signature — an unsigned op submitted as authentic",
    threat: "Anyone can call the permissionless endpoint and pay the gas (that's the design). So an attacker submits a well-formed op for a victim DID with a signature they don't hold the key for.",
    class: "write",
    proposed: [
      `forks at opA on ${rDid}, presented as a normal append`,
      "signature: tampered (does not verify under any of the DID's rotation keys)",
    ],
    verdict: {
      rejected: true,
      reason: "invalid-sig",
      defender: "plc_core::op_verify / sig_verify (in-contract)",
      provenance: "Ground-truthed at fixture-generation time against `@did-plc/lib` `assureValidNextOp` — the same oracle the contract is differential-green against (recovery_vectors_generated.cairo); this generator throws if such an op is ever accepted.",
    },
    lesson:
      "Authorization is the op's EMBEDDED signature, verified in-contract against the fork-point's rotation keys — never the Starknet fee-payer. The transaction can be paid by anyone; the op still has to be signed by a real PLC key. The forgery is rejected before any state changes (`invalid-sig`).",
  },
  {
    id: "weaker-key-recovery",
    title: "Weaker-key recovery — a low-priority key tries to override a higher one",
    threat: "An attacker who holds only a LOW-priority rotation key (e.g. a leaked device key) tries to fork the history and nullify an op signed by a HIGHER-priority key — a recovery they aren't entitled to make.",
    class: "write",
    proposed: [
      `forks at genesis on ${rDid}, nullifying opA (which was signed by rotation key index 1)`,
      "signed by rotation key index 2 — strictly lower priority than the key it tries to override",
    ],
    verdict: {
      rejected: true,
      reason: "recovery-weaker-key",
      defender: "plc_core::recovery (in-contract)",
      provenance: "Ground-truthed at fixture-generation time against `@did-plc/lib` `assureValidNextOp` — the same oracle the contract is differential-green against (recovery_vectors_generated.cairo); this generator throws if such an op is ever accepted.",
    },
    lesson:
      "PLC recovery only flows downward in priority: a fork is valid only if signed by a key of STRICTLY higher priority than the disputed op's signer. The weaker key cannot override the stronger one, so the contract rejects (`recovery-weaker-key`) — the key hierarchy is enforced on-chain, not assumed.",
  },
  {
    id: "late-recovery",
    title: "Late recovery — a valid key, but after the 72h window",
    threat: "An attacker holds a high-priority key and attempts a legitimate-looking recovery — but the op being disputed is already older than the 72h recovery window, so the recovery is no longer permitted.",
    class: "write",
    proposed: [
      `forks at genesis on ${rDid}, signed by the highest-priority key (index 0)`,
      "the disputed op was created more than 72h ago — outside the recovery window",
    ],
    verdict: {
      rejected: true,
      reason: "late-recovery",
      defender: "plc_core::recovery (in-contract)",
      provenance: "Ground-truthed at fixture-generation time against `@did-plc/lib` `assureValidNextOp` — the same oracle the contract is differential-green against (recovery_vectors_generated.cairo); this generator throws if such an op is ever accepted.",
    },
    lesson:
      "Even the strongest key can't rewrite history indefinitely. Once an op has survived the 72h window it is immutable, and a fork below it is rejected (`late-recovery`). This is the window that makes the confirmed tier meaningful — and it's enforced on the directory-assigned clock, the same input PLC uses.",
  },
  {
    id: "recovery-of-imported",
    title: "Recovery of imported history — a rotated-out key exploits the import-time clock (4a)",
    threat:
      "The 4a capture. A DID's history is IMPORTED (settled backfill), and the anchor stamps every op with the import time — not its real authored time (`createdAt` is not in the signed op). So for 72h after onboarding the whole history looks freshly authored. A higher-priority rotation key that was long ago ROTATED AWAY — the custodial→self-hosted migration leaves exactly such a key, no longer the DID's controller — forks below the real history and nullifies it, capturing the anchored DID inside that window.",
    class: "write",
    proposed: [
      `forks at genesis on ${rDid}, nullifying opA — an IMPORTED op whose REAL createdAt is >72h old (its recovery window closed long ago)`,
      "signed by a strictly-higher-priority key (index 0) — in the field, a rotated-out custodial key no longer controlling the DID",
      "the anchor's import-time stamp makes opA look fresh, so the 72h late-recovery check ALONE would accept this and let the DID be captured",
    ],
    verdict: {
      rejected: true,
      reason: "recovery-of-imported",
      defender: "plc_core::state::apply_op (in-contract)",
      provenance:
        "Two-part. (1) On the REAL aged chain, `@did-plc/lib` `assureValidNextOp` rejects this recovery as late (opA's authored window closed) — so rejecting it is correct, and this generator throws if the oracle ever accepts it. (2) The anchor cannot see that age — it stamped opA at import time — so its in-contract defender is the provenance rule, not the window check: `state::apply_op` refuses a recovery that nullifies an imported op. Proven by `plc_core::tests::anchor::recovery_cannot_nullify_imported_history`, contrasted with `recovery_through_contract` where a LIVE-observed opA (honest block-time clock) remains recoverable.",
    },
    lesson:
      "The 72h late-recovery check has a blind spot: it measures against the anchor's clock, which for backfilled history is the import time, not the op's real authored time. That blind spot IS the 4a capture — a rotated-out higher-priority key re-opening a window that closed years ago. The fix marks imported ops SETTLED (a recovery may not nullify them), so the window is honored only for live-observed ops whose block-time stamp approximates their real authored time. Onboarding via `import` (not op-by-op `submit_op`) is what preserves that provenance. (SECURITY-TODO 4a.)",
  },
  {
    id: "integrity-mismatch",
    title: "Integrity mismatch — bytes that don't hash to their claimed CID",
    threat: "A malicious mirror feeds the off-chain ingest pipeline op bytes under a CID they were never the hash of (tampered content presented as an existing, valid op) — hoping a forged delta lands on-chain.",
    class: "write",
    proposed: [
      `serves op bytes claiming CID ${claimedCid.slice(0, 20)}…`,
      `but the bytes actually hash to ${actualCid.slice(0, 20)}… (content was altered without re-signing)`,
    ],
    verdict: {
      rejected: true,
      reason: "cid-mismatch (delta dropped)",
      defender: "ingest integrity gate (off-chain)",
      provenance: "Verified at fixture-generation time by recomputing the operation's canonical DRISL CID and confirming it differs from the claimed CID — the exact integrity check `ingest::reencode` runs before submitting any delta.",
    },
    lesson:
      "Before submitting any delta, ingest re-encodes the operation to canonical DRISL and checks the resulting CID equals the directory's published CID. Tampered bytes hash to a different CID, so the delta is dropped and never reaches the endpoint. The integrity gate means the feeder can't be tricked into anchoring forged content even by the source it reads from.",
  },
];

const fixture = {
  _generated: "by conformance/src/gen-adversarial-scenarios.mjs — DO NOT EDIT. Run: make gen-adversarial-scenarios",
  _about: "DIDMARC adversarial-validation scenarios: real signed did:plc chains + a malicious mirror / malicious submission → the expected graduated status (read) or rejection (write).",
  now: NOW,
  skewHorizonMs: SKEW_HORIZON_MS,
  scenarios: [...readScenarios, ...writeScenarios],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`gen-adversarial-scenarios: ${readScenarios.length} read + ${writeScenarios.length} write → ${outPath}`);
console.log(`  read did  = ${did}`);
console.log(`  write did = ${rDid}`);
for (const s of readScenarios) console.log(`  [read:${s.id}] expect ${s.expect.status} (${s.expect.reason})`);
for (const s of writeScenarios) console.log(`  [write:${s.id}] rejected (${s.verdict.reason})`);
