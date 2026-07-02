//! The roster store — membership policy + lifecycle state, in SQLite (`node:sqlite`, zero deps).
//!
//! This is the off-chain policy the contract deliberately lacks (REFERENCE.md §2). It owns which
//! DIDs are anchored, their lifecycle state (the §6 admin tool), and the last witness status.
//! State transitions are validated against `ALLOWED_TRANSITIONS` so a dynamic filter can never
//! skip the human approve gate and trigger an on-chain write — the cost guardrail.

import { DatabaseSync } from "node:sqlite";
import type {
  Aggregates,
  Filter,
  RosterEntry,
  RosterQuery,
  RosterState,
  Settings,
  WitnessStatus,
  WorkerStatus,
} from "./types.ts";

const WORKER_STATUS_PREFIX = "worker_status:";

/** Whitelisted sort keys → real columns (guards the `ORDER BY` against injection). */
const SORT_COLUMNS: Readonly<Record<string, string>> = {
  did: "did",
  handle: "handle",
  state: "state",
  status: "status",
  pdsHost: "pds_host",
  pds_host: "pds_host",
  keyCount: "key_count",
  key_count: "key_count",
  lastOpAt: "last_op_at",
  last_op_at: "last_op_at",
  anchoredAt: "anchored_at",
  anchored_at: "anchored_at",
  anchorFee: "anchor_fee",
  anchor_fee: "anchor_fee",
  discoveredAt: "discovered_at",
  discovered_at: "discovered_at",
  updatedAt: "updated_at",
  updated_at: "updated_at",
};

/** Escape LIKE wildcards in user substrings (paired with `ESCAPE` is overkill here; we simply
 * neutralize `%` and `_` so a search box can't match everything). */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

function clampInt(v: number | undefined, dflt: number, lo: number, hi: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

/** Legal lifecycle transitions. A filter match enters at `candidate`; only an operator's
 * approve moves `candidate → approved`, and only then can the *onboarder* write on-chain.
 *
 * `candidate → anchored` and `approved → anchored` are the **observation** path: the refresher
 * learns a DID is already anchored on-chain (by anyone) and reflects that. Observation writes
 * nothing, so it does not weaken the approve gate — the onboarder still acts only on `approved`
 * (the spend), and `anchored` simply means "present on-chain," however it got there. */
export const ALLOWED_TRANSITIONS: Readonly<Record<RosterState, readonly RosterState[]>> = {
  candidate: ["approved", "anchored", "removed"],
  approved: ["onboarding", "anchored", "removed"],
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
  handle            TEXT,
  key_count         INTEGER,
  last_op_at        INTEGER,
  tombstoned        INTEGER,
  enriched_at       INTEGER,
  anchored_at       INTEGER,
  anchor_tx         TEXT,
  anchor_fee        TEXT,
  discovered_at     INTEGER,
  off_criterion     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roster_state_idx    ON roster(state);
CREATE INDEX IF NOT EXISTS roster_status_idx   ON roster(status);
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

/** Indexes on columns added after the initial schema. Created **after** `#migrate()` — on a
 * pre-existing DB the `CREATE TABLE IF NOT EXISTS` above is a no-op, so these columns don't exist
 * until the migration adds them (indexing them in `SCHEMA` would crash with "no such column"). */
const POST_MIGRATE_INDEXES = `
CREATE INDEX IF NOT EXISTS roster_handle_idx   ON roster(handle);
CREATE INDEX IF NOT EXISTS roster_pdshost_idx  ON roster(pds_host);
CREATE INDEX IF NOT EXISTS roster_anchored_idx ON roster(anchored_at);
CREATE INDEX IF NOT EXISTS roster_enriched_idx ON roster(enriched_at);
CREATE INDEX IF NOT EXISTS roster_offcrit_idx  ON roster(off_criterion);
`;

/** Columns added after the initial schema. Applied idempotently to pre-existing DBs so a
 * deployed store picks up the enrichment/anchor fields without a manual migration. */
const ADDED_COLUMNS: ReadonlyArray<[string, string]> = [
  ["handle", "TEXT"],
  ["key_count", "INTEGER"],
  ["last_op_at", "INTEGER"],
  ["tombstoned", "INTEGER"],
  ["enriched_at", "INTEGER"],
  ["anchored_at", "INTEGER"],
  ["anchor_tx", "TEXT"],
  ["anchor_fee", "TEXT"],
  ["discovered_at", "INTEGER"],
  ["off_criterion", "INTEGER"],
];

// Settings live in the `meta` KV under stable keys.
const META_ACTIVE = "settings:active";
const META_BUDGET = "settings:import_budget";

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
  handle: string | null;
  key_count: number | null;
  last_op_at: number | null;
  tombstoned: number | null;
  enriched_at: number | null;
  anchored_at: number | null;
  anchor_tx: string | null;
  anchor_fee: string | null;
  discovered_at: number | null;
  off_criterion: number | null;
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
    handle: row.handle,
    keyCount: row.key_count,
    lastOpAt: row.last_op_at,
    tombstoned: row.tombstoned === null ? null : row.tombstoned !== 0,
    enrichedAt: row.enriched_at,
    anchoredAt: row.anchored_at,
    anchorTx: row.anchor_tx,
    anchorFee: row.anchor_fee,
    discoveredAt: row.discovered_at,
    offCriterion: row.off_criterion === null ? null : row.off_criterion !== 0,
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
    this.#migrate();
    // Indexes on the migrated columns must come after the ALTERs above (they don't exist on a
    // pre-existing DB until the migration adds them).
    this.#db.exec(POST_MIGRATE_INDEXES);
  }

  /** Add any post-initial columns missing from a pre-existing DB (idempotent). `CREATE TABLE IF
   * NOT EXISTS` never alters an existing table, so a store opened on an old file needs this. */
  #migrate(): void {
    const cols = new Set(
      (this.#db.prepare("PRAGMA table_info(roster)").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const [name, type] of ADDED_COLUMNS) {
      if (!cols.has(name)) this.#db.exec(`ALTER TABLE roster ADD COLUMN ${name} ${type}`);
    }
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

  /** Server-side paginated / filtered / sorted query — the roster grid's backend at 20k+ scale.
   * `q` is a substring over DID + handle; `pdsHost` a substring over the PDS host. Returns the
   * page plus the unpaginated `total` so the UI can render pagination. */
  query(opts: RosterQuery = {}): { rows: RosterEntry[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.state) {
      where.push("state = ?");
      params.push(opts.state);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.pdsHost) {
      where.push("pds_host LIKE ? ESCAPE '\\'");
      params.push(`%${likeEscape(opts.pdsHost)}%`);
    }
    if (opts.q) {
      where.push("(did LIKE ? ESCAPE '\\' OR handle LIKE ? ESCAPE '\\')");
      params.push(`%${likeEscape(opts.q)}%`, `%${likeEscape(opts.q)}%`);
    }
    if (opts.offCriterion) where.push("off_criterion = 1");
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

    const total = (
      this.#db.prepare(`SELECT COUNT(*) AS n FROM roster${clause}`).get(...params) as { n: number }
    ).n;

    const col = SORT_COLUMNS[opts.sort ?? ""] ?? "updated_at";
    const order = opts.order === "asc" ? "ASC" : "DESC";
    // Fee is a decimal felt string: order it numerically.
    const orderExpr = col === "anchor_fee" ? "CAST(anchor_fee AS REAL)" : col;
    const limit = clampInt(opts.limit, 50, 1, 1000);
    const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const rows = this.#db
      .prepare(
        `SELECT * FROM roster${clause} ORDER BY ${orderExpr} ${order}, did ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return { rows: (rows as RosterRow[]).map(toEntry), total };
  }

  /** Dashboard rollup: counts by state + status, the approved backlog, anchored count, and the
   * cumulative + average on-chain fee (BigInt-summed over the raw felt strings). */
  aggregates(): Aggregates {
    const byState: Record<string, number> = {};
    for (const r of this.#db
      .prepare("SELECT state, COUNT(*) AS n FROM roster GROUP BY state")
      .all() as { state: string; n: number }[]) {
      byState[r.state] = r.n;
    }
    const byStatus: Record<string, number> = {};
    for (const r of this.#db
      .prepare("SELECT status, COUNT(*) AS n FROM roster WHERE status IS NOT NULL GROUP BY status")
      .all() as { status: string; n: number }[]) {
      byStatus[r.status] = r.n;
    }
    const fees = this.#db
      .prepare("SELECT anchor_fee FROM roster WHERE anchor_fee IS NOT NULL")
      .all() as { anchor_fee: string }[];
    let feeTotal = 0n;
    for (const f of fees) feeTotal += parseFelt(f.anchor_fee) ?? 0n;
    const withFee = fees.length;

    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    const scalar = (sql: string): number =>
      (this.#db.prepare(sql).get() as { n: number }).n;
    const enriched = scalar("SELECT COUNT(*) AS n FROM roster WHERE enriched_at IS NOT NULL");
    const pending = scalar(
      "SELECT COUNT(*) AS n FROM roster WHERE state != 'removed' AND enriched_at IS NULL",
    );
    const offCriterion = scalar("SELECT COUNT(*) AS n FROM roster WHERE off_criterion = 1");

    return {
      total,
      byState,
      byStatus,
      backlog: byState.approved ?? 0,
      anchored: byState.anchored ?? 0,
      diverged: byStatus.diverged ?? 0,
      feeTotal: feeTotal.toString(),
      feeAverage: withFee > 0 ? (feeTotal / BigInt(withFee)).toString() : "0",
      anchoredWithFee: withFee,
      enrichment: { enriched, pending },
      offCriterion,
    };
  }

  /** Every non-`removed` entry — the DIDs the refresher checks against the anchor. */
  listActive(): RosterEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM roster WHERE state != 'removed' ORDER BY updated_at DESC")
      .all();
    return (rows as RosterRow[]).map(toEntry);
  }

  /** DIDs due for enrichment: never enriched, or enriched before `staleBefore` (epoch ms). Skips
   * `removed` tombstones. Never-enriched first, then oldest, so the backlog drains fairly. */
  needingEnrichment(staleBefore: number, limit = 50): RosterEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM roster
          WHERE state != 'removed' AND (enriched_at IS NULL OR enriched_at < ?)
          ORDER BY enriched_at IS NOT NULL, enriched_at ASC
          LIMIT ?`,
      )
      .all(staleBefore, limit);
    return (rows as RosterRow[]).map(toEntry);
  }

  /** The alarm list: any live DID the witness reports as `diverged`. */
  diverged(): RosterEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM roster WHERE state != 'removed' AND status = 'diverged'")
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
          `INSERT INTO roster (did, state, source, pds_host, discovered_at, created_at, updated_at)
           VALUES (?, 'candidate', ?, ?, ?, ?, ?)`,
        )
        .run(did, source, pdsHost, now, now, now);
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
    // Stamp the first time a DID becomes anchored (kept across later refreshes).
    const stampAnchored = to === "anchored" && entry.anchoredAt === null;
    this.#db
      .prepare(
        `UPDATE roster SET state = ?, updated_at = ?${clearErr ? ", error = NULL" : ""}${
          stampAnchored ? ", anchored_at = ?" : ""
        } WHERE did = ?`,
      )
      .run(...(stampAnchored ? [to, this.#now(), this.#now(), did] : [to, this.#now(), did]));
    return this.get(did)!;
  }

  /** Discovery path: propose a DID and immediately advance it to `approved` (queued for the
   * onboarder). Replaces the manual per-DID approve gate for the criterion-driven deployment —
   * the Active toggle + per-tick budget are the spend guardrail now. Idempotent; leaves an
   * already-`approved`/`onboarding`/`anchored` DID in place. Returns the resulting entry. */
  autoApprove(did: string, source: string, pdsHost: string | null = null): RosterEntry {
    const entry = this.upsertCandidate(did, source, pdsHost);
    if (entry.state === "candidate") return this.transition(did, "approved");
    return entry;
  }

  /** Record enrichment (PLC-derived identity context) for a DID. No-op for an unknown DID.
   * `offCriterion` (optional) flags that the DID's authoritative PDS host no longer satisfies the
   * criterion — computed by the enrich worker, which knows the current criterion. */
  setEnrichment(
    did: string,
    e: {
      handle: string | null;
      pdsHost: string | null;
      keyCount: number | null;
      lastOpAt: number | null;
      tombstoned: boolean | null;
      offCriterion?: boolean | null;
    },
  ): void {
    this.#db
      .prepare(
        `UPDATE roster
           SET handle = ?, pds_host = ?, key_count = ?, last_op_at = ?, tombstoned = ?,
               off_criterion = ?, enriched_at = ?, updated_at = ?
         WHERE did = ?`,
      )
      .run(
        e.handle,
        e.pdsHost,
        e.keyCount,
        e.lastOpAt,
        e.tombstoned === null ? null : e.tombstoned ? 1 : 0,
        e.offCriterion === undefined || e.offCriterion === null ? null : e.offCriterion ? 1 : 0,
        this.#now(),
        this.#now(),
        did,
      );
  }

  /** Record the on-chain cost of anchoring a DID. `fee` is accumulated (a DID may take several
   * txs — genesis + appends); `tx` is stored as the latest (tip) tx. No-op for an unknown DID. */
  setAnchorCost(did: string, tx: string | null, fee: string | null): void {
    const existing = this.get(did);
    if (existing === null) return;
    const total = addFelt(existing.anchorFee, fee);
    this.#db
      .prepare("UPDATE roster SET anchor_tx = ?, anchor_fee = ?, updated_at = ? WHERE did = ?")
      .run(tx ?? existing.anchorTx, total, this.#now(), did);
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

  /** Reflect that `did` is anchored on-chain (observed by the refresher, however it got there):
   * promote candidate/approved/onboarding → anchored. Idempotent; a no-op for removed DIDs. */
  markObservedAnchored(did: string): void {
    const entry = this.get(did);
    if (entry === null || entry.state === "anchored" || entry.state === "removed") return;
    this.transition(did, "anchored");
  }

  /** Contract-change reconcile: `anchored`/`onboarding` state records that a DID was written to a
   * *specific* anchor contract. When the contract address changes (a redeploy / mainnet cutover),
   * that state is stale — the new contract's roster starts empty — so re-queue those DIDs for
   * onboarding to the new contract and clear the old on-chain provenance + status. This is a
   * deliberate reconcile, not a lifecycle transition (hence a direct write, bypassing
   * `ALLOWED_TRANSITIONS`, which has no `anchored → approved` edge by design). Returns the count
   * reset. `removed` tombstones and in-flight `candidate`/`approved` are left untouched. */
  reconcileForContract(): number {
    const res = this.#db
      .prepare(
        `UPDATE roster
           SET state = 'approved',
               anchor_tx = NULL, anchor_fee = NULL, anchored_at = NULL,
               status = NULL, status_reason = NULL, head_cid = NULL, status_checked_at = NULL,
               error = NULL, updated_at = ?
         WHERE state IN ('anchored', 'onboarding')`,
      )
      .run(this.#now());
    return Number(res.changes);
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

  /** All meta rows whose key starts with `prefix` (e.g. the per-PDS enumerate cursors). */
  metaWithPrefix(prefix: string): { key: string; value: string }[] {
    return this.#db
      .prepare("SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
      .all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`) as { key: string; value: string }[];
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(key, value, value);
  }

  // ---- worker status (persist each loop's last run so it's visible in the UI) ----

  /** Merge a partial status update into `worker`'s record. Persisting here (not just logging)
   * makes the periodic runs — and any errors, which otherwise only hit the process log — visible. */
  setWorkerStatus(worker: string, partial: Partial<WorkerStatus>): void {
    const key = WORKER_STATUS_PREFIX + worker;
    let current: Partial<WorkerStatus> = {};
    const raw = this.getMeta(key);
    if (raw !== null) {
      try {
        current = JSON.parse(raw) as Partial<WorkerStatus>;
      } catch {
        current = {};
      }
    }
    this.setMeta(key, JSON.stringify({ ...current, ...partial }));
  }

  /** All persisted worker records, keyed by worker name. */
  workerStatuses(): Record<string, WorkerStatus> {
    const out: Record<string, WorkerStatus> = {};
    for (const { key, value } of this.metaWithPrefix(WORKER_STATUS_PREFIX)) {
      try {
        out[key.slice(WORKER_STATUS_PREFIX.length)] = JSON.parse(value) as WorkerStatus;
      } catch {
        /* skip a corrupt record */
      }
    }
    return out;
  }

  // ---- settings (persisted so the toggle/budget survive restarts) ---------

  /** The on-chain spend gate. Defaults to `false` when never set (fail-safe: no spend at boot). */
  getActive(): boolean {
    return this.getMeta(META_ACTIVE) === "1";
  }

  setActive(active: boolean): void {
    this.setMeta(META_ACTIVE, active ? "1" : "0");
  }

  /** Seed the boot default only when the operator has never set it (so a restart honours the last
   * toggle, not the env default). */
  setActiveDefault(active: boolean): void {
    if (this.getMeta(META_ACTIVE) === null) this.setActive(active);
  }

  /** Per-tick import budget override, or `null` to fall back to the env/caller default. */
  getBudget(): number | null {
    const raw = this.getMeta(META_BUDGET);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  setBudget(budget: number | null): void {
    if (budget === null) this.#db.prepare("DELETE FROM meta WHERE key = ?").run(META_BUDGET);
    else this.setMeta(META_BUDGET, String(Math.max(0, Math.trunc(budget))));
  }

  /** The full persisted settings snapshot. */
  getSettings(): Settings {
    return { active: this.getActive(), importBudget: this.getBudget() };
  }
}

/** Sum two raw decimal felt strings (on-chain fees, STRK wei) as BigInts. Either may be null. */
function addFelt(a: string | null, b: string | null): string | null {
  const ba = parseFelt(a);
  const bb = parseFelt(b);
  if (ba === null && bb === null) return a ?? b ?? null;
  return String((ba ?? 0n) + (bb ?? 0n));
}

function parseFelt(v: string | null): bigint | null {
  if (v === null || v.trim() === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}
