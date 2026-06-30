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
    return (await res.json()) as AuditEntry[];
  }

  /** The directory's current head (CID + createdAt), or `null` if the DID is unknown/empty. */
  async head(did: string): Promise<DirectoryHead | null> {
    return directoryHead(await this.auditLog(did));
  }
}
