// One-time corpus generator for the PLC-op CID/DID + signature acceptance gate.
//
// Generates a small but varied set of synthetic PLC operations using the
// authoritative @did-plc/lib + @atproto/crypto stack, then captures the
// CBOR bytes, expected CID/DID, signer did:key, and unsigned CBOR bytes.
//
// Output: conformance/vectors/plc-ops/corpus.json (commit this file).
// Re-run to refresh: make gen-plc-corpus
// The generated file is the "ground truth" fixture; gen-plc-vectors.mjs and
// gen-op-verify-vectors.mjs re-validate it on every conformance run.
import { Secp256k1Keypair, EcdsaKeypair } from "@atproto/crypto";
import { createOp, createUpdateOp, tombstoneOp } from "@did-plc/lib";
import { encode } from "@ipld/dag-cbor";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "vectors", "plc-ops");
mkdirSync(outDir, { recursive: true });

async function entry(op, did, signerKey) {
  const bytes = encode(op);
  const digest = await sha256.digest(bytes);
  const cid = CID.create(1, 0x71 /* dag-cbor */, digest);
  // Compute unsigned bytes (op without the `sig` field).
  const { sig: _sig, ...opData } = op;
  const unsignedBytes = encode(opData);
  return {
    did,
    operation: op,
    cid: cid.toString(base32),
    cid_hex: Buffer.from(cid.bytes).toString("hex"),
    drisl_hex: Buffer.from(bytes).toString("hex"),
    signer_did_key: signerKey,
    unsigned_drisl_hex: Buffer.from(unsignedBytes).toString("hex"),
    // Internal: expose the CID object so tombstoneOp callers can use it.
    _cid: cid,
  };
}

const corpus = [];

// ── Case 1: secp256k1 genesis ──────────────────────────────────────────────
const rot1 = await Secp256k1Keypair.create({ exportable: true });
const atKey1 = await Secp256k1Keypair.create({ exportable: true });
const { op: genesis1, did: did1 } = await createOp({
  signingKey: atKey1.did(),
  rotationKeys: [rot1.did()],
  handle: "alice.test",
  pds: "https://pds.alice.test",
  signer: rot1,
});
const genesis1Entry = await entry(genesis1, did1, rot1.did());
corpus.push({ label: "secp256k1 genesis", ...genesis1Entry });

// ── Case 2: secp256k1 genesis, two rotation keys ───────────────────────────
const rot2a = await Secp256k1Keypair.create({ exportable: true });
const rot2b = await Secp256k1Keypair.create({ exportable: true });
const atKey2 = await Secp256k1Keypair.create({ exportable: true });
const { op: genesis2, did: did2 } = await createOp({
  signingKey: atKey2.did(),
  rotationKeys: [rot2a.did(), rot2b.did()],
  handle: "bob.test",
  pds: "https://pds.bob.test",
  signer: rot2a,
});
corpus.push({
  label: "secp256k1 genesis, two rotation keys",
  ...(await entry(genesis2, did2, rot2a.did())),
});

// ── Case 3: p256 (secp256r1) genesis ──────────────────────────────────────
const rot3 = await EcdsaKeypair.create({ exportable: true, jwtAlg: "ES256" });
const atKey3 = await EcdsaKeypair.create({
  exportable: true,
  jwtAlg: "ES256",
});
const { op: genesis3, did: did3 } = await createOp({
  signingKey: atKey3.did(),
  rotationKeys: [rot3.did()],
  handle: "carol.test",
  pds: "https://pds.carol.test",
  signer: rot3,
});
corpus.push({ label: "p256 genesis", ...(await entry(genesis3, did3, rot3.did())) });

// ── Case 4: mixed keys genesis (secp256k1 rotation, p256 atproto key) ─────
const rot4 = await Secp256k1Keypair.create({ exportable: true });
const atKey4 = await EcdsaKeypair.create({
  exportable: true,
  jwtAlg: "ES256",
});
const { op: genesis4, did: did4 } = await createOp({
  signingKey: atKey4.did(),
  rotationKeys: [rot4.did()],
  handle: "dave.test",
  pds: "https://pds.dave.test",
  signer: rot4,
});
corpus.push({
  label: "mixed keys genesis (secp256k1 rot, p256 atproto)",
  ...(await entry(genesis4, did4, rot4.did())),
});

// ── Case 5: update op (follows case 1's genesis) ──────────────────────────
const updateOp = await createUpdateOp(genesis1, rot1, async (op) => ({
  ...op,
  alsoKnownAs: ["at://alice-updated.test"],
}));
const updateEntry = await entry(updateOp, did1, rot1.did());
corpus.push({ label: "secp256k1 update", ...updateEntry });

// ── Case 6: tombstone (follows case 5's update) ───────────────────────────
// tombstoneOp expects a CID object as first argument, not the op itself.
const tombstone = await tombstoneOp(updateEntry._cid, rot1);
corpus.push({
  label: "secp256k1 tombstone",
  ...(await entry(tombstone, did1, rot1.did())),
});

// Strip internal _cid before serialising.
const outPath = join(outDir, "corpus.json");
writeFileSync(
  outPath,
  JSON.stringify(
    corpus.map(({ _cid: _drop, ...rest }) => rest),
    null,
    2,
  ) + "\n",
);
console.log(`gen-plc-corpus: ${corpus.length} ops → ${outPath}`);
for (const e of corpus) {
  console.log(`  [${e.label}] did=${e.did} cid=${e.cid}`);
}
