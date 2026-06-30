//! Console entry point — wires the store, the HTTP API, and the worker loops (discover →
//! refresh, plus onboarding when a live ingest is configured).
//!
//! Run: `node --experimental-sqlite src/main.ts`. Each loop is independent and degrades to a
//! no-op when its config is absent, so the API is useful even before a live anchor/account is
//! wired (roster curation first, writes later).
//!
//! Env:
//!   PORT                       HTTP port (default 8787)
//!   ROSTER_DB                  SQLite path (default ./roster.db; ":memory:" for ephemeral)
//!   STARKNET_RPC               JSON-RPC endpoint (enables the refresh loop)
//!   ANCHOR_CONTRACT_ADDRESS    anchor contract (default: the Sepolia deployment)
//!   PLC_DIRECTORY_URL          directory/mirror base (default https://plc.directory)
//!   PLC_MIRROR_URL             /export source for discovery (default = PLC_DIRECTORY_URL)
//!   REFRESH_INTERVAL_MS        status refresh cadence (default 300000; 0 disables)
//!   DISCOVER_INTERVAL_MS       filter discover-scan cadence (default 0 = disabled)
//!   INGEST_COMMAND             ingest argv for onboarding (e.g. "ingest" or
//!                              "cargo run --features live --bin ingest --"); enables onboarding

import { DiscoverService, ExportClient } from "./discover.ts";
import { Onboarder, SpawnRunner } from "./onboard.ts";
import { RefreshService } from "./refresh.ts";
import { RosterStore } from "./roster.ts";
import { createConsoleServer, type WorkerActions } from "./server.ts";
import { WitnessChecker } from "./witness.ts";

const SEPOLIA_ANCHOR = "0x00816c0b5bbf26d186b78f6ec0e1a8f8ae94ad58fc69595e7b0a334417e5c180";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.ROSTER_DB ?? "./roster.db";
const contractAddress = process.env.ANCHOR_CONTRACT_ADDRESS ?? SEPOLIA_ANCHOR;
const directoryUrl = process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";
const mirrorUrl = process.env.PLC_MIRROR_URL ?? directoryUrl;

const store = RosterStore.open(dbPath);
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

// --- Refresh loop (read side): needs an RPC. ---------------------------------
const rpc = process.env.STARKNET_RPC;
const refreshIntervalMs = Number(process.env.REFRESH_INTERVAL_MS ?? 300_000);
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

// --- Discover loop: needs at least one enabled pds_host filter to do anything. ---
const discoverIntervalMs = Number(process.env.DISCOVER_INTERVAL_MS ?? 0);
const discover = new DiscoverService(store, new ExportClient(mirrorUrl));
actions.discover = async () => store.listFilters(true).length > 0
  ? await discover.scanOnce()
  : { scanned: 0, matched: 0, note: "no enabled filters" };
if (discoverIntervalMs > 0) every(discoverIntervalMs, actions.discover);

// --- Onboard: only when a live ingest is configured. -------------------------
const ingestCommand = process.env.INGEST_COMMAND?.trim();
if (ingestCommand) {
  const onboarder = new Onboarder(store, new SpawnRunner(), {
    ingestCommand: ingestCommand.split(/\s+/),
    source: directoryUrl,
  });
  actions.onboard = async () => ({ anchored: await onboarder.onboardApproved() });
} else {
  console.error("[onboard] disabled (set INGEST_COMMAND to enable on-chain writes)");
}

const server = createConsoleServer(store, { contractAddress, lastRefreshAt: () => lastRefreshAt, actions });
server.listen(port, () => console.error(`console listening on :${port} (anchor ${contractAddress})`));
