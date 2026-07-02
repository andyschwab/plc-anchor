//! Console entry point — wires the store, the HTTP API, and the worker loops for the criterion-
//! driven ("Eurosky MVP") deployment: enumerate a PDS → tail /export → enrich identity → onboard
//! (only when Active, budget-capped) → refresh status.
//!
//! Run: `node --experimental-sqlite src/main.ts`. Each loop is independent and degrades to a no-op
//! when its config is absent, so the API is useful before a live anchor/account is wired. Cursors,
//! the Active toggle, and the budget all persist in the store, so a restart resumes mid-backlog and
//! honours the last operator toggle.
//!
//! Env:
//!   PORT                       HTTP port (default 8787)
//!   ROSTER_DB                  SQLite path (default ./roster.db; ":memory:" for ephemeral)
//!   ROSTER_CRITERION           membership rule, e.g. "pds_domain:eurosky.social" (enables the tail)
//!   PDS_ENDPOINTS              comma-sep PDS base URLs to enumerate (default https://eurosky.social)
//!   IMPORT_BUDGET_PER_TICK     max on-chain imports per onboard tick (default 25)
//!   ACTIVE_DEFAULT             "1"/"true" to boot Active (spend on); default off
//!   STARKNET_RPC               JSON-RPC endpoint (enables the refresh loop + fee lookups)
//!   ANCHOR_CONTRACT_ADDRESS    anchor contract (default: the Sepolia deployment)
//!   PLC_DIRECTORY_URL          directory/mirror base (default https://plc.directory)
//!   PLC_MIRROR_URL             /export source for the tail (default = PLC_DIRECTORY_URL)
//!   INGEST_COMMAND             ingest argv for onboarding (enables on-chain writes)
//!   ENUMERATE_INTERVAL_MS      PDS enumeration cadence (default 3600000; 0 disables)
//!   TAIL_INTERVAL_MS           /export tail cadence (default 60000; 0 disables)
//!   ENRICH_INTERVAL_MS         enrichment cadence (default 30000; 0 disables)
//!   ENRICH_BATCH / ENRICH_DELAY_MS  per-tick enrich count (default 50) / inter-request ms (200)
//!   REFRESH_INTERVAL_MS        status refresh cadence (default 300000; 0 disables)
//!   CONSOLE_ADMIN_TOKEN        operator secret; when set, writes require a login session
//!   CONSOLE_SESSION_TTL_MS     session lifetime after login (default 3600000)
//!   CONSOLE_ALLOW_OPEN_WRITES  "1"/"true" to run with writes OPEN when no admin token is set

import { SharedSecretAuth, type Authenticator } from "./auth.ts";
import { parseCriterion, type Criterion } from "./criterion.ts";
import { EnumerationService, ExportClient, TailService } from "./discover.ts";
import { EnrichmentService } from "./enrich.ts";
import { starknetFeeResolver } from "./fees.ts";
import { Onboarder, SpawnRunner, type FeeResolver } from "./onboard.ts";
import { PdsClient } from "./pds.ts";
import { RefreshService } from "./refresh.ts";
import { RosterStore } from "./roster.ts";
import { createConsoleServer, type WorkerActions } from "./server.ts";
import { DirectoryResolver, WitnessChecker } from "./witness.ts";

const SEPOLIA_ANCHOR = "0x00816c0b5bbf26d186b78f6ec0e1a8f8ae94ad58fc69595e7b0a334417e5c180";
const bool = (v: string | undefined): boolean => /^(1|true)$/i.test(v?.trim() ?? "");

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.ROSTER_DB ?? "./roster.db";
const contractAddress = process.env.ANCHOR_CONTRACT_ADDRESS ?? SEPOLIA_ANCHOR;
const directoryUrl = process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";
const mirrorUrl = process.env.PLC_MIRROR_URL ?? directoryUrl;
const pdsEndpoints = (process.env.PDS_ENDPOINTS ?? "https://eurosky.social")
  .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const importBudget = Number(process.env.IMPORT_BUDGET_PER_TICK ?? 25);

const store = RosterStore.open(dbPath);
store.setActiveDefault(bool(process.env.ACTIVE_DEFAULT));

// The criterion is required to *tail* for changes; enumeration works without it. A provided-but-
// invalid criterion fails loudly; an absent one just disables the tail.
let criterion: Criterion | null = null;
if (process.env.ROSTER_CRITERION?.trim()) {
  criterion = parseCriterion(process.env.ROSTER_CRITERION);
  console.error(`[criterion] ${criterion.label}`);
} else {
  console.error("[criterion] none set (ROSTER_CRITERION) — tail disabled; enumeration still runs");
}

const actions: WorkerActions = {};
let lastRefreshAt: number | null = null;

/** Run `fn` now and every `intervalMs` (unref'd so it never holds the process open). */
function every(intervalMs: number, fn: () => Promise<unknown>): void {
  const tick = async (): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error("[worker] loop error:", err instanceof Error ? err.message : err);
    }
  };
  void tick();
  if (intervalMs > 0) setInterval(() => void tick(), intervalMs).unref();
}

// --- Enumerate (backlog): page each PDS's listRepos → auto-approved candidates. ---
const enumerators = pdsEndpoints.map((url) => new EnumerationService(store, new PdsClient(url)));
const enumerateIntervalMs = Number(process.env.ENUMERATE_INTERVAL_MS ?? 3_600_000);
actions.enumerate = async () => {
  const results = [];
  for (const e of enumerators) results.push(await e.enumerateBacklog());
  return { endpoints: pdsEndpoints, results };
};
if (enumerators.length > 0) every(enumerateIntervalMs, actions.enumerate);

// --- Tail (ongoing): /export from ~now, criterion-filtered → auto-approved candidates. ---
const tailIntervalMs = Number(process.env.TAIL_INTERVAL_MS ?? 60_000);
if (criterion) {
  const tail = new TailService(store, new ExportClient(mirrorUrl), criterion);
  actions.tail = async () => tail.scanOnce();
  every(tailIntervalMs, actions.tail);
}

// --- Enrich: throttled identity metadata over the directory (always cheap/off-chain). ---
const enrichIntervalMs = Number(process.env.ENRICH_INTERVAL_MS ?? 30_000);
const enrichBatch = Number(process.env.ENRICH_BATCH ?? 50);
const enrichDelayMs = Number(process.env.ENRICH_DELAY_MS ?? 200);
const enricher = new EnrichmentService(store, new DirectoryResolver(directoryUrl));
actions.enrich = async () => enricher.enrichStale(enrichBatch, enrichDelayMs);
if (enrichIntervalMs > 0) every(enrichIntervalMs, actions.enrich);

// --- Refresh (read side): §4 status + the diverged alarm. Needs an RPC. ---
const rpc = process.env.STARKNET_RPC;
const refreshIntervalMs = Number(process.env.REFRESH_INTERVAL_MS ?? 300_000);
const feeResolver: FeeResolver | null = rpc ? starknetFeeResolver(rpc) : null;
if (rpc) {
  const refresher = new RefreshService(store, new WitnessChecker(rpc, contractAddress, directoryUrl));
  actions.refresh = async () => {
    const diverged = await refresher.refreshAll();
    lastRefreshAt = Date.now();
    if (diverged > 0) console.error(`[refresh] ${diverged} DID(s) DIVERGED`);
    return { diverged, lastRefreshAt };
  };
  if (refreshIntervalMs > 0) every(refreshIntervalMs, actions.refresh);
} else {
  console.error("[refresh] disabled (set STARKNET_RPC)");
}

// --- Onboard: the spend. Only when a live ingest is configured; gated on Active + budget. ---
const ingestCommand = process.env.INGEST_COMMAND?.trim();
if (ingestCommand) {
  const onboarder = new Onboarder(
    store,
    new SpawnRunner(),
    { ingestCommand: ingestCommand.split(/\s+/), source: directoryUrl, defaultBudget: importBudget },
    feeResolver,
  );
  // Onboarding runs on the refresh cadence but is a no-op unless Active (the spend gate).
  actions.onboard = async () => onboarder.onboardApproved();
  every(refreshIntervalMs, actions.onboard);
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

const server = createConsoleServer(store, {
  contractAddress,
  criterionLabel: criterion?.label,
  lastRefreshAt: () => lastRefreshAt,
  actions,
  auth,
  allowOpenWrites: openWrites,
});
server.listen(port, () =>
  console.error(
    `console listening on :${port} (anchor ${contractAddress}; ` +
      `active=${store.getActive()} budget=${store.getBudget() ?? importBudget})`,
  ),
);
