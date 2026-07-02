//! PLC directory client — the off-chain half of the witness's inputs.
//!
//! The witness compares the directory's served head against the anchor's proven head. The
//! audit log (`/{did}/log/audit`) is the source for both the head CID and its `createdAt` —
//! and `createdAt` matters because it is the **directory's** clock, which the anchor cannot
//! read (it is not in the signed op; REFERENCE.md §1, §5). The status layer (P5.4) needs both
//! clocks to tell benign skew from real divergence, so head selection carries `createdAt`.
//!
//! `plc.directory` is the default, but any mirror (Eurosky, microcosm — REFERENCE.md §7) is a
//! drop-in via `baseUrl`. The fetch transport is injectable so head selection is offline-testable.

import { cidForOp, didForGenesisOp } from "./dagcbor.ts";
import { readOp, verifyOpAuthorized } from "./opverify.ts";

/** One entry of a DID's audit log: an op, its CID, the directory's timestamp, and whether a
 * later higher-priority op has nullified it (PLC recovery). NOTE: `nullified` is the directory's
 * *claim* — the witness discards it and re-derives nullification from the op contents
 * (`deriveLiveChain` / `deriveNullified`), because a hostile directory can flip it (SECURITY-TODO
 * item 1). It is retained only for diagnostics / the raw `directoryHead` view. */
export interface AuditEntry {
  did: string;
  cid: string;
  createdAt: string; // ISO 8601, directory-assigned
  nullified: boolean;
  operation: unknown;
}

/** The directory's current head for a DID: the latest **non-nullified** op. */
export interface DirectoryHead {
  cid: string;
  createdAt: string;
}

/**
 * The head per the directory's *own* `nullified` claim: the last entry it doesn't flag nullified.
 * This TRUSTS the directory and is used only for the raw diagnostic view (`DirectoryClient.head`);
 * the witness's status check uses `deriveLiveChain`, which re-derives nullification from op
 * contents rather than believing the flag (SECURITY-TODO item 1).
 */
export function directoryHead(log: readonly AuditEntry[]): DirectoryHead | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (!log[i].nullified) return { cid: log[i].cid, createdAt: log[i].createdAt };
  }
  return null;
}

// ── Locally re-derived nullification (SECURITY-TODO item 1) ──
//
// The `nullified` boolean from the HTTP response is untrusted: a hostile directory can flip it to
// hide a live op (false `diverged`) or float a superseded/forged op as live (false
// `confirmed`/`tentative-consistent`). So we discard it and reproduce PLC's recovery decision
// from the op chain itself, mirroring the on-chain `state::apply_op` + `recovery::classify_next_op`
// (byte-exact via `dagcbor`/`crypto`/`opverify`) and `@did-plc/lib`'s `assureValidNextOp`.

/** 72h recovery window in ms — matches `recovery.cairo::RECOVERY_WINDOW_MS` / `@did-plc/lib`.
 * Also the anchor's confirmed-head horizon (an op is immutable once block-time + this < now). */
export const RECOVERY_WINDOW_MS = 259_200_000;

/** The re-derived live view of a DID's history: the CIDs on the currently-live chain (recomputed
 * locally, never the directory's) and the live tip. */
export interface LiveChain {
  /** Locally-recomputed CIDs of the ops on the re-derived live chain. */
  liveCids: Set<string>;
  /** The live tip: its recomputed CID + the entry's `createdAt`. `null` if none. */
  head: DirectoryHead | null;
  /** The live chain in order, each op's recomputed CID + its entry `createdAt` — the input the
   * anchor's confirmed-head derivation needs (the block-time 72h window; `status.ts`). Optional so
   * a flag-based `deriveLive` stub can omit it. */
  ops?: { cid: string; createdAt: string }[];
}

/** One op on the re-derived live chain. `signerIndex` is the signer's priority index within its
 * predecessor's rotation keys — the disputed-signer operand a later recovery needs (so a nullified
 * op never has to be re-verified against a different key set), exactly `state.cairo`'s
 * `OpRecord.signer_index`. */
interface LiveOp {
  cid: string;
  createdAt: string;
  rotationKeys: string[];
  tombstone: boolean;
  signerIndex: number;
  /** Provenance (SECURITY-TODO 4a): `true` for a settled/imported op — a recovery may not nullify
   * it. Always `false` for directory-served ops (the guard is then inert); set for anchor replay. */
  imported: boolean;
}

/** A replayable op: a directory `AuditEntry` satisfies this, and the anchor path constructs the
 * same shape from on-chain bytes (op body cross-referenced content-addressed, `createdAt` = the
 * anchor's block time, `imported` = its provenance flag). */
export interface ReplayEntry {
  operation: unknown;
  createdAt: string;
  /** Settled/imported provenance (anchor replay only). Absent ⇒ live, guard inert. */
  imported?: boolean;
}

/**
 * Replay an op log (oldest-first, INCLUDING nullified/superseded entries — the auditable form) to
 * re-derive the currently-live chain, ignoring any `nullified` claim entirely. Used for BOTH the
 * directory audit log and the anchor's on-chain op log (which is structurally the same: an
 * append-only log where a recovery is just another appended entry — see `anchor.cairo`).
 *
 * For each op in order: recompute its CID, verify its embedded signature against the authorized
 * key set (own keys for genesis, the fork-point op's keys otherwise), and — when it forks below
 * the tip — apply PLC's recovery rule (a strictly-higher-priority key, within 72h of the first
 * op it supersedes) to decide whether the fork is valid and what it nullifies. A recovery may not
 * nullify a **settled/imported** op (`entry.imported`; SECURITY-TODO 4a) — the read-side mirror of
 * `state::apply_op`'s `recovery-of-imported` guard, inert on directory logs (which carry no
 * imported flag). A structurally invalid, unauthorized, misordered, or out-of-window op cannot
 * have been legitimately accepted, so replay stops there and everything from it on is not-live.
 *
 * The 72h window is measured from the superseding op's own `createdAt` — for the directory the
 * acceptance-time clock (the same input `@did-plc/lib` used; finding 4b); for the anchor the
 * independent **block time** — not the caller's wall clock, so a long-past valid recovery still
 * reads as valid.
 *
 * `expectedDid`, when given, binds the log to a DID: the genesis op's derived `did:plc` fragment
 * must match, else the log is the wrong DID's history and nothing is live.
 */
export function deriveLiveChain(log: readonly ReplayEntry[], expectedDid?: string): LiveChain {
  const chain: LiveOp[] = [];

  for (const entry of log) {
    const op = readOp(entry.operation);
    if (op === null) break; // not a structurally usable op

    const cid = cidForOp(entry.operation);
    const imported = entry.imported ?? false;

    if (chain.length === 0) {
      // Genesis: prev must be null, self-authorized by its own rotation keys, and (if bound) its
      // derived DID must be the one we asked for.
      if (op.prev !== null) break;
      const idx = verifyOpAuthorized(entry.operation, op.rotationKeys);
      if (idx < 0) break;
      if (expectedDid !== undefined && didForGenesisOp(entry.operation) !== expectedDid) break;
      chain.push({ cid, createdAt: entry.createdAt, rotationKeys: op.rotationKeys, tombstone: op.tombstone, signerIndex: idx, imported });
      continue;
    }

    // Non-genesis: it must name a live op as `prev`.
    if (op.prev === null) break; // a second genesis is malformed
    const forkIndex = chain.findIndex((c) => c.cid === op.prev);
    if (forkIndex < 0) break; // prev not on the live chain → misordered
    const forkPoint = chain[forkIndex];
    if (forkPoint.tombstone) break; // nothing may build on a tombstone

    const signerIndex = verifyOpAuthorized(entry.operation, forkPoint.rotationKeys);
    if (signerIndex < 0) break; // not signed by an authorized key
    const nullifiedCount = chain.length - 1 - forkIndex;

    if (nullifiedCount > 0) {
      // Recovery: the proposed op forks below the tip, nullifying the ops after the fork point.
      // Valid iff it out-ranks (strictly higher priority than) the FIRST nullified op's signer,
      // and that op is within the 72h window (classify_next_op / assureValidNextOp).
      const firstNullified = chain[forkIndex + 1];
      // A recovery may not nullify settled/imported history (SECURITY-TODO 4a): the read-side
      // mirror of `state::apply_op`'s `recovery-of-imported`. Imported ops always form the chain's
      // prefix, so the first nullified being imported is sufficient. Inert on directory logs.
      if (firstNullified.imported) break; // recovery-of-imported
      if (signerIndex >= firstNullified.signerIndex) break; // recovery-weaker-key
      // Window uses the directory's `createdAt` (finding 4b). This is FAITHFUL PLC, not added
      // trust: `@did-plc/lib`'s `assureValidNextOp` measures the window against
      // `firstNullified.createdAt` too — the trust PLC itself places in the directory clock,
      // shared by every conformant resolver. Here `entry.createdAt` (the recovery op's directory
      // time) stands in for the oracle's `Date.now()`, reconstructing the decision the directory
      // made at the moment it accepted this op. The independent backstop is the anchor's own
      // block-time confirmed head, which `status.ts` cross-checks against this derived live head;
      // and signatures gate everything above, so a lying clock can only re-time a fork that is
      // ALREADY validly signed by a higher-priority key — it cannot conjure a head. The
      // NaN-is-not-late branch below is deliberately permissive to match the oracle byte-for-byte
      // (changing it would fork this consensus-critical re-derivation). See REFERENCE.md §1.
      const lapsed = Date.parse(entry.createdAt) - Date.parse(firstNullified.createdAt);
      if (lapsed > RECOVERY_WINDOW_MS) break; // late-recovery (NaN ⇒ not late, matching the oracle)
      chain.length = forkIndex + 1; // drop the nullified suffix
    }

    chain.push({ cid, createdAt: entry.createdAt, rotationKeys: op.rotationKeys, tombstone: op.tombstone, signerIndex, imported });
  }

  const tip = chain[chain.length - 1];
  return {
    liveCids: new Set(chain.map((c) => c.cid)),
    head: tip ? { cid: tip.cid, createdAt: tip.createdAt } : null,
    ops: chain.map((c) => ({ cid: c.cid, createdAt: c.createdAt })),
  };
}

/**
 * The set of locally-recomputed CIDs the directory served that are NOT on the re-derived live
 * chain — i.e. superseded by a valid recovery, or structurally invalid/unauthorized — regardless
 * of the directory's `nullified` claim (SECURITY-TODO item 1). Keyed on recomputed CIDs, so a
 * directory that also lies about an entry's `cid` cannot smuggle an op onto the live set.
 */
export function deriveNullified(log: readonly AuditEntry[]): Set<string> {
  const { liveCids } = deriveLiveChain(log);
  const nullified = new Set<string>();
  for (const entry of log) {
    const cid = cidForOp(entry.operation);
    if (!liveCids.has(cid)) nullified.add(cid);
  }
  return nullified;
}

/** A `fetch`-shaped transport, injectable for tests. */
export type Fetcher = (url: string) => Promise<Response>;

/** Upper bound on audit-log entries. A DID's history is small — tens of ops even with a
 * lifetime of recoveries; anything far larger is a malformed or hostile response, not a real
 * log (SECURITY-TODO item 2). */
const MAX_AUDIT_ENTRIES = 10_000;

/** Upper bound on the raw audit-log body we will buffer (bytes). A single DID's log is a few KB;
 * this only stops a hostile mirror from streaming an unbounded body at the client. */
const MAX_AUDIT_BODY_BYTES = 8 * 1024 * 1024;

/** Read a response body into text, aborting once it exceeds `maxBytes` — so an unbounded (or
 * mis-declared) body can't be buffered whole. Falls back to `res.text()` when no stream is
 * exposed (e.g. a minimal transport double). */
async function readBoundedText(res: Response, maxBytes: number, ctx: string): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > maxBytes) {
    throw new Error(`${ctx}: declared body ${declared} bytes exceeds cap ${maxBytes}`);
  }
  const body = res.body;
  if (!body) return res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`${ctx}: body exceeded ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Whether `v` is a structurally valid audit-log entry (all fields present and correctly typed).
 * A malicious directory can serve anything; a missing/mistyped field must surface as an explicit
 * error, never a silent `undefined`/`NaN` flowing into the status comparisons (SECURITY-TODO
 * item 2). */
function isAuditEntry(v: unknown): v is AuditEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.did === "string" &&
    typeof e.cid === "string" &&
    typeof e.createdAt === "string" &&
    typeof e.nullified === "boolean" &&
    typeof e.operation === "object" &&
    e.operation !== null
  );
}

/** Validate a parsed audit-log body: an array within bounds, every entry well-formed. Throws on
 * the first violation rather than coercing malformed data into the comparison path. */
export function parseAuditLog(body: unknown, did: string): AuditEntry[] {
  if (!Array.isArray(body)) {
    throw new Error(`directory audit log ${did}: expected a JSON array`);
  }
  if (body.length > MAX_AUDIT_ENTRIES) {
    throw new Error(
      `directory audit log ${did}: ${body.length} entries exceeds cap ${MAX_AUDIT_ENTRIES}`,
    );
  }
  for (let i = 0; i < body.length; i += 1) {
    if (!isAuditEntry(body[i])) {
      throw new Error(`directory audit log ${did}: entry ${i} missing or has malformed fields`);
    }
  }
  return body as AuditEntry[];
}

/** Reads a DID's audit log + head from a PLC directory (or mirror). */
export class DirectoryClient {
  readonly #baseUrl: string;
  readonly #fetch: Fetcher;

  constructor(baseUrl = "https://plc.directory", fetcher: Fetcher = (u) => fetch(u)) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetcher;
  }

  /** The full audit log (oldest-first), including nullified entries. */
  async auditLog(did: string): Promise<AuditEntry[]> {
    const res = await this.#fetch(`${this.#baseUrl}/${did}/log/audit`);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`directory audit log ${did}: HTTP ${res.status}`);
    const text = await readBoundedText(res, MAX_AUDIT_BODY_BYTES, `directory audit log ${did}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new Error(`directory audit log ${did}: invalid JSON (${(e as Error).message})`);
    }
    return parseAuditLog(body, did);
  }

  /** The directory's current head (CID + createdAt), or `null` if the DID is unknown/empty. */
  async head(did: string): Promise<DirectoryHead | null> {
    return directoryHead(await this.auditLog(did));
  }
}
