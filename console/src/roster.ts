//! The roster store — membership policy + lifecycle state, in SQLite (`node:sqlite`, zero deps).
//!
//! This is the off-chain policy the contract deliberately lacks (REFERENCE.md §2). It owns which
//! DIDs are anchored, their lifecycle state (the §6 admin tool), and the last witness status.
//! State transitions are validated against `ALLOWED_TRANSITIONS` so a dynamic filter can never
//! skip the human approve gate and trigger an on-chain write — the cost guardrail.

import { DatabaseSync } from "node:sqlite";
import type { Filter, RosterEntry, RosterState, WitnessStatus } from "./types.ts";

/** Legal lifecycle transitions. A filter match enters at `candidate`; only an operator's
 * approve moves `candidate → approved`, and only then can the onboarder write on-chain. */
export const ALLOWED_TRANSITIONS: Readonly<Record<RosterState, readonly RosterState[]>> = {
  candidate: ["approved", "removed"],
  approved: ["onboarding", "removed"],
  onboarding: ["anchored", "approved", "removed"], // → approved == onboarding failed, retry
  anchored: ["removed"],
  removed: ["candidate"],
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roster (
  did               TEXT PRIMARY KEY,
  state             TEXT NOT NULL,
  source            TEXT NOT NULL,
  pds_host          TEXT,
  status            TEXT,
  status_reason     TEXT,
  status_checked_at INTEGER,
  head_cid          TEXT,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roster_state_idx  ON roster(state);
CREATE INDEX IF NOT EXISTS roster_status_idx ON roster(status);
CREATE TABLE IF NOT EXISTS filters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  value      TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(type, value)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface RosterRow {
  did: string;
  state: string;
  source: string;
  pds_host: string | null;
  status: string | null;
  status_reason: string | null;
  status_checked_at: number | null;
  head_cid: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function toEntry(row: RosterRow): RosterEntry {
  return {
    did: row.did,
    state: row.state as RosterState,
    source: row.source,
    pdsHost: row.pds_host,
    status: row.status as WitnessStatus | null,
    statusReason: row.status_reason,
    statusCheckedAt: row.status_checked_at,
    headCid: row.head_cid,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface FilterRow {
  id: number;
  type: string;
  value: string;
  enabled: number;
  created_at: number;
}

function toFilter(row: FilterRow): Filter {
  return {
    id: row.id,
    type: row.type as "pds_host",
    value: row.value,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
  };
}

/** Raised on an attempt to make an illegal lifecycle transition. */
export class TransitionError extends Error {
  constructor(did: string, from: RosterState, to: RosterState) {
    super(`illegal transition for ${did}: ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

/** SQLite-backed roster + filters. `now` is injectable so tests are deterministic. */
export class RosterStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    this.#db.exec(SCHEMA);
  }

  /** Open a store at `path` (`:memory:` for tests). */
  static open(path = ":memory:", now: () => number = Date.now): RosterStore {
    return new RosterStore(new DatabaseSync(path), now);
  }

  close(): void {
    this.#db.close();
  }

  // ---- roster -------------------------------------------------------------

  get(did: string): RosterEntry | null {
    const row = this.#db.prepare("SELECT * FROM roster WHERE did = ?").get(did) as
      | RosterRow
      | undefined;
    return row ? toEntry(row) : null;
  }

  /** All entries, optionally filtered by state, newest-updated first. */
  list(state?: RosterState): RosterEntry[] {
    const rows = state
      ? this.#db
          .prepare("SELECT * FROM roster WHERE state = ? ORDER BY updated_at DESC")
          .all(state)
      : this.#db.prepare("SELECT * FROM roster ORDER BY updated_at DESC").all();
    return (rows as RosterRow[]).map(toEntry);
  }

  /** The alarm list: anchored DIDs the witness reports as `diverged`. */
  diverged(): RosterEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM roster WHERE state = 'anchored' AND status = 'diverged'")
      .all();
    return (rows as RosterRow[]).map(toEntry);
  }

  /** Propose a DID. New → `candidate`; a `removed` tombstone is revived; otherwise a no-op
   * (an already-active DID is left in place). Returns the resulting entry. */
  upsertCandidate(did: string, source: string, pdsHost: string | null = null): RosterEntry {
    const existing = this.get(did);
    const now = this.#now();
    if (existing === null) {
      this.#db
        .prepare(
          `INSERT INTO roster (did, state, source, pds_host, created_at, updated_at)
           VALUES (?, 'candidate', ?, ?, ?, ?)`,
        )
        .run(did, source, pdsHost, now, now);
      return this.get(did)!;
    }
    if (existing.state === "removed") {
      this.transition(did, "candidate");
      if (pdsHost !== null) this.setPdsHost(did, pdsHost);
      return this.get(did)!;
    }
    if (pdsHost !== null && existing.pdsHost !== pdsHost) this.setPdsHost(did, pdsHost);
    return this.get(did)!;
  }

  /** Move `did` to `to`, validating against `ALLOWED_TRANSITIONS`. Throws if unknown or illegal. */
  transition(did: string, to: RosterState): RosterEntry {
    const entry = this.get(did);
    if (entry === null) throw new Error(`unknown DID: ${did}`);
    if (!ALLOWED_TRANSITIONS[entry.state].includes(to)) {
      throw new TransitionError(did, entry.state, to);
    }
    // Leaving onboarding/anchored success clears any prior error.
    const clearErr = to === "anchored" || to === "approved";
    this.#db
      .prepare(
        `UPDATE roster SET state = ?, updated_at = ?${clearErr ? ", error = NULL" : ""}
         WHERE did = ?`,
      )
      .run(to, this.#now(), did);
    return this.get(did)!;
  }

  setPdsHost(did: string, host: string | null): void {
    this.#db
      .prepare("UPDATE roster SET pds_host = ?, updated_at = ? WHERE did = ?")
      .run(host, this.#now(), did);
  }

  /** Record a witness check result against an anchored DID. */
  setStatus(
    did: string,
    result: { status: WitnessStatus; reason: string; headCid: string | null },
  ): void {
    this.#db
      .prepare(
        `UPDATE roster
           SET status = ?, status_reason = ?, head_cid = ?, status_checked_at = ?,
               error = NULL, updated_at = ?
         WHERE did = ?`,
      )
      .run(result.status, result.reason, result.headCid, this.#now(), this.#now(), did);
  }

  setError(did: string, error: string): void {
    this.#db
      .prepare("UPDATE roster SET error = ?, updated_at = ? WHERE did = ?")
      .run(error, this.#now(), did);
  }

  // ---- filters ------------------------------------------------------------

  addFilter(type: "pds_host", value: string): Filter {
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO filters (type, value, created_at) VALUES (?, ?, ?)
         ON CONFLICT(type, value) DO NOTHING`,
      )
      .run(type, value, now);
    const row = this.#db
      .prepare("SELECT * FROM filters WHERE type = ? AND value = ?")
      .get(type, value) as FilterRow;
    return toFilter(row);
  }

  listFilters(enabledOnly = false): Filter[] {
    const rows = enabledOnly
      ? this.#db.prepare("SELECT * FROM filters WHERE enabled = 1 ORDER BY id").all()
      : this.#db.prepare("SELECT * FROM filters ORDER BY id").all();
    return (rows as FilterRow[]).map(toFilter);
  }

  setFilterEnabled(id: number, enabled: boolean): void {
    this.#db.prepare("UPDATE filters SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  removeFilter(id: number): void {
    this.#db.prepare("DELETE FROM filters WHERE id = ?").run(id);
  }

  // ---- meta (small KV, e.g. the discover cursor) --------------------------

  getMeta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(key, value, value);
  }
}
