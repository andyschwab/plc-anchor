// TS differential oracle: validates both DASL vector integrity and PLC-op CID/DID
// fixture agreement with @ipld/dag-cbor (REFERENCE.md §3, §5).
//
// Run via `make conformance`. Two phases:
//   1. DASL vectors: structural well-formedness smoke-check (unchanged from stub).
//   2. PLC-op corpus: re-derive each CID and (for genesis ops) each DID using
//      @ipld/dag-cbor + sha256, assert byte-identical agreement with corpus.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encode } from "@ipld/dag-cbor";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { assureValidSig } from "@did-plc/lib";

const here = dirname(fileURLToPath(import.meta.url));

// ── Phase 1: DASL vector smoke-check ─────────────────────────────────────────
const vectorsDir = join(here, "..", "vectors", "dasl-cbor");
let total = 0;
const types = new Set();
for (const f of readdirSync(vectorsDir)) {
  if (!f.endsWith(".json")) continue;
  const cases = JSON.parse(readFileSync(join(vectorsDir, f), "utf8"));
  if (!Array.isArray(cases)) throw new Error(`${f}: expected an array of cases`);
  for (const c of cases) {
    if (typeof c.data !== "string" || typeof c.type !== "string") {
      throw new Error(`${f}: malformed case ${JSON.stringify(c).slice(0, 80)}`);
    }
    types.add(c.type);
    total += 1;
  }
}
console.log(
  `conformance(ts) phase 1: ${total} DASL vectors well-formed; types = ${[...types].join(", ")}`,
);

// ── Phase 2: PLC-op CID/DID fixture validation ────────────────────────────────
const corpusPath = join(here, "..", "vectors", "plc-ops", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

let passed = 0;
for (const e of corpus) {
  // Re-encode with @ipld/dag-cbor and verify bytes match the corpus.
  const reencoded = Buffer.from(encode(e.operation)).toString("hex");
  if (reencoded !== e.drisl_hex) {
    throw new Error(
      `[${e.label}] DRISL bytes mismatch — corpus may need refresh (make gen-plc-corpus).\n` +
        `  corpus   : ${e.drisl_hex.slice(0, 80)}...\n` +
        `  reencoded: ${reencoded.slice(0, 80)}...`,
    );
  }

  // Re-derive CID and assert it matches the corpus CID.
  const bytes = Buffer.from(e.drisl_hex, "hex");
  const digest = await sha256.digest(bytes);
  const cid = CID.create(1, 0x71 /* dag-cbor */, digest);
  const cidStr = cid.toString(base32);
  if (cidStr !== e.cid) {
    throw new Error(
      `[${e.label}] CID mismatch: recomputed=${cidStr}, corpus=${e.cid}`,
    );
  }

  // For genesis ops, re-derive DID fragment and assert it matches.
  const isGenesis = e.operation.prev === null || e.operation.prev === undefined;
  if (isGenesis) {
    const rawDigest = digest.digest;
    const fragment = base32.encode(rawDigest.slice(0, 15)).slice(1, 25);
    const derivedDid = `did:plc:${fragment}`;
    if (derivedDid !== e.did) {
      throw new Error(
        `[${e.label}] DID mismatch: derived=${derivedDid}, corpus=${e.did}`,
      );
    }
  }

  passed += 1;
}
console.log(
  `conformance(ts) phase 2: ${passed}/${corpus.length} PLC-op fixtures validated (CID + DID agreement with @ipld/dag-cbor)`,
);

// ── Phase 3: PLC-op signature validation ─────────────────────────────────────
// Uses @did-plc/lib assureValidSig to verify each corpus op's signature against
// the known signer (the differential oracle for Phase 2 / op_verify).
let sigPassed = 0;
for (const e of corpus) {
  // For plc_operation/create ops, rotationKeys is in the op. For tombstone, use
  // signer_did_key from the corpus (tombstone has no rotationKeys field).
  const allowedDids = e.operation.rotationKeys ?? [e.signer_did_key];
  const signerDid = await assureValidSig(allowedDids, e.operation);
  if (!allowedDids.includes(signerDid)) {
    throw new Error(
      `[${e.label}] assureValidSig returned unexpected signer: ${signerDid}`,
    );
  }
  sigPassed += 1;
}
console.log(
  `conformance(ts) phase 3: ${sigPassed}/${corpus.length} PLC-op signatures validated (@did-plc/lib)`,
);
