//! PDS transport — enumerate a known atproto PDS via `com.atproto.sync.listRepos`.
//!
//! Discovery's backlog half: `plc.directory` has no "list DIDs on PDS X" API, so we ask the PDS
//! itself. This is *complete and cheap* — one paginated call per ~1000 repos. Trust note: we only
//! use this to *select* candidates; enrichment re-resolves each DID from PLC (authoritative) and
//! `ingest` re-verifies before any anchor, so the PDS's self-report never rides into the anchored
//! bytes. The fetch transport is injectable so enumeration is offline-testable with fixtures.

/** One repo as listed by a PDS. We only care about the DID; other fields are carried opaquely. */
export interface RepoEntry {
  did: string;
  head?: string;
  rev?: string;
  active?: boolean;
}

/** One page of `listRepos`: the did:plc repos on this page + the next cursor (null when drained). */
export interface ListReposPage {
  repos: RepoEntry[];
  cursor: string | null;
}

export type Fetcher = (url: string) => Promise<Response>;

/** Reads pages of a PDS's `com.atproto.sync.listRepos` endpoint. */
export class PdsClient {
  readonly #baseUrl: string;
  readonly #fetch: Fetcher;

  constructor(baseUrl: string, fetcher: Fetcher = (u) => fetch(u)) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetcher;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** One page after `cursor`. Filters to `did:plc` (the only DIDs this anchor handles; a PDS may
   * also host `did:web` repos). Returns the raw next cursor from the PDS, or null when exhausted. */
  async listRepos(cursor: string | null, limit = 1000): Promise<ListReposPage> {
    const url = new URL(`${this.#baseUrl}/xrpc/com.atproto.sync.listRepos`);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await this.#fetch(url.toString());
    if (!res.ok) throw new Error(`listRepos: HTTP ${res.status}`);
    const body = (await res.json()) as { repos?: unknown; cursor?: unknown };
    const repos: RepoEntry[] = Array.isArray(body.repos)
      ? (body.repos as RepoEntry[]).filter(
          (r) => r !== null && typeof r.did === "string" && r.did.startsWith("did:plc:"),
        )
      : [];
    const next = typeof body.cursor === "string" && body.cursor.length > 0 ? body.cursor : null;
    return { repos, cursor: next };
  }
}
