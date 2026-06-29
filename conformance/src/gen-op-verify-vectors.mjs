// Generator for the op_verify differential test vectors consumed by plc_core snforge tests.
//
// Reads corpus.json, re-validates every entry with assureValidSig (@did-plc/lib), then
// emits cairo/packages/plc_core/tests/op_verify_vectors_generated.cairo.
//
// Run via `make gen-op-verify-vectors`; CI asserts no drift.
import { assureValidSig } from "@did-plc/lib";
import { verifySignature } from "@atproto/crypto";
import { encode } from "@ipld/dag-cbor";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "..", "vectors", "plc-ops", "corpus.json");
const outPath = join(
  here,
  "..",
  "..",
  "cairo",
  "packages",
  "plc_core",
  "tests",
  "op_verify_vectors_generated.cairo",
);

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

// The op's OWN declared rotation set (empty for a tombstone); legacy `create` normalizes
// to [recoveryKey, signingKey] to mirror the Cairo decoder.
function ownRotationKeys(op) {
  if (op.type === "create") return [op.recoveryKey, op.signingKey];
  return op.rotationKeys ?? [];
}

const vectors = [];
for (const e of corpus) {
  const op = e.operation;
  const isGenesis = op.prev === null || op.prev === undefined;

  // Authorized signer set (P2.3): a genesis op is authorized by its own rotation keys; a
  // non-genesis op by the PREVIOUS op's rotation keys (found by matching prev → cid in the
  // corpus chain). This is the set the embedded signature is checked against.
  let allowedKeys;
  let prevSignedHex = "";
  if (isGenesis) {
    allowedKeys = ownRotationKeys(op);
  } else {
    const prevEntry = corpus.find((x) => x.cid === op.prev);
    if (!prevEntry) {
      throw new Error(`[${e.label}] prev CID ${op.prev} not found in corpus chain`);
    }
    allowedKeys = ownRotationKeys(prevEntry.operation);
    prevSignedHex = prevEntry.drisl_hex; // predecessor's signed bytes, for the link gate
  }

  // Differential: @did-plc/lib must accept the sig against the authorized set, and the
  // signer's index in that set is the recovery-priority operand (P2.5).
  const signerDid = await assureValidSig(allowedKeys, op);
  const signerIndex = allowedKeys.indexOf(signerDid);
  if (signerIndex < 0) {
    throw new Error(`[${e.label}] signer ${signerDid} not in authorized set`);
  }

  const vmCount =
    op.type === "create"
      ? 1
      : op.verificationMethods
        ? Object.keys(op.verificationMethods).length
        : 0;

  vectors.push({
    label: e.label,
    signed_drisl_hex: e.drisl_hex,
    unsigned_drisl_hex: e.unsigned_drisl_hex,
    signer_did_key: e.signer_did_key,
    op_type: op.type,
    is_genesis: isGenesis,
    prev: isGenesis ? "" : op.prev,
    rotation_keys: ownRotationKeys(op),
    vm_count: vmCount,
    allowed_keys: allowedKeys,
    signer_index: signerIndex,
    prev_signed_hex: prevSignedHex,
  });
}

// ── Negative vectors: high-S signatures the reference REJECTS ────────────────────────
// k256 is low-S-only in the reference (unlike p256). Take the first k256 genesis, flip its
// signature to the high-S form (r, N-s), and confirm @atproto/crypto rejects it — so the
// Cairo verifier must reject it too. This is the differential guard for the curve asymmetry.
const K256_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
const rejectVectors = [];
{
  const base = corpus.find(
    (e) => e.operation.type === "plc_operation" && e.signer_did_key.startsWith("did:key:zQ3"),
  );
  const sig = Buffer.from(base.operation.sig, "base64url");
  const r = sig.subarray(0, 32);
  let s = BigInt("0x" + sig.subarray(32, 64).toString("hex"));
  if (s <= K256_N / 2n) s = K256_N - s; // make high-S
  const sBuf = Buffer.from(s.toString(16).padStart(64, "0"), "hex");
  const highSig = Buffer.concat([r, sBuf]).toString("base64url");

  // Differential assertion: the reference verifier must REJECT this high-S k256 signature.
  const { sig: _drop, ...unsigned } = base.operation;
  const accepted = await verifySignature(
    base.signer_did_key,
    new Uint8Array(encode(unsigned)),
    new Uint8Array(Buffer.from(highSig, "base64url")),
  );
  if (accepted) {
    throw new Error("reference unexpectedly ACCEPTED a high-S k256 sig — asymmetry assumption broken");
  }
  const signedHigh = Buffer.from(encode({ ...base.operation, sig: highSig })).toString("hex");
  rejectVectors.push({
    label: "k256 high-S (must reject)",
    signed_drisl_hex: signedHigh,
    signer_did_key: base.signer_did_key,
  });
}

const rejectLines = rejectVectors.map(
  (v) =>
    `        OpVerifyRejectVector {
            signed_drisl_hex: "${v.signed_drisl_hex}",
            signer_did_key: "${v.signer_did_key}",
        }, // ${v.label}`,
);

const lines = vectors.map(
  (v) =>
    `        OpVerifyVector {
            signed_drisl_hex: "${v.signed_drisl_hex}",
            unsigned_drisl_hex: "${v.unsigned_drisl_hex}",
            signer_did_key: "${v.signer_did_key}",
            op_type: "${v.op_type}",
            is_genesis: ${v.is_genesis},
            prev: "${v.prev}",
            rotation_keys: array![${v.rotation_keys.map((k) => `"${k}"`).join(", ")}],
            vm_count: ${v.vm_count},
            allowed_keys: array![${v.allowed_keys.map((k) => `"${k}"`).join(", ")}],
            signer_index: ${v.signer_index},
            prev_signed_hex: "${v.prev_signed_hex}",
        }, // ${v.label}`,
);

const out = `//! @generated by conformance/src/gen-op-verify-vectors.mjs — DO NOT EDIT.
//!
//! Source: conformance/vectors/plc-ops/corpus.json
//! ${vectors.length} PLC op vectors for the op_verify differential gate (REFERENCE.md §3, §5).
//! Each entry: CBOR bytes of the signed/unsigned op, signer did:key, and the structural
//! decode expectation (type, genesis flag, prev string, own rotation keys, vm count).
//! All signatures validated by @did-plc/lib before generation.
//! Regenerate with \`make gen-op-verify-vectors\`; CI fails if this drifts.

#[derive(Drop)]
pub struct OpVerifyVector {
    pub signed_drisl_hex: ByteArray,
    pub unsigned_drisl_hex: ByteArray,
    pub signer_did_key: ByteArray,
    pub op_type: ByteArray,
    pub is_genesis: bool,
    pub prev: ByteArray,
    pub rotation_keys: Array<ByteArray>,
    pub vm_count: usize,
    /// Authorized signer set: own rotation keys (genesis) or the prev op's (non-genesis).
    pub allowed_keys: Array<ByteArray>,
    /// Index of the actual signer within allowed_keys (recovery-priority operand).
    pub signer_index: usize,
    /// The predecessor op's signed DRISL bytes (hex), for the prev-linkage gate. Empty
    /// for a genesis op.
    pub prev_signed_hex: ByteArray,
}

pub fn op_verify_vectors() -> Array<OpVerifyVector> {
    array![
${lines.join("\n")}
    ]
}

/// Signatures the reference REJECTS (so the Cairo verifier must too). Currently: high-S
/// k256 (low-S is required for k256, unlike p256). Confirmed rejected by @atproto/crypto
/// at generation time.
#[derive(Drop)]
pub struct OpVerifyRejectVector {
    pub signed_drisl_hex: ByteArray,
    pub signer_did_key: ByteArray,
}

pub fn op_verify_reject_vectors() -> Array<OpVerifyRejectVector> {
    array![
${rejectLines.join("\n")}
    ]
}
`;

writeFileSync(outPath, out);
console.log(
  `gen-op-verify-vectors: ${vectors.length} vectors validated and written to ${outPath}`,
);
for (const v of vectors) {
  console.log(`  [${v.label}] signer=${v.signer_did_key.slice(0, 30)}...`);
}
