//! Binding to `@plc-anchor/witness` — the only file that reaches across to the witness package.
//!
//! Isolated so the rest of the console depends on the `StatusChecker` interface, not on witness
//! resolution (tests mock the interface; this file is loaded only at runtime). Reuses the
//! library's `check()` verbatim — the never-false-`diverged` invariant stays there, unduplicated.

import {
  type AnchorOp,
  AnchorReader,
  type ChainCache,
  check,
  DerivationCache,
  DirectoryClient,
  EventCachingAnchorView,
} from "../../witness-ts/src/index.ts";
import type { AuditEntry, IdentityResolver } from "./enrich.ts";
import type { CheckOutcome, RefreshCycleStats, StatusChecker } from "./refresh.ts";
import { CHAIN_CACHE_CURSOR_KEY } from "./roster.ts";

/** The slice of `RosterStore` the chain cache needs (so it's trivial to fake in tests). */
export interface ChainCacheStore {
  getChainCache(did: string): string | null;
  setChainCache(did: string, ops: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** Serialized form of one cached op: `signed` bytes as base64 (JSON can't hold a Uint8Array). */
interface StoredOpJson {
  signed: string;
  createdAt: number;
  imported: boolean;
}

const encodeOps = (ops: AnchorOp[]): string =>
  JSON.stringify(
    ops.map((o): StoredOpJson => ({
      signed: Buffer.from(o.signed).toString("base64"),
      createdAt: o.createdAt,
      imported: o.imported,
    })),
  );

const decodeOps = (json: string): AnchorOp[] =>
  (JSON.parse(json) as StoredOpJson[]).map((o) => ({
    signed: new Uint8Array(Buffer.from(o.signed, "base64")),
    createdAt: o.createdAt,
    imported: o.imported,
  }));

/** Adapts the persisted `RosterStore` to the witness library's `ChainCache` port: per-DID chains
 * as base64 JSON, and the event cursor in the store's `meta` KV (under the key the contract-switch
 * reconcile sweeps, so a redeploy cold-starts the cache). */
export class StoreChainCache implements ChainCache {
  readonly #store: ChainCacheStore;

  constructor(store: ChainCacheStore) {
    this.#store = store;
  }

  get(did: string): AnchorOp[] | null {
    const raw = this.#store.getChainCache(did);
    return raw === null ? null : decodeOps(raw);
  }

  set(did: string, ops: AnchorOp[]): void {
    this.#store.setChainCache(did, encodeOps(ops));
  }

  getCursor(): number | null {
    const raw = this.#store.getMeta(CHAIN_CACHE_CURSOR_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  setCursor(block: number): void {
    this.#store.setMeta(CHAIN_CACHE_CURSOR_KEY, String(block));
  }
}

/** Wraps the witness `check(did)` for the refresher. Held across cycles (rebuilt only when the
 * directory URL changes) so its in-memory derivation memo survives — see `main.ts`.
 *
 * Two caches sit under `check()`, both primed by `beginCycle()` once per `refreshAll` pass:
 *   - `EventCachingAnchorView` (network): probes the anchor's `Stored` events and, when none fired,
 *     serves every DID's op log from the persisted chain cache instead of re-reading it from RPC.
 *   - `DerivationCache` (CPU): memoizes the PLC re-derivation (ECDSA verification) of each DID's
 *     anchor + directory logs on a content hash, so an unchanged log is not re-verified. This is
 *     the dominant cost on a shared CPU; the chain cache alone didn't touch it.
 * `cycleStats()` surfaces both — logs re-read from RPC and chains re-verified. */
export class WitnessChecker implements StatusChecker {
  readonly #anchor: EventCachingAnchorView;
  readonly #directory: DirectoryClient;
  readonly #derivation = new DerivationCache();

  constructor(store: ChainCacheStore, rpcUrl: string, contractAddress: string, directoryUrl?: string) {
    this.#anchor = new EventCachingAnchorView(
      AnchorReader.http(rpcUrl, contractAddress),
      new StoreChainCache(store),
    );
    this.#directory = new DirectoryClient(directoryUrl);
  }

  async beginCycle(): Promise<void> {
    this.#derivation.beginCycle();
    await this.#anchor.beginCycle();
  }

  cycleStats(): RefreshCycleStats {
    return {
      refetched: this.#anchor.stats().refetched,
      verified: this.#derivation.stats().verified,
    };
  }

  async check(did: string): Promise<CheckOutcome> {
    const result = await check(did, this.#anchor, this.#directory, {
      deriveAnchor: this.#derivation.deriveAnchor,
      deriveLive: this.#derivation.deriveLive,
    });
    return {
      status: result.status,
      reason: result.reason,
      // Prefer the directory's served head; fall back to the anchor tip when the directory is
      // silent (e.g. `absent`). Never throws on a missing head.
      headCid: result.evidence.directoryHead ?? result.evidence.anchorTentativeHead ?? null,
    };
  }
}

/** Adapts the witness `DirectoryClient` to the enrichment `IdentityResolver` seam, so `enrich.ts`
 * stays witness-free (and offline-testable) while the real HTTP resolution reuses the library. */
export class DirectoryResolver implements IdentityResolver {
  readonly #directory: DirectoryClient;

  constructor(directoryUrl?: string) {
    this.#directory = new DirectoryClient(directoryUrl);
  }

  async auditLog(did: string): Promise<AuditEntry[]> {
    return this.#directory.auditLog(did);
  }
}
