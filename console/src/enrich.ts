//! Enrichment — attach PLC-derivable identity context to roster entries (handle, PDS host,
//! rotation-key count, last-op time, tombstoned). Display-only: this feeds the operator's table so
//! 20k bare DIDs become legible; it carries **no consensus weight** (the authoritative §4 status
//! still comes from the witness `check()` in the refresher). So we read the directory's audit log
//! for cheap metadata rather than re-verifying signatures per DID — verification is the witness's
//! job, run on the anchored set.
//!
//! The resolver is an injectable seam (the real one wraps `witness-ts`'s `DirectoryClient` in
//! `witness.ts`) so enrichment is offline-testable with a fixture audit log. The worker is
//! throttled and cached (`enrichedAt`) so a full 20k pass stays gentle on `plc.directory`.

import { hostOf, pdsHostFromOp } from "./pdshost.ts";
import type { RosterStore } from "./roster.ts";

/** The subset of a directory audit entry enrichment needs. Structurally compatible with
 * `witness-ts`'s `AuditEntry`. */
export interface AuditEntry {
  cid: string;
  createdAt: string;
  nullified: boolean;
  operation: unknown;
}

/** Resolves a DID to its directory audit log. `witness.ts` provides the real (HTTP) one. */
export interface IdentityResolver {
  auditLog(did: string): Promise<AuditEntry[]>;
}

/** The PLC-derived identity context for a DID. */
export interface Identity {
  handle: string | null;
  pdsHost: string | null;
  keyCount: number | null;
  lastOpAt: number | null;
  tombstoned: boolean;
}

const DAY_MS = 86_400_000;

/** The handle from an op's `alsoKnownAs[0]` (modern) or `handle` (legacy `create`), `at://`
 * stripped. Returns null when absent. */
function handleFromOp(op: Record<string, unknown>): string | null {
  const aka = op.alsoKnownAs;
  if (Array.isArray(aka) && typeof aka[0] === "string") return aka[0].replace(/^at:\/\//, "");
  if (typeof op.handle === "string") return op.handle.replace(/^at:\/\//, "");
  return null;
}

/** Rotation-key count: `rotationKeys.length` (modern) or the legacy `recoveryKey`/`signingKey`
 * pair count. Null when neither shape is present. */
function keyCountFromOp(op: Record<string, unknown>): number | null {
  if (Array.isArray(op.rotationKeys)) return op.rotationKeys.length;
  let legacy = 0;
  if (typeof op.recoveryKey === "string") legacy += 1;
  if (typeof op.signingKey === "string") legacy += 1;
  return legacy > 0 ? legacy : null;
}

/** Derive identity from an audit log: the latest **non-nullified** op is the current identity, and
 * its `createdAt` is `lastOpAt`. Returns `null` for an empty/all-nullified log. Trusts the
 * directory's `nullified` flag for this display view (the witness check is where trust matters). */
export function identityFromLog(log: readonly AuditEntry[]): Identity | null {
  let latest: AuditEntry | null = null;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (!log[i].nullified) {
      latest = log[i];
      break;
    }
  }
  if (latest === null) return null;
  const op =
    latest.operation !== null && typeof latest.operation === "object"
      ? (latest.operation as Record<string, unknown>)
      : {};
  const parsed = Date.parse(latest.createdAt);
  return {
    handle: handleFromOp(op),
    pdsHost: pdsHostFromOp(op) ?? hostOf(op.service),
    keyCount: keyCountFromOp(op),
    lastOpAt: Number.isNaN(parsed) ? null : parsed,
    tombstoned: op.type === "plc_tombstone",
  };
}

export interface EnrichConfig {
  /** Re-enrich an entry once its `enrichedAt` is older than this (default 24h). */
  reEnrichMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable delay between requests (rate-limit); default a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EnrichResult {
  enriched: number;
  failed: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

export class EnrichmentService {
  readonly #store: RosterStore;
  readonly #resolver: IdentityResolver;
  readonly #reEnrichMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(store: RosterStore, resolver: IdentityResolver, config: EnrichConfig = {}) {
    this.#store = store;
    this.#resolver = resolver;
    this.#reEnrichMs = config.reEnrichMs ?? DAY_MS;
    this.#now = config.now ?? Date.now;
    this.#sleep = config.sleep ?? defaultSleep;
  }

  /** Enrich one DID. Records the identity (stamping `enrichedAt`) on success; records the error
   * without stamping on failure, so it retries next pass. Returns whether it enriched. */
  async enrichOne(did: string): Promise<boolean> {
    try {
      const log = await this.#resolver.auditLog(did);
      const id = identityFromLog(log);
      if (id === null) {
        this.#store.setError(did, "enrich: no live op in audit log");
        return false;
      }
      this.#store.setEnrichment(did, id);
      return true;
    } catch (err) {
      this.#store.setError(did, `enrich: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Enrich up to `limit` stale DIDs, pausing `delayMs` between requests (the rate-limit). Returns
   * the enriched/failed counts. A no-op when nothing is stale. */
  async enrichStale(limit = 50, delayMs = 200): Promise<EnrichResult> {
    const staleBefore = this.#now() - this.#reEnrichMs;
    const due = this.#store.needingEnrichment(staleBefore, limit);
    let enriched = 0;
    let failed = 0;
    for (let i = 0; i < due.length; i += 1) {
      if (i > 0) await this.#sleep(delayMs);
      if (await this.enrichOne(due[i].did)) enriched += 1;
      else failed += 1;
    }
    return { enriched, failed };
  }
}
