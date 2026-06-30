// Generator for the 72h-recovery differential vectors (P2.5 classify + P3.3 apply_op).
//
// Uses FIXED private keys so the whole scenario — ops, signatures, CIDs — is deterministic
// and the generated Cairo file is byte-stable (CI drift-checks it). Builds a real DID with
// three priority-ordered rotation keys [k0, k1, k2], runs the authoritative
// `assureValidNextOp` for ground truth, and emits two tables:
//   - recovery_vectors():  numeric inputs to classify_next_op + the reference outcome.
//   - recovery_scenario(): the actual op bytes (genesis, opA, recovery-by-k0, recovery-by-k2)
//     so state::apply_op can be driven end-to-end over a real chain.
//
// Run via `make gen-recovery-vectors`; CI asserts no drift.
import { Secp256k1Keypair } from "@atproto/crypto";
import { createOp, createUpdateOp, assureValidNextOp } from "@did-plc/lib";
import { encode } from "@ipld/dag-cbor";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(
  here,
  "..",
  "..",
  "cairo",
  "packages",
  "plc_core",
  "tests",
  "recovery_vectors_generated.cairo",
);

const HOUR = 60 * 60 * 1000;
const NOW = 1700000000000;

// Fixed 32-byte private keys → deterministic ops/signatures. [k0, k1, k2] are priority
// ordered (index 0 = highest); atKey is the verification (atproto) key.
const FIXED = {
  k0: "1111111111111111111111111111111111111111111111111111111111111111",
  k1: "2222222222222222222222222222222222222222222222222222222222222222",
  k2: "3333333333333333333333333333333333333333333333333333333333333333",
  at: "4444444444444444444444444444444444444444444444444444444444444444",
};
const k0 = await Secp256k1Keypair.import(FIXED.k0, { exportable: true });
const k1 = await Secp256k1Keypair.import(FIXED.k1, { exportable: true });
const k2 = await Secp256k1Keypair.import(FIXED.k2, { exportable: true });
const atKey = await Secp256k1Keypair.import(FIXED.at, { exportable: true });

const hex = (op) => Buffer.from(encode(op)).toString("hex");
async function rec(op, createdAt) {
  const cid = CID.create(1, 0x71, await sha256.digest(encode(op)));
  return { cid, operation: op, createdAt };
}

const { op: genesis, did } = await createOp({
  signingKey: atKey.did(),
  rotationKeys: [k0.did(), k1.did(), k2.did()],
  handle: "recovery.test",
  pds: "https://pds.recovery.test",
  signer: k0,
});
// opA builds on genesis, signed by the index-1 key — the op a recovery disputes.
const opA = await createUpdateOp(genesis, k1, async (o) => ({
  ...o,
  alsoKnownAs: ["at://recovery-a.test"],
}));
// Recovery candidates fork at genesis (prev = genesis), nullifying opA.
const recoveryByK0 = await createUpdateOp(genesis, k0, async (o) => ({
  ...o,
  alsoKnownAs: ["at://recovery-k0.test"],
}));
const recoveryByK2 = await createUpdateOp(genesis, k2, async (o) => ({
  ...o,
  alsoKnownAs: ["at://recovery-k2.test"],
}));
const appendByK1 = await createUpdateOp(opA, k1, async (o) => ({
  ...o,
  alsoKnownAs: ["at://append-k1.test"],
}));

// ── Numeric classify vectors (P2.5) ──────────────────────────────────────────
async function scenario({
  label,
  proposed,
  disputedAgeMs,
  proposedSignerIndex,
  nullifiedCount,
  firstNullifiedSignerIndex,
}) {
  const ops = [
    await rec(genesis, new Date(NOW - 100 * HOUR)),
    await rec(opA, new Date(Date.now() - disputedAgeMs)),
  ];
  let accepted;
  let actualNullified = 0;
  try {
    const result = await assureValidNextOp(did, ops, proposed);
    accepted = true;
    actualNullified = result.nullified.length;
  } catch {
    accepted = false;
  }
  return {
    label,
    proposed_signer_index: proposedSignerIndex,
    nullified_count: nullifiedCount,
    first_nullified_signer_index: firstNullifiedSignerIndex,
    created_at: NOW - disputedAgeMs,
    now: NOW,
    expect_ok: accepted,
    expect_class: accepted ? (actualNullified > 0 ? "recovery" : "append") : "",
  };
}

const vectors = [
  await scenario({
    label: "append (extends head)",
    proposed: appendByK1,
    disputedAgeMs: 1 * HOUR,
    proposedSignerIndex: 1,
    nullifiedCount: 0,
    firstNullifiedSignerIndex: 0,
  }),
  await scenario({
    label: "recovery valid (higher key, in window)",
    proposed: recoveryByK0,
    disputedAgeMs: 1 * HOUR,
    proposedSignerIndex: 0,
    nullifiedCount: 1,
    firstNullifiedSignerIndex: 1,
  }),
  await scenario({
    label: "recovery weaker key (rejected)",
    proposed: recoveryByK2,
    disputedAgeMs: 1 * HOUR,
    proposedSignerIndex: 2,
    nullifiedCount: 1,
    firstNullifiedSignerIndex: 1,
  }),
  await scenario({
    label: "recovery late (outside window, rejected)",
    proposed: recoveryByK0,
    disputedAgeMs: 73 * HOUR,
    proposedSignerIndex: 0,
    nullifiedCount: 1,
    firstNullifiedSignerIndex: 1,
  }),
];

// ── End-to-end scenario (P3.3 apply_op) ───────────────────────────────────────
// Confirm the reference's verdicts for the chain [genesis, opA] once more, with the bytes
// we emit, so apply_op is driven against ground truth.
{
  // createdAt is metadata (not in the op bytes); use a within-window age so the reference's
  // Date.now()-based check accepts the valid recovery.
  const chain = [
    await rec(genesis, new Date(Date.now() - 2 * HOUR)),
    await rec(opA, new Date(Date.now() - 1 * HOUR)),
  ];
  const ok = await assureValidNextOp(did, chain, recoveryByK0); // within window (Date.now)
  if (ok.nullified.length !== 1) {
    throw new Error("expected recovery-by-k0 to nullify exactly opA");
  }
  let weakRejected = false;
  try {
    await assureValidNextOp(did, chain, recoveryByK2);
  } catch {
    weakRejected = true;
  }
  if (!weakRejected) throw new Error("expected recovery-by-k2 to be rejected");
}
const genesisFragment = base32
  .encode((await sha256.digest(encode(genesis))).digest.slice(0, 15))
  .slice(1, 25);

const numericLines = vectors.map(
  (v) =>
    `        RecoveryVector {
            proposed_signer_index: ${v.proposed_signer_index},
            nullified_count: ${v.nullified_count},
            first_nullified_signer_index: ${v.first_nullified_signer_index},
            created_at: ${v.created_at},
            now: ${v.now},
            expect_ok: ${v.expect_ok},
            expect_class: "${v.expect_class}",
        }, // ${v.label}`,
);

const out = `//! @generated by conformance/src/gen-recovery-vectors.mjs — DO NOT EDIT.
//!
//! 72h-recovery vectors (REFERENCE.md §4, §5), ground-truthed against @did-plc/lib
//! assureValidNextOp. Deterministic (fixed keys) — regenerate with
//! \`make gen-recovery-vectors\`; CI drift-checks.
//!   recovery_vectors():  numeric inputs to classify_next_op + reference outcome.
//!   recovery_scenario(): op bytes for driving state::apply_op end-to-end.

#[derive(Drop)]
pub struct RecoveryVector {
    pub proposed_signer_index: usize,
    pub nullified_count: usize,
    pub first_nullified_signer_index: usize,
    pub created_at: u64,
    pub now: u64,
    pub expect_ok: bool,
    pub expect_class: ByteArray,
}

pub fn recovery_vectors() -> Array<RecoveryVector> {
    array![
${numericLines.join("\n")}
    ]
}

/// A real DID chain forking at genesis: opA (signed by index-1 key) is the disputed op;
/// recovery_k0 (index 0, higher) is a valid recovery; recovery_k2 (index 2, weaker) is not.
#[derive(Drop)]
pub struct RecoveryScenario {
    pub did: ByteArray,
    pub genesis_hex: ByteArray,
    pub op_a_hex: ByteArray,
    pub recovery_k0_hex: ByteArray,
    pub recovery_k2_hex: ByteArray,
}

pub fn recovery_scenario() -> RecoveryScenario {
    RecoveryScenario {
        did: "did:plc:${genesisFragment}",
        genesis_hex: "${hex(genesis)}",
        op_a_hex: "${hex(opA)}",
        recovery_k0_hex: "${hex(recoveryByK0)}",
        recovery_k2_hex: "${hex(recoveryByK2)}",
    }
}
`;

writeFileSync(outPath, out);
console.log(`gen-recovery-vectors: ${vectors.length} numeric + 1 scenario → ${outPath}`);
for (const v of vectors) {
  console.log(`  [${v.label}] ok=${v.expect_ok} class=${v.expect_class || "reject"}`);
}
