//! Discovery — how DIDs enter the criterion-driven roster. Two halves (REFERENCE.md §6, MVP §2):
//!
//!   - **enumerate** (backlog): page a known PDS's `listRepos` and auto-queue every `did:plc` it
//!     hosts. Cheap and complete; the practical way to seed ~20k accounts.
//!   - **tail** (ongoing): poll a PLC mirror's `/export` from ~now and auto-queue any op whose PDS
//!     host satisfies the criterion — the identity-change signal the witness exists for.
//!
//! Both **auto-approve** matches (`candidate -> approved`): the old per-DID human approve gate does
//! not scale to 20k, so the spend guardrail moved to the Active toggle + per-tick import budget on
//! the onboarder. This still only *proposes*; `ingest` re-verifies and integrity-checks anything
//! actually onboarded, so a broad match can never auto-anchor bad bytes. Both fetch transports are
//! injectable so scanning is offline-testable.

import type { Criterion } from "./criterion.ts";
import type { PdsClient } from "./pds.ts";
import { hostOf } from "./pdshost.ts";
import type { RosterStore } from "./roster.ts";

const TAIL_CURSOR_KEY = "tail_cursor";
const ENUMERATE_CURSOR_PREFIX = "enumerate_cursor:";
/** Sentinel stored as a PDS's enumerate cursor once its backlog is fully drained. */
const ENUMERATE_DONE = "__complete__";

/** One `/export` entry (a signed op as served by the directory/mirror). */
export interface ExportEntry {
  did: string;
  operation: unknown;
  cid: string;
  nullified?: boolean;
  createdAt: string;
}

export type Fetcher = (url: string) => Promise<Response>;

/** Reads pages of a directory/mirror's `/export` stream (JSON Lines, oldest-first). */
export class ExportClient {
  readonly #baseUrl: string;
  readonly #fetch: Fetcher;

  constructor(baseUrl = "https://plc.directory", fetcher: Fetcher = (u) => fetch(u)) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetcher;
  }

  /** One page after `after` (a `createdAt` cursor), oldest-first. */
  async page(after: string | null, count = 1000): Promise<ExportEntry[]> {
    const url = new URL(`${this.#baseUrl}/export`);
    url.searchParams.set("count", String(count));
    if (after) url.searchParams.set("after", after);
    const res = await this.#fetch(url.toString());
    if (!res.ok) throw new Error(`/export: HTTP ${res.status}`);
    const text = await res.text();
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ExportEntry);
  }
}

export interface EnumerateResult {
  /** Repos returned on this page (before the criterion — enumeration trusts the PDS list). */
  scanned: number;
  /** New/queued candidates from this page. */
  queued: number;
  /** True once this PDS is fully drained (no more pages). */
  done: boolean;
}

/** Backlog enumeration of a single PDS: page `listRepos`, auto-approve every `did:plc`. The
 * per-PDS cursor is persisted so a restart resumes mid-backlog; once drained it idles. */
export class EnumerationService {
  readonly #store: RosterStore;
  readonly #client: PdsClient;
  readonly #source: string;

  constructor(store: RosterStore, client: PdsClient) {
    this.#store = store;
    this.#client = client;
    // The PDS host is what these DIDs are hosted on — used as the source tag and provisional
    // pdsHost until enrichment re-resolves the authoritative endpoint from PLC.
    this.#source = hostOf(client.baseUrl) ?? client.baseUrl;
  }

  get #cursorKey(): string {
    return ENUMERATE_CURSOR_PREFIX + this.#client.baseUrl;
  }

  /** Enumerate one page from the persisted cursor. A no-op (`done: true`) once drained. */
  async enumerateOnce(limit = 1000): Promise<EnumerateResult> {
    const saved = this.#store.getMeta(this.#cursorKey);
    if (saved === ENUMERATE_DONE) return { scanned: 0, queued: 0, done: true };

    const page = await this.#client.listRepos(saved, limit);
    let queued = 0;
    for (const repo of page.repos) {
      const before = this.#store.get(repo.did);
      this.#store.autoApprove(repo.did, `pds:${this.#source}`, this.#source);
      if (before === null) queued += 1;
    }

    // Advance the cursor; when the PDS returns no next cursor, the backlog is drained.
    if (page.cursor === null) {
      this.#store.setMeta(this.#cursorKey, ENUMERATE_DONE);
      return { scanned: page.repos.length, queued, done: true };
    }
    this.#store.setMeta(this.#cursorKey, page.cursor);
    return { scanned: page.repos.length, queued, done: false };
  }

  /** Drain the whole PDS backlog (bounded by `maxPages` per call to stay responsive). Returns the
   * totals across the pages walked. */
  async enumerateBacklog(limit = 1000, maxPages = 50): Promise<EnumerateResult> {
    let scanned = 0;
    let queued = 0;
    for (let i = 0; i < maxPages; i += 1) {
      const r = await this.enumerateOnce(limit);
      scanned += r.scanned;
      queued += r.queued;
      if (r.done) return { scanned, queued, done: true };
    }
    return { scanned, queued, done: false };
  }
}

export interface TailResult {
  scanned: number;
  matched: number;
  cursor: string | null;
}

/** Ongoing tail of `/export` against the criterion. Starts from ~now (not genesis) so it only
 * catches identity changes going forward; the backlog is enumeration's job. Auto-approves matches. */
export class TailService {
  readonly #store: RosterStore;
  readonly #client: ExportClient;
  readonly #criterion: Criterion;
  readonly #now: () => number;

  constructor(
    store: RosterStore,
    client: ExportClient,
    criterion: Criterion,
    now: () => number = Date.now,
  ) {
    this.#store = store;
    this.#client = client;
    this.#criterion = criterion;
    this.#now = now;
  }

  /** Scan one page from the persisted cursor, auto-approve matching candidates, advance the cursor.
   * On the very first run (no cursor) it seeds the cursor to ~now and returns without scanning, so
   * the tail never replays PLC history from genesis. */
  async scanOnce(count = 1000): Promise<TailResult> {
    let after = this.#store.getMeta(TAIL_CURSOR_KEY);
    if (after === null) {
      after = new Date(this.#now()).toISOString();
      this.#store.setMeta(TAIL_CURSOR_KEY, after);
      return { scanned: 0, matched: 0, cursor: after };
    }

    const page = await this.#client.page(after, count);
    let matched = 0;
    for (const entry of page) {
      if (!this.#criterion.matchesOp(entry.operation)) continue;
      this.#store.autoApprove(entry.did, `pds:${this.#criterion.base}`, this.#criterion.base);
      matched += 1;
    }

    const cursor = page.length > 0 ? page[page.length - 1].createdAt : after;
    if (cursor !== null && cursor !== after) this.#store.setMeta(TAIL_CURSOR_KEY, cursor);
    return { scanned: page.length, matched, cursor };
  }
}
