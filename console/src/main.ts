//! Console entry point — wires the store, the HTTP API, and the periodic status refresh.
//!
//! Run: `node --experimental-sqlite src/main.ts` (env below). The onboarder (ingest subprocess)
//! and the filter discover-scan land in the next build phase; this serves the API and keeps the
//! §4 graduated status fresh for anchored DIDs.
//!
//! Env:
//!   PORT                     HTTP port (default 8787)
//!   ROSTER_DB                SQLite path (default ./roster.db; ":memory:" for ephemeral)
//!   STARKNET_RPC             JSON-RPC endpoint (required for the refresh loop)
//!   ANCHOR_CONTRACT_ADDRESS  anchor contract (default: the Sepolia deployment)
//!   PLC_DIRECTORY_URL        directory/mirror base (default https://plc.directory)
//!   REFRESH_INTERVAL_MS      status refresh cadence (default 300000; 0 disables)

import { RefreshService } from "./refresh.ts";
import { RosterStore } from "./roster.ts";
import { createConsoleServer } from "./server.ts";
import { WitnessChecker } from "./witness.ts";

const SEPOLIA_ANCHOR = "0x00816c0b5bbf26d186b78f6ec0e1a8f8ae94ad58fc69595e7b0a334417e5c180";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required env: ${name}`);
  return v;
}

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.ROSTER_DB ?? "./roster.db";
const contractAddress = env("ANCHOR_CONTRACT_ADDRESS", SEPOLIA_ANCHOR);
const refreshIntervalMs = Number(process.env.REFRESH_INTERVAL_MS ?? 300_000);

const store = RosterStore.open(dbPath);

let lastRefreshAt: number | null = null;
const server = createConsoleServer(store, { contractAddress, lastRefreshAt: () => lastRefreshAt });

// The refresh loop runs only when an RPC is configured (the read side needs it). Without one the
// API still serves policy state — useful for roster curation before a live anchor is wired.
const rpc = process.env.STARKNET_RPC;
if (rpc && refreshIntervalMs > 0) {
  const refresher = new RefreshService(
    store,
    new WitnessChecker(rpc, contractAddress, process.env.PLC_DIRECTORY_URL),
  );
  const tick = async (): Promise<void> => {
    try {
      const diverged = await refresher.refreshAll();
      lastRefreshAt = Date.now();
      if (diverged > 0) console.error(`[refresh] ${diverged} DID(s) DIVERGED`);
    } catch (err) {
      console.error("[refresh] loop error:", err instanceof Error ? err.message : err);
    }
  };
  void tick();
  setInterval(() => void tick(), refreshIntervalMs).unref();
} else {
  console.error("[refresh] disabled (set STARKNET_RPC and REFRESH_INTERVAL_MS>0 to enable)");
}

server.listen(port, () => console.error(`console listening on :${port} (anchor ${contractAddress})`));
