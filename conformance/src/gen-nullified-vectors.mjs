// Generator for the witness's `deriveNullified` / `deriveLiveChain` differential fixture
// (SECURITY-TODO item 1). The witness re-derives PLC recovery from op contents instead of
// trusting the directory's `nullified` flag; this fixture is the differential authority for that
// re-derivation, ground-truthed against @did-plc/lib `assureValidNextOp` (the same oracle the
// Cairo recovery path is green against — recovery_vectors_generated.cairo).
//
// Builds REAL signed did:plc chains with fixed keys (deterministic → byte-stable fixture, CI
// drift-checks), then for each scenario emits the audit log a directory would serve (or a HOSTILE
// mirror would inject) plus the expected live head + non-live CID set. Every valid op is confirmed
// ACCEPTED and every hostile op confirmed REJECTED by @did-plc/lib at generation time (this script
// throws otherwise), so the fixture can never drift from the oracle.
//
// The 72h window is pure arithmetic on createdAt deltas; like gen-recovery-vectors, @did-plc/lib's
// Date.now()-based verdict is asserted with a probe chain timed relative to Date.now(), while the
// emitted fixture uses a fixed NOW with the SAME deltas (what the witness reads).
//
// Run via `make gen-nullified-vectors`; CI asserts no drift.
import { Secp256k1Keypair, verifySignature } from "@atproto/crypto";
import { createOp, createUpdateOp, tombstoneOp, assureValidNextOp } from "@did-plc/lib";
import { encode } from "@ipld/dag-cbor";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "..", "witness-ts", "test", "vectors", "nullified-vectors.json");
const corpusPath = join(here, "..", "vectors", "plc-ops", "corpus.json");

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-06-30T00:00:00.000Z"); // fixed clock for the emitted timestamps
const iso = (ms) => new Date(ms).toISOString();
const cidOf = async (op) => CID.create(1, 0x71, await sha256.digest(encode(op))).toString(base32);

// Fixed priority-ordered rotation keys [k0 > k1 > k2] + an atproto verification key. A p256
// verification key gives the fixture a mixed-curve genesis so the witness's p256 path is exercised.
const k0 = await Secp256k1Keypair.import("11".repeat(32), { exportable: true });
const k1 = await Secp256k1Keypair.import("22".repeat(32), { exportable: true });
const k2 = await Secp256k1Keypair.import("33".repeat(32), { exportable: true });
const atKey = await Secp256k1Keypair.import("44".repeat(32), { exportable: true });

const { op: genesis, did } = await createOp({
  signingKey: atKey.did(),
  rotationKeys: [k0.did(), k1.did(), k2.did()],
  handle: "nullified-demo.test",
  pds: "https://pds.nullified.test",
  signer: k0,
});
// A normal append signed by the index-1 key — the op a recovery disputes.
const opA = await createUpdateOp(genesis, k1, async (o) => ({ ...o, alsoKnownAs: ["at://a.test"] }));
// A second append (for the clean chain).
const opB = await createUpdateOp(opA, k1, async (o) => ({ ...o, alsoKnownAs: ["at://b.test"] }));
// A valid recovery: forks at genesis (nullifying opA), signed by the higher-priority index-0 key.
const recovery = await createUpdateOp(genesis, k0, async (o) => ({ ...o, alsoKnownAs: ["at://recovered.test"] }));
// A weaker-key fork: index-2 key trying to override the index-1 signer — @did-plc/lib rejects it.
const weakFork = await createUpdateOp(genesis, k2, async (o) => ({ ...o, alsoKnownAs: ["at://weak.test"] }));
// A forged append: a well-formed opB whose signature has been tampered — verifies under no key.
const forgedAppend = { ...opB, sig: `${opB.sig.slice(0, -4)}AAAA` };
// A tombstone terminating the chain, and an op that tries to build on it.
const tombstone = await tombstoneOp(await cidOf(opA), k1);
const afterTombstone = { ...opA, prev: await cidOf(tombstone), alsoKnownAs: ["at://after-grave.test"] };

const [G, A, B, R, W, Fg, T, X] = await Promise.all(
  [genesis, opA, opB, recovery, weakFork, forgedAppend, tombstone, afterTombstone].map(cidOf),
);

// ── @did-plc/lib ground-truthing (probe chains timed relative to Date.now) ────────────────────
const rec = async (op, ageMs) => ({
  cid: CID.create(1, 0x71, await sha256.digest(encode(op))),
  operation: op,
  createdAt: new Date(Date.now() - ageMs),
});
async function assertAccepted(label, chain, op) {
  try {
    await assureValidNextOp(did, chain, op);
  } catch (e) {
    throw new Error(`gen-nullified-vectors: oracle UNEXPECTEDLY REJECTED valid "${label}": ${e.message}`);
  }
}
async function assertRejected(label, chain, op) {
  let rejected = false;
  try {
    await assureValidNextOp(did, chain, op);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`gen-nullified-vectors: oracle UNEXPECTEDLY ACCEPTED hostile "${label}"`);
}

const genesisChain = []; // assureValidNextOp treats an empty history as genesis
const afterGenesis = [await rec(genesis, 100 * HOUR)];
const afterA = [await rec(genesis, 100 * HOUR), await rec(opA, 1 * HOUR)]; // opA recent → recovery in-window
const afterAAged = [await rec(genesis, 200 * HOUR), await rec(opA, 100 * HOUR)]; // opA old → recovery late
const afterTomb = [await rec(genesis, 100 * HOUR), await rec(opA, 50 * HOUR), await rec(tombstone, 1 * HOUR)];

await assertAccepted("genesis", genesisChain, genesis);
await assertAccepted("append opA", afterGenesis, opA);
await assertAccepted("append opB", afterA, opB);
await assertAccepted("valid recovery (k0, in-window)", afterA, recovery);
await assertRejected("weaker-key fork (k2)", afterA, weakFork);
await assertRejected("late recovery (k0, out-of-window)", afterAAged, recovery);
await assertRejected("forged append", afterA, forgedAppend);
await assertAccepted("tombstone", afterA, tombstone);
await assertRejected("build-on-tombstone", afterTomb, afterTombstone);

// ── Emitted scenarios (fixed NOW; deltas preserve the in/out-of-window relationships above) ────
const e = (cid, operation, createdAtMs, nullified) => ({ did, cid, createdAt: iso(createdAtMs), nullified, operation });
const t0 = NOW - 200 * HOUR; // genesis
const t1 = NOW - 100 * HOUR; // opA
const tRecentR = NOW - 99 * HOUR; // recovery ~1h after opA → in window
const tLateR = NOW - 20 * HOUR; // recovery ~80h after opA → late

// nullified flags below are the directory's *honest* claim; the witness ignores them (the test
// re-runs every scenario with the flags inverted and asserts the derivation is unchanged).
const scenarios = [
  {
    id: "clean-chain",
    note: "genesis → opA → opB, all appends; nothing nullified.",
    auditLog: [e(G, genesis, t0, false), e(A, opA, t1, false), e(B, opB, tRecentR, false)],
    expectedHeadCid: B,
    expectedNullifiedCids: [],
  },
  {
    id: "valid-recovery",
    note: "genesis → opA(k1), then a valid recovery(k0) forking at genesis within 72h → opA nullified.",
    auditLog: [e(G, genesis, t0, false), e(A, opA, t1, true), e(R, recovery, tRecentR, false)],
    expectedHeadCid: R,
    expectedNullifiedCids: [A],
  },
  {
    id: "hostile-weaker-key-recovery",
    note: "A mirror injects a weaker-key(k2) fork and claims it live; the witness must reject it and keep opA live.",
    auditLog: [e(G, genesis, t0, false), e(A, opA, t1, true), e(W, weakFork, tRecentR, false)],
    expectedHeadCid: A,
    expectedNullifiedCids: [W],
  },
  {
    id: "hostile-late-recovery",
    note: "A mirror injects a valid-key(k0) recovery but the disputed op is >72h old; the witness must reject it (late).",
    auditLog: [e(G, genesis, t0, false), e(A, opA, t1, true), e(R, recovery, tLateR, false)],
    expectedHeadCid: A,
    expectedNullifiedCids: [R],
  },
  {
    id: "hostile-forged-append",
    note: "A mirror injects a forged (bad-sig) append and claims it live; the witness must reject it.",
    auditLog: [e(G, genesis, t0, false), e(A, opA, t1, false), e(Fg, forgedAppend, tRecentR, false)],
    expectedHeadCid: A,
    expectedNullifiedCids: [Fg],
  },
  {
    id: "tombstone-terminal",
    note: "genesis → opA → tombstone; the tombstone is the live head, nothing nullified.",
    auditLog: [e(G, genesis, t0, false), e(A, opA, t1, false), e(T, tombstone, tRecentR, false)],
    expectedHeadCid: T,
    expectedNullifiedCids: [],
  },
  {
    id: "hostile-build-on-tombstone",
    note: "A mirror injects an op building on a tombstone and claims it live; the witness must reject it.",
    auditLog: [e(G, genesis, t0, false), e(A, opA, t1, false), e(T, tombstone, tRecentR, false), e(X, afterTombstone, NOW - 10 * HOUR, false)],
    expectedHeadCid: T,
    expectedNullifiedCids: [X],
  },
];

// ── Signature-verification vectors: both curves + the low-S/malleability asymmetry ────────────
// The witness's crypto (crypto.ts) must match @atproto/crypto exactly (sig_verify.cairo): k256 is
// low-S-only, p256 is malleable. Source real ops from the corpus and confirm each expectation with
// the reference verifier at generation time.
const N_K256 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const N_P256 = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const hex = (u8) => Buffer.from(u8).toString("hex");

function highS(sigB64, n) {
  const raw = Buffer.from(sigB64, "base64url");
  const r = raw.subarray(0, 32);
  let s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
  if (s <= n / 2n) s = n - s;
  return Buffer.concat([r, Buffer.from(s.toString(16).padStart(64, "0"), "hex")]).toString("base64url");
}

const k256Op = corpus.find((c) => c.signer_did_key.startsWith("did:key:zQ3"));
const p256Op = corpus.find((c) => c.signer_did_key.startsWith("did:key:zDn"));
const sigVectorDefs = [
  { note: "k256 valid low-S", didKey: k256Op.signer_did_key, unsignedHex: k256Op.unsigned_drisl_hex, sig: k256Op.operation.sig },
  { note: "p256 valid", didKey: p256Op.signer_did_key, unsignedHex: p256Op.unsigned_drisl_hex, sig: p256Op.operation.sig },
  { note: "k256 high-S must be rejected (low-S required)", didKey: k256Op.signer_did_key, unsignedHex: k256Op.unsigned_drisl_hex, sig: highS(k256Op.operation.sig, N_K256) },
  { note: "p256 high-S must be accepted (malleable)", didKey: p256Op.signer_did_key, unsignedHex: p256Op.unsigned_drisl_hex, sig: highS(p256Op.operation.sig, N_P256) },
  { note: "wrong key rejected (p256 key against k256 op)", didKey: p256Op.signer_did_key, unsignedHex: k256Op.unsigned_drisl_hex, sig: k256Op.operation.sig },
];
const sigVectors = [];
for (const v of sigVectorDefs) {
  const data = Uint8Array.from(Buffer.from(v.unsignedHex, "hex"));
  const sigBytes = Uint8Array.from(Buffer.from(v.sig, "base64url"));
  const expectValid = await verifySignature(v.didKey, data, sigBytes);
  sigVectors.push({ ...v, expectValid });
}
// Sanity: the asymmetry the whole design rests on must hold at generation time.
if (sigVectors[2].expectValid) throw new Error("gen-nullified-vectors: reference accepted high-S k256 — asymmetry broken");
if (!sigVectors[3].expectValid) throw new Error("gen-nullified-vectors: reference rejected high-S p256 — asymmetry broken");

const fixture = {
  _generated: "by conformance/src/gen-nullified-vectors.mjs — DO NOT EDIT. Run: make gen-nullified-vectors",
  _about:
    "Differential fixture for the witness's local re-derivation of PLC `nullified` (SECURITY-TODO item 1). Each scenario's live head + non-live CID set is ground-truthed vs @did-plc/lib assureValidNextOp. Hostile scenarios inject ops @did-plc/lib rejects; the witness must exclude them regardless of the served `nullified` flag.",
  did,
  scenarios,
  sigVectors,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`gen-nullified-vectors: ${scenarios.length} scenarios → ${outPath}`);
console.log(`  did = ${did}`);
for (const s of scenarios) console.log(`  [${s.id}] head=${(s.expectedHeadCid ?? "null").slice(0, 16)}… nullified=${s.expectedNullifiedCids.length}`);
