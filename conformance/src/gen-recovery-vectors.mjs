// Generator for the 72h-recovery differential vectors (P2.5).
//
// Builds real multi-op PLC histories with @did-plc/lib + @atproto/crypto, runs the
// authoritative `assureValidNextOp` to get the accept/reject + nullified ground truth for
// each scenario, and emits a DETERMINISTIC numeric vector table: signer indices, a fixed
// (now, createdAt) pair preserving the scenario's time delta, and the expected outcome.
// The random keys never appear in the output, so the generated file is byte-stable across
// runs and CI can drift-check it.
//
// Run via `make gen-recovery-vectors`; CI asserts no drift.
import { Secp256k1Keypair } from "@atproto/crypto";
import { createOp, createUpdateOp, assureValidNextOp } from "@did-plc/lib";
import { encode } from "@ipld/dag-cbor";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";
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
// Fixed timestamps emitted into the vectors (the reference uses Date.now(); we reproduce
// only the delta, which is all the window check depends on).
const NOW = 1700000000000;

async function rec(op, createdAt) {
  const cid = CID.create(1, 0x71, await sha256.digest(encode(op)));
  return { cid, operation: op, createdAt };
}

// One DID with three priority-ordered rotation keys [k0, k1, k2].
const k0 = await Secp256k1Keypair.create({ exportable: true });
const k1 = await Secp256k1Keypair.create({ exportable: true });
const k2 = await Secp256k1Keypair.create({ exportable: true });
const atKey = await Secp256k1Keypair.create({ exportable: true });

const { op: genesis, did } = await createOp({
  signingKey: atKey.did(),
  rotationKeys: [k0.did(), k1.did(), k2.did()],
  handle: "recovery.test",
  pds: "https://pds.recovery.test",
  signer: k0,
});
// opA builds on genesis, signed by the index-1 key (a lower-priority key) — the op a
// recovery would dispute.
const opA = await createUpdateOp(genesis, k1, async (o) => ({
  ...o,
  alsoKnownAs: ["at://recovery-a.test"],
}));

// Proposed ops:
//  - recovery by k0 / k2: prev = genesis (forks, nullifies opA).
//  - append by k1: prev = opA (extends head).
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

// Scenario builder: history ops (with opA at `disputedAgeMs` old), a proposed op, and the
// Cairo-side facts. Runs the reference to confirm accept/reject, then emits a vector.
async function scenario({
  label,
  proposed,
  disputedAgeMs,
  proposedSignerIndex,
  nullifiedCount,
  firstNullifiedSignerIndex,
}) {
  const ops = [await rec(genesis, new Date(NOW - 100 * HOUR)), await rec(opA, new Date(Date.now() - disputedAgeMs))];
  let accepted;
  let actualNullified = 0;
  let err = "";
  try {
    const result = await assureValidNextOp(did, ops, proposed);
    accepted = true;
    actualNullified = result.nullified.length;
  } catch (e) {
    accepted = false;
    err = e.constructor.name;
  }
  const expectClass = accepted ? (actualNullified > 0 ? "recovery" : "append") : "";
  return {
    label,
    proposed_signer_index: proposedSignerIndex,
    nullified_count: nullifiedCount,
    first_nullified_signer_index: firstNullifiedSignerIndex,
    created_at: NOW - disputedAgeMs,
    now: NOW,
    expect_ok: accepted,
    expect_class: expectClass,
    ref_error: err,
  };
}

const vectors = [];
// Plain append: prev = head (opA), signed by an index-1 key. Nullifies nothing.
vectors.push(
  await scenario({
    label: "append (extends head)",
    proposed: appendByK1,
    disputedAgeMs: 1 * HOUR,
    proposedSignerIndex: 1,
    nullifiedCount: 0,
    firstNullifiedSignerIndex: 0,
  }),
);
// Valid recovery: higher-priority k0 (idx 0) nullifies opA (signed by idx 1), within window.
vectors.push(
  await scenario({
    label: "recovery valid (higher key, in window)",
    proposed: recoveryByK0,
    disputedAgeMs: 1 * HOUR,
    proposedSignerIndex: 0,
    nullifiedCount: 1,
    firstNullifiedSignerIndex: 1,
  }),
);
// Weaker key: k2 (idx 2) cannot nullify opA (signed by idx 1).
vectors.push(
  await scenario({
    label: "recovery weaker key (rejected)",
    proposed: recoveryByK2,
    disputedAgeMs: 1 * HOUR,
    proposedSignerIndex: 2,
    nullifiedCount: 1,
    firstNullifiedSignerIndex: 1,
  }),
);
// Late: higher-priority key but outside the 72h window.
vectors.push(
  await scenario({
    label: "recovery late (outside window, rejected)",
    proposed: recoveryByK0,
    disputedAgeMs: 73 * HOUR,
    proposedSignerIndex: 0,
    nullifiedCount: 1,
    firstNullifiedSignerIndex: 1,
  }),
);

const lines = vectors.map(
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
//! 72h-recovery decision vectors (REFERENCE.md §4, §5), ground-truthed against
//! @did-plc/lib assureValidNextOp. Each entry is the numeric input to classify_next_op
//! plus the reference outcome (expect_ok; expect_class = "append"|"recovery" when ok).
//! Deterministic (no keys) — regenerate with \`make gen-recovery-vectors\`; CI drift-checks.

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
${lines.join("\n")}
    ]
}
`;

writeFileSync(outPath, out);
console.log(`gen-recovery-vectors: ${vectors.length} scenarios → ${outPath}`);
for (const v of vectors) {
  console.log(
    `  [${v.label}] ok=${v.expect_ok} class=${v.expect_class || v.ref_error}`,
  );
}
