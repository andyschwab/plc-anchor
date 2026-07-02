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

/** One entry of a DID's audit log: an op, its CID, the directory's timestamp, and whether a
 * later higher-priority op has nullified it (PLC recovery). */
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
 * The current head from an audit log: the last entry not nullified by a recovery. The log is
 * oldest-first, so scan from the end. `null` if the DID has no live op (empty log, or every op
 * nullified — e.g. a fully recovered-away branch).
 */
export function directoryHead(log: readonly AuditEntry[]): DirectoryHead | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (!log[i].nullified) return { cid: log[i].cid, createdAt: log[i].createdAt };
  }
  return null;
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
