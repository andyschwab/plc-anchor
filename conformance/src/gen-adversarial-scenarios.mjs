// Generator for the DIDMARC adversarial-validation scenarios (testnet adversarial suite).
//
// Builds REAL signed did:plc chains with @did-plc/lib (the same authoritative stack the
// conformance corpus trusts), applies an attacker's twist to what a malicious PLC mirror
// *serves*, computes the anchor's real sha256-Merkle commitment (confirmed/tentative root +
// inclusion proof, byte-identical to merkle.cairo / witness-ts/src/merkle.ts), and emits a
// fully self-describing fixture: data (chains, roots, proofs, adversarial audit logs) AND
// prose (threat, setup, lesson) AND the expected graduated status.
//
// One source of truth, three consumers: the offline runner (CI assertion gate), the narrative
// report (docs/ADVERSARIAL-REPORT.md — the engineer-facing artifact), and later the live
// testnet runner. Deterministic (fixed keys) so the fixture is byte-stable and CI drift-checks.
//
// Output: adversarial/scenarios.generated.json. Re-run: make gen-adversarial-scenarios.
import { Secp256k1Keypair } from "@atproto/crypto";
import { createOp, createUpdateOp } from "@did-plc/lib";
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

// ── A real did:plc chain (fixed keys → deterministic CIDs) ───────────────────────────────────
const FIXED = {
  k0: "1111111111111111111111111111111111111111111111111111111111111111",
  at: "4444444444444444444444444444444444444444444444444444444444444444",
};
const k0 = await Secp256k1Keypair.import(FIXED.k0, { exportable: true });
const atKey = await Secp256k1Keypair.import(FIXED.at, { exportable: true });

const cidOf = async (op) => (await CID.create(1, 0x71, await mfSha256.digest(encode(op)))).toString(base32);

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
// history. A real, well-formed op; the lie is in *which* chain the directory serves, not the op.
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

// Build the anchor view for a (confirmedHead, tentativeHead): real roots + inclusion proofs
// over a commitment that includes the sibling subjects.
function anchorView(confirmedHead, tentativeHead) {
  const c = commit({ [did]: confirmedHead, ...SIBLINGS }, did);
  const t = commit({ [did]: tentativeHead, ...SIBLINGS }, did);
  return {
    did,
    anchored: true,
    confirmedHead,
    tentativeHead,
    confirmedRoot: c.root,
    confirmedProof: c.proof,
    tentativeRoot: t.root,
    tentativeProof: t.proof,
  };
}

// ── The scenario catalogue (vertical slice: the alarm + the restraint) ───────────────────────
const scenarios = [
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
    anchor: anchorView(B, B),
    directory: {
      auditLog: [
        auditEntry(G, genesis, Date.parse("2024-01-01T00:00:00Z")),
        auditEntry(F, opForged, Date.parse("2024-01-02T00:00:00Z")),
      ],
    },
    expect: { status: "diverged", reason: "confirmed-head-absent" },
    lesson:
      "The witness re-derives the anchor's confirmed root from an independently-fetched inclusion proof, then finds the confirmed head is NOWHERE in the mirror's live chain and the mirror's head is far too old to be lag. This is the sole actionable alarm — `diverged`, the DMARC `reject`. A resolver acts on it unilaterally: no PLC-side coordination, no trust in the mirror.",
  },
  {
    id: "honest-lag",
    title: "Honest lag — the directory is legitimately ahead",
    threat: "Not an attack — the benign case the alarm must never fire on. The directory has accepted a new, valid op the anchor has not ingested/confirmed yet. A trigger-happy check would cry wolf here, and the operator would disable it (Phase 5 plan §0).",
    class: "read",
    benign: true,
    setup: [
      `DID ${did} is anchored, with opA (${A.slice(0, 16)}…) as its CONFIRMED head.`,
      "The directory honestly serves genesis → opA → opB: it has moved on to a newer op (opB) that the anchor simply hasn't confirmed yet.",
      "opA — everything the anchor has proven — is still right there on the directory's live chain.",
    ],
    anchor: anchorView(A, A),
    directory: {
      auditLog: [
        auditEntry(G, genesis, Date.parse("2026-02-01T00:00:00Z")),
        auditEntry(A, opA, Date.parse("2026-03-01T00:00:00Z")),
        auditEntry(B, opB, Date.parse("2026-06-29T00:00:00Z")),
      ],
    },
    expect: { status: "tentative-consistent", reason: "confirmed-head-in-live-chain" },
    lesson:
      "The histories AGREE on everything the anchor has proven — the only difference is newer ops the anchor hasn't caught up to. The witness reports `tentative-consistent`, not an alarm. This restraint is what earns the alarm its credibility: `diverged` means something precisely because lag does not trigger it.",
  },
];

const fixture = {
  _generated: "by conformance/src/gen-adversarial-scenarios.mjs — DO NOT EDIT. Run: make gen-adversarial-scenarios",
  _about: "DIDMARC adversarial-validation scenarios: real signed did:plc chains + a malicious mirror's served history + the anchor's real Merkle commitment → the expected graduated status.",
  now: NOW,
  skewHorizonMs: SKEW_HORIZON_MS,
  scenarios,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`gen-adversarial-scenarios: ${scenarios.length} scenarios → ${outPath}`);
console.log(`  did = ${did}`);
console.log(`  chain: genesis=${G.slice(0, 20)}… opA=${A.slice(0, 20)}… opB=${B.slice(0, 20)}…`);
for (const s of scenarios) {
  console.log(`  [${s.id}] expect ${s.expect.status} (${s.expect.reason})`);
}
