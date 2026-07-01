//! Filter discover-scan — the dynamic-roster half. Polls a PLC mirror's `/export` stream and
//! upserts a `candidate` for every op whose PDS host matches an enabled `pds_host` filter.
//!
//! This only *proposes*: matches land as `candidate`, behind the approve gate (the cost
//! guardrail), so a broad filter can never auto-anchor the network. It is non-consensus —
//! `ingest` re-verifies and integrity-checks anything actually onboarded.
//!
//! The `/export` shape mirrors `ingest`'s `ExportEntry` (oldest-first, paginated by the last
//! `createdAt`). The fetch transport is injectable so scanning is offline-testable.

import { pdsHostFromOp } from "./pdshost.ts";
import type { RosterStore } from "./roster.ts";

const CURSOR_KEY = "discover_cursor";

/** One `/export` entry (a signed op as served by the directory/mirror). */
export interface ExportEntry {
  did: string;
  operation: unknown;
  cid: string;
  nullified?: boolean;
  createdAt: string;
}

export type Fetcher = (url: string) => Promise<Response>;

/** Reads pages of a directory/mirror's `/export` stream. */
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
    // The export is JSON Lines (one entry per line); tolerate a trailing newline.
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ExportEntry);
  }
}

export interface ScanResult {
  scanned: number;
  matched: number;
  cursor: string | null;
}

export class DiscoverService {
  readonly #store: RosterStore;
  readonly #client: ExportClient;

  constructor(store: RosterStore, client: ExportClient) {
    this.#store = store;
    this.#client = client;
  }

  /** Scan one page from the persisted cursor, upsert matching candidates, advance the cursor.
   * A no-op (returns `matched: 0`) when no `pds_host` filters are enabled. */
  async scanOnce(count = 1000): Promise<ScanResult> {
    const filters = this.#store.listFilters(true).filter((f) => f.type === "pds_host");
    const after = this.#store.getMeta(CURSOR_KEY);
    if (filters.length === 0) return { scanned: 0, matched: 0, cursor: after };

    const page = await this.#client.page(after, count);
    let matched = 0;
    for (const entry of page) {
      const host = pdsHostFromOp(entry.operation);
      if (host === null) continue;
      const hit = filters.find((f) => f.value.toLowerCase() === host.toLowerCase());
      if (hit === undefined) continue;
      // Match per-op for simplicity; upsert is idempotent and the onboarder re-verifies the
      // DID's current state, so a since-migrated DID is harmless (a refinement: confirm the
      // current head's PDS before proposing).
      this.#store.upsertCandidate(entry.did, `filter:${hit.id}`, host);
      matched += 1;
    }

    const cursor = page.length > 0 ? page[page.length - 1].createdAt : after;
    if (cursor !== null && cursor !== after) this.#store.setMeta(CURSOR_KEY, cursor);
    return { scanned: page.length, matched, cursor };
  }
}
