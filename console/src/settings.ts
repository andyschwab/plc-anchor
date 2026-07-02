//! Live console settings — the non-secret, runtime-editable config, persisted so a UI "Settings"
//! panel can change it without a redeploy.
//!
//! Precedence (low → high): hardcoded `SETTINGS_DEFAULTS` < a `settings.default.json` seed <
//! environment < persisted UI overrides. Env stays authoritative for any field the operator never
//! touches; an explicit edit persists and wins. Persistence reuses the store's `meta` KV (already
//! on the Fly volume, transactional) — there is no second on-disk source of truth to race.
//!
//! `active` and `importBudget` keep their canonical home in `RosterStore` (the onboarder's spend
//! gate reads them there); this facade composes over them so the whole config reads/writes as one
//! object. Secrets and boot-only knobs (RPC, keys, contract address, port, DB path, ingest command)
//! are deliberately NOT here — they stay in env and are surfaced read-only via the API's `locked`
//! snapshot.

import { parseCriterion } from "./criterion.ts";

/** The runtime-editable settings. */
export interface ConsoleSettings {
  /** Membership criterion spec, e.g. `pds_domain:eurosky.social`. Empty disables the tail. */
  criterion: string;
  /** PDS base URLs to enumerate. */
  pdsEndpoints: string[];
  /** The on-chain spend gate. */
  active: boolean;
  /** Max on-chain imports per onboard tick. */
  importBudget: number;
  /** Repos requested per `listRepos` page — one page is enumerated per tick, so this is also the
   * per-tick batch. A small, frequent trickle (e.g. 50/min) rather than one big hourly drain, so a
   * slow PDS can't drop a long-lived paginated call mid-flight. */
  enumeratePageSize: number;
  enumerateIntervalMs: number;
  tailIntervalMs: number;
  enrichIntervalMs: number;
  refreshIntervalMs: number;
  /** Enrichment per-tick batch size. */
  enrichBatch: number;
  /** Enrichment inter-request delay (the rate limit), ms. */
  enrichDelayMs: number;
  /** PLC directory base (resolve + enrichment). */
  directoryUrl: string;
  /** `/export` mirror base (the tail). */
  mirrorUrl: string;
}

/** Hardcoded baseline (matches the historical env defaults). */
export const SETTINGS_DEFAULTS: ConsoleSettings = {
  criterion: "",
  pdsEndpoints: ["https://eurosky.social"],
  active: false,
  importBudget: 25,
  enumeratePageSize: 50,
  enumerateIntervalMs: 60_000,
  tailIntervalMs: 60_000,
  enrichIntervalMs: 30_000,
  refreshIntervalMs: 300_000,
  enrichBatch: 50,
  enrichDelayMs: 200,
  directoryUrl: "https://plc.directory",
  mirrorUrl: "https://plc.directory",
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS) as (keyof ConsoleSettings)[];

/** `active`/`importBudget` live in the RosterStore, not the blob (single source of truth for the
 * spend gate). Everything else is stored in the `meta` JSON blob. */
const ROSTER_BACKED = new Set<keyof ConsoleSettings>(["active", "importBudget"]);
const BLOB_KEY = "settings:blob:v1";

/** The slice of `RosterStore` this facade needs (so it's easy to test with a fake). */
export interface SettingsBackingStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  getActive(): boolean;
  setActive(active: boolean): void;
  setActiveDefault(active: boolean): void;
  getBudget(): number | null;
  setBudget(budget: number | null): void;
}

function isInt(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

function validUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.trim().length === 0) return false;
  try {
    new URL(v.trim());
    return true;
  } catch {
    return false;
  }
}

/** Validate + normalize a full settings object, throwing on the first problem (mapped to 400 by
 * the API). Returns a trimmed/canonicalized copy. */
export function validateSettings(s: ConsoleSettings): ConsoleSettings {
  const criterion = typeof s.criterion === "string" ? s.criterion.trim() : "";
  if (criterion.length > 0) parseCriterion(criterion); // throws on a malformed criterion

  if (!Array.isArray(s.pdsEndpoints)) throw new Error("pdsEndpoints must be an array");
  const pdsEndpoints = s.pdsEndpoints.map((e) => String(e).trim()).filter((e) => e.length > 0);
  for (const e of pdsEndpoints) {
    if (!validUrl(e)) throw new Error(`invalid PDS endpoint URL: ${e}`);
  }

  if (typeof s.active !== "boolean") throw new Error("active must be a boolean");
  if (!isInt(s.importBudget, 0)) throw new Error("importBudget must be an integer ≥ 0");
  for (const k of ["enumerateIntervalMs", "tailIntervalMs", "enrichIntervalMs", "refreshIntervalMs", "enrichDelayMs"] as const) {
    if (!isInt(s[k], 0)) throw new Error(`${k} must be an integer ≥ 0`);
  }
  if (!isInt(s.enrichBatch, 1)) throw new Error("enrichBatch must be an integer ≥ 1");
  if (!isInt(s.enumeratePageSize, 1)) throw new Error("enumeratePageSize must be an integer ≥ 1");
  if (!validUrl(s.directoryUrl)) throw new Error("directoryUrl must be a valid URL");
  if (!validUrl(s.mirrorUrl)) throw new Error("mirrorUrl must be a valid URL");

  return {
    ...s,
    criterion,
    pdsEndpoints,
    directoryUrl: s.directoryUrl.trim(),
    mirrorUrl: s.mirrorUrl.trim(),
  };
}

/** Keep only recognized `ConsoleSettings` keys from an untrusted patch body. */
function pickKnown(partial: Record<string, unknown>): Partial<ConsoleSettings> {
  const out: Partial<ConsoleSettings> = {};
  for (const k of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial, k)) (out as Record<string, unknown>)[k] = partial[k];
  }
  return out;
}

export class SettingsStore {
  readonly #store: SettingsBackingStore;
  readonly #defaults: ConsoleSettings;

  constructor(store: SettingsBackingStore, defaults: ConsoleSettings = SETTINGS_DEFAULTS) {
    this.#store = store;
    this.#defaults = defaults;
  }

  /** The effective settings: defaults ← persisted blob ← roster-backed live values. */
  get(): ConsoleSettings {
    let blob: Partial<ConsoleSettings> = {};
    const raw = this.#store.getMeta(BLOB_KEY);
    if (raw !== null) {
      try {
        blob = pickKnown(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        blob = {};
      }
    }
    const merged = { ...this.#defaults, ...blob };
    merged.active = this.#store.getActive();
    merged.importBudget = this.#store.getBudget() ?? this.#defaults.importBudget;
    return merged;
  }

  /** Apply a partial update: validate the merged result, then persist (roster-backed keys to the
   * store, the rest to the blob). Unknown keys are ignored. Returns the new effective settings. */
  patch(partial: Record<string, unknown>): ConsoleSettings {
    const clean = pickKnown(partial);
    const next = validateSettings({ ...this.get(), ...clean });

    if ("active" in clean) this.#store.setActive(next.active);
    if ("importBudget" in clean) this.#store.setBudget(next.importBudget);

    const blob: Record<string, unknown> = {};
    const rawBlob = this.#store.getMeta(BLOB_KEY);
    if (rawBlob !== null) {
      try {
        Object.assign(blob, pickKnown(JSON.parse(rawBlob) as Record<string, unknown>));
      } catch {
        /* start fresh on a corrupt blob */
      }
    }
    for (const k of SETTINGS_KEYS) {
      if (k in clean && !ROSTER_BACKED.has(k)) blob[k] = next[k];
    }
    this.#store.setMeta(BLOB_KEY, JSON.stringify(blob));
    return this.get();
  }

  /** Seed the boot default for `active` only if the operator never set it (mirrors env seeding of
   * the other fields, which default via `get()` and so need no persistence until edited). */
  seedDefaults(): void {
    this.#store.setActiveDefault(this.#defaults.active);
  }
}
