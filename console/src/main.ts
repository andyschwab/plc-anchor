//! Console entry point — wires the store, the HTTP API, and the worker loops for the criterion-
//! driven ("Eurosky MVP") deployment: enumerate a PDS → tail /export → enrich identity → onboard
//! (only when Active, budget-capped) → refresh status.
//!
//! Run: `node --experimental-sqlite src/main.ts`. **Non-secret config is live-editable** via the
//! Settings panel (`GET/PUT /settings`, persisted in the store): the criterion, PDS endpoints,
//! budget, loop cadences, enrich batch/delay, and directory/mirror URLs all take effect on the next
//! tick with no restart — env just seeds the boot defaults. Boot-only + secret config (port, DB
//! path, contract address, ingest command, RPC, keys, the admin token) stays in env and is surfaced
//! read-only in the panel.
//!
//! Env (all optional; each seeds the matching live setting or a boot-only knob):
//!   PORT / ROSTER_DB                          HTTP port (8787) / SQLite path (./roster.db)
//!   ROSTER_CRITERION / PDS_ENDPOINTS          seed the criterion / enumeration targets
//!   IMPORT_BUDGET_PER_TICK / ACTIVE_DEFAULT   seed the budget / boot Active state
//!   {ENUMERATE,TAIL,ENRICH,REFRESH}_INTERVAL_MS   seed loop cadences (0 disables)
//!   ENUMERATE_PAGE_SIZE                       seed listRepos page size (repos per enumerate tick)
//!   ENRICH_BATCH / ENRICH_DELAY_MS            seed enrich batch size / inter-request ms
//!   PLC_DIRECTORY_URL / PLC_MIRROR_URL        seed the directory / mirror bases
//!   SETTINGS_DEFAULTS_FILE                    optional JSON file of default settings (below env)
//!   STARKNET_RPC                              JSON-RPC endpoint (enables refresh + fee lookups)
//!   ANCHOR_CONTRACT_ADDRESS                   anchor contract (default: the Sepolia deployment)
//!   INGEST_COMMAND                            ingest argv for onboarding (enables on-chain writes)
//!   CONSOLE_ADMIN_TOKEN / CONSOLE_SESSION_TTL_MS / CONSOLE_ALLOW_OPEN_WRITES   the write gate

import { readFileSync } from "node:fs";
import { SharedSecretAuth, type Authenticator } from "./auth.ts";
import { parseCriterion } from "./criterion.ts";
import { EnumerationService, ExportClient, TailService } from "./discover.ts";
import { EnrichmentService } from "./enrich.ts";
import { starknetFeeResolver } from "./fees.ts";
import { Onboarder, SpawnRunner, type FeeResolver } from "./onboard.ts";
import { PdsClient } from "./pds.ts";
import { RefreshService } from "./refresh.ts";
import { RosterStore } from "./roster.ts";
import { SETTINGS_DEFAULTS, SettingsStore, validateSettings, type ConsoleSettings } from "./settings.ts";
import { createConsoleServer, type SettingsPort, type WorkerActions } from "./server.ts";
import { DirectoryResolver, WitnessChecker } from "./witness.ts";

// Post-4a redeploy (the "imported ops are settled" fix); overridable via ANCHOR_CONTRACT_ADDRESS.
const SEPOLIA_ANCHOR = "0x01e3cd42e8481a40b366ef32940e8bc050fd79c924c9b838a6dc0338a08fc5c3";
const bool = (v: string | undefined): boolean => /^(1|true)$/i.test(v?.trim() ?? "");
const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : dflt;
};
const list = (v: string | undefined): string[] | undefined =>
  v?.trim() ? v.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined;

// --- Boot-only / secret config (restart to change) ---------------------------
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.ROSTER_DB ?? "./roster.db";
const contractAddress = process.env.ANCHOR_CONTRACT_ADDRESS ?? SEPOLIA_ANCHOR;
const rpc = process.env.STARKNET_RPC;
const ingestCommand = process.env.INGEST_COMMAND?.trim();

/** Build the live-settings defaults: hardcoded ← optional JSON file ← env. Persisted UI edits
 * (in the store) then override these at runtime. Fails loudly on invalid env/file config. */
function settingsDefaults(): ConsoleSettings {
  const d: ConsoleSettings = { ...SETTINGS_DEFAULTS };
  const file = process.env.SETTINGS_DEFAULTS_FILE?.trim();
  if (file) {
    try {
      Object.assign(d, JSON.parse(readFileSync(file, "utf8")) as Partial<ConsoleSettings>);
    } catch (err) {
      console.error(`[settings] ignoring ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const e = process.env;
  if (e.ROSTER_CRITERION?.trim()) d.criterion = e.ROSTER_CRITERION.trim();
  const eps = list(e.PDS_ENDPOINTS);
  if (eps) d.pdsEndpoints = eps;
  if (e.IMPORT_BUDGET_PER_TICK !== undefined) d.importBudget = num(e.IMPORT_BUDGET_PER_TICK, d.importBudget);
  if (e.ACTIVE_DEFAULT !== undefined) d.active = bool(e.ACTIVE_DEFAULT);
  if (e.ENUMERATE_PAGE_SIZE !== undefined) d.enumeratePageSize = num(e.ENUMERATE_PAGE_SIZE, d.enumeratePageSize);
  if (e.ENUMERATE_INTERVAL_MS !== undefined) d.enumerateIntervalMs = num(e.ENUMERATE_INTERVAL_MS, d.enumerateIntervalMs);
  if (e.TAIL_INTERVAL_MS !== undefined) d.tailIntervalMs = num(e.TAIL_INTERVAL_MS, d.tailIntervalMs);
  if (e.ENRICH_INTERVAL_MS !== undefined) d.enrichIntervalMs = num(e.ENRICH_INTERVAL_MS, d.enrichIntervalMs);
  if (e.REFRESH_INTERVAL_MS !== undefined) d.refreshIntervalMs = num(e.REFRESH_INTERVAL_MS, d.refreshIntervalMs);
  if (e.ENRICH_BATCH !== undefined) d.enrichBatch = num(e.ENRICH_BATCH, d.enrichBatch);
  if (e.ENRICH_DELAY_MS !== undefined) d.enrichDelayMs = num(e.ENRICH_DELAY_MS, d.enrichDelayMs);
  if (e.PLC_DIRECTORY_URL?.trim()) {
    d.directoryUrl = e.PLC_DIRECTORY_URL.trim();
    d.mirrorUrl = d.directoryUrl; // the mirror follows the directory unless set explicitly
  }
  if (e.PLC_MIRROR_URL?.trim()) d.mirrorUrl = e.PLC_MIRROR_URL.trim();
  return validateSettings(d);
}

const store = RosterStore.open(dbPath);
const settings = new SettingsStore(store, settingsDefaults());
settings.seedDefaults();

// Contract-change reconcile: `anchored`/`onboarding` state records a write to a *specific* anchor
// contract. If the address changed since last boot (a redeploy / mainnet cutover), that state is
// stale (the new contract's roster starts empty), so re-queue those DIDs to re-anchor. Keyed on an
// actual change, so it's a no-op on a normal restart. The current contract is always recorded.
const lastContract = store.getMeta("anchor_contract");
if (lastContract !== null && lastContract !== contractAddress) {
  const reset = store.reconcileForContract();
  console.error(
    `[reconcile] anchor contract changed (${lastContract} → ${contractAddress}); ` +
      `reset ${reset} DID(s) to approved for re-anchoring`,
  );
}
store.setMeta("anchor_contract", contractAddress);

const feeResolver: FeeResolver | null = rpc ? starknetFeeResolver(rpc) : null;
const actions: WorkerActions = {};
let lastRefreshAt: number | null = null;

/** Short human summary of a worker result for the status panel (defensive — never throws). */
function summarize(name: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "enumerate": {
        const rows = (r.results as { queued?: number; done?: boolean }[]) ?? [];
        const queued = rows.reduce((a, x) => a + (x.queued ?? 0), 0);
        const done = rows.length > 0 && rows.every((x) => x.done);
        return `queued ${queued} · ${done ? "complete" : "paging"}`;
      }
      case "tail":
        return "skipped" in r ? String(r.skipped) : `${r.matched ?? 0} matched / ${r.scanned ?? 0} scanned`;
      case "enrich":
        return `${r.enriched ?? 0} enriched · ${r.failed ?? 0} failed`;
      case "onboard":
        return r.active ? `${r.anchored ?? 0}/${r.attempted ?? 0} anchored (budget ${r.budget})` : "inactive";
      case "refresh":
        return `${r.diverged ?? 0} diverged`;
      case "reconcile":
        return `reset ${r.reset ?? 0} → approved`;
      default:
        return JSON.stringify(result).slice(0, 80);
    }
  } catch {
    return "ok";
  }
}

/** A readable one-line error string that unwraps `err.cause`. Node's `fetch` (undici) throws a
 * bare `TypeError: fetch failed` and hides the real reason (`ENOTFOUND` / `ECONNREFUSED` / a TLS
 * error) on `.cause`; without this the UI can only ever show "fetch failed". Appends the cause's
 * `code`/message when it adds signal the top-level message doesn't already carry. */
function describeError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return base;
  const code = typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : null;
  const msg = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : null;
  const detail = [code, msg && msg !== code ? msg : null].filter(Boolean).join(": ");
  if (!detail || base.includes(detail)) return base;
  return `${base} (${detail})`;
}

/** Wrap a worker action so every run (timer *or* manual `/worker/*`) persists its status — start,
 * duration, result summary, and any error — making the otherwise-invisible loops observable. */
function instrument(name: string, fn: () => Promise<unknown>): () => Promise<unknown> {
  return async () => {
    store.setWorkerStatus(name, { running: true, startedAt: Date.now() });
    const t0 = Date.now();
    try {
      const result = await fn();
      store.setWorkerStatus(name, {
        running: false, lastRunAt: Date.now(), durationMs: Date.now() - t0,
        ok: true, summary: summarize(name, result), error: null,
      });
      return result;
    } catch (err) {
      store.setWorkerStatus(name, {
        running: false, lastRunAt: Date.now(), durationMs: Date.now() - t0,
        ok: false, error: describeError(err),
      });
      throw err;
    }
  };
}

/** Run `fn` on a self-rescheduling timer whose period is re-read from `getIntervalMs` each cycle,
 * so cadence changes (and enable/disable at 0) apply live. While disabled it polls every 30s to
 * notice a re-enable. Unref'd so it never holds the process open. */
function loop(getIntervalMs: () => number, fn: () => Promise<unknown>): void {
  const DISABLED_POLL_MS = 30_000;
  const tick = async (): Promise<void> => {
    let interval = getIntervalMs();
    if (!Number.isFinite(interval) || interval < 0) interval = 0;
    if (interval > 0) {
      try {
        await fn();
      } catch (err) {
        console.error("[worker] loop error:", err instanceof Error ? err.message : err);
      }
    }
    setTimeout(() => void tick(), interval > 0 ? interval : DISABLED_POLL_MS).unref();
  };
  void tick();
}

// --- Enumerate (backlog): page each configured PDS's listRepos → auto-approved candidates. ---
// One small page per PDS per tick — a steady trickle (e.g. 50/min) rather than one big hourly
// drain, so a slow PDS can't drop a long-lived paginated call mid-flight (UND_ERR_SOCKET). The
// per-PDS cursor persists, so the backlog still drains fully across ticks, then idles when done.
actions.enumerate = instrument("enumerate", async () => {
  const s = settings.get();
  const results = [];
  for (const url of s.pdsEndpoints) {
    results.push({ pds: url, ...(await new EnumerationService(store, new PdsClient(url)).enumerateOnce(s.enumeratePageSize)) });
  }
  return { results };
});
loop(() => settings.get().enumerateIntervalMs, actions.enumerate);

// --- Tail (ongoing): /export from ~now, criterion-filtered → auto-approved candidates. ---
actions.tail = instrument("tail", async () => {
  const s = settings.get();
  if (!s.criterion) return { skipped: "no criterion set" };
  const tail = new TailService(store, new ExportClient(s.mirrorUrl), parseCriterion(s.criterion));
  return tail.scanOnce();
});
loop(() => settings.get().tailIntervalMs, actions.tail);

// --- Enrich: throttled identity metadata + criterion re-check (always cheap/off-chain). ---
actions.enrich = instrument("enrich", async () => {
  const s = settings.get();
  const criterion = s.criterion ? parseCriterion(s.criterion) : null;
  const enricher = new EnrichmentService(store, new DirectoryResolver(s.directoryUrl), { criterion });
  return enricher.enrichStale(s.enrichBatch, s.enrichDelayMs);
});
loop(() => settings.get().enrichIntervalMs, actions.enrich);

// --- Reconcile (manual): re-queue anchored/onboarding DIDs after a contract switch. No loop. ---
actions.reconcile = instrument("reconcile", async () => ({
  reset: store.reconcileForContract(),
  contract: contractAddress,
}));

// --- Refresh (read side): §4 status + the diverged alarm. Needs an RPC. ---
if (rpc) {
  actions.refresh = instrument("refresh", async () => {
    const refresher = new RefreshService(store, new WitnessChecker(rpc, contractAddress, settings.get().directoryUrl));
    const diverged = await refresher.refreshAll();
    lastRefreshAt = Date.now();
    if (diverged > 0) console.error(`[refresh] ${diverged} DID(s) DIVERGED`);
    return { diverged, lastRefreshAt };
  });
  loop(() => settings.get().refreshIntervalMs, actions.refresh);
} else {
  console.error("[refresh] disabled (set STARKNET_RPC)");
}

// --- Onboard: the spend. Only when a live ingest is configured; gated on Active + budget. ---
if (ingestCommand) {
  const argv = ingestCommand.split(/\s+/);
  actions.onboard = instrument("onboard", async () => {
    const s = settings.get();
    const onboarder = new Onboarder(
      store,
      new SpawnRunner(),
      { ingestCommand: argv, source: s.directoryUrl, defaultBudget: s.importBudget },
      feeResolver,
    );
    return onboarder.onboardApproved();
  });
  loop(() => settings.get().refreshIntervalMs, actions.onboard);
} else {
  console.error("[onboard] disabled (set INGEST_COMMAND to enable on-chain writes)");
}

// --- Auth gate (Layer-2 access control): fail-closed unless a secret is configured. ---
const adminSecret = process.env.CONSOLE_ADMIN_TOKEN?.trim();
const sessionTtlMs = Number(process.env.CONSOLE_SESSION_TTL_MS ?? 3_600_000);
const openWrites = bool(process.env.CONSOLE_ALLOW_OPEN_WRITES);
let auth: Authenticator | undefined;
if (adminSecret) {
  auth = new SharedSecretAuth(adminSecret, sessionTtlMs);
} else if (openWrites) {
  console.error("[auth] DISABLED — writes are OPEN (CONSOLE_ALLOW_OPEN_WRITES set)");
} else {
  console.error("[auth] writes CLOSED — set CONSOLE_ADMIN_TOKEN to enable changes " +
    "(or CONSOLE_ALLOW_OPEN_WRITES=1 to run open)");
}

/** The current criterion label for healthz/UI (settings guarantees a valid-or-empty spec). */
const criterionLabel = (): string | null => {
  const c = settings.get().criterion;
  return c ? parseCriterion(c).label : null;
};

/** Boot-only / secret config, surfaced read-only in the Settings panel — presence only, no values. */
const locked = () => ({
  contractAddress,
  port,
  dbPath,
  rpcConfigured: Boolean(rpc),
  ingestConfigured: Boolean(ingestCommand),
});

/** Settings port for the API, wrapping the store so flipping **Active** on (false→true) kicks an
 * onboard cycle immediately. Otherwise the spend wouldn't start until the next onboard tick (up to
 * a refresh interval later), which reads as "onboard needs a manual click after Active". Fires the
 * existing worker action (a no-op when onboarding isn't configured); the console's `PUT /settings`
 * is the path the Settings panel uses to toggle Active, so this covers the UI and API alike. */
const settingsPort: SettingsPort = {
  get: () => settings.get(),
  patch: (partial) => {
    const wasActive = settings.get().active;
    const next = settings.patch(partial);
    if (!wasActive && settings.get().active && actions.onboard) {
      console.error("[onboard] Active turned on — kicking an onboard cycle");
      void actions.onboard().catch((err) =>
        console.error("[onboard] kick failed:", err instanceof Error ? err.message : err),
      );
    }
    return next;
  },
};

const server = createConsoleServer(store, {
  contractAddress,
  criterionLabel,
  settings: settingsPort,
  locked,
  lastRefreshAt: () => lastRefreshAt,
  actions,
  auth,
  allowOpenWrites: openWrites,
});
server.listen(port, () =>
  console.error(
    `console listening on :${port} (anchor ${contractAddress}; ` +
      `active=${store.getActive()} budget=${store.getBudget() ?? settings.get().importBudget})`,
  ),
);
