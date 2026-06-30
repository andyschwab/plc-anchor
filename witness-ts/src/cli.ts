#!/usr/bin/env node
//! `witness` — check a did:plc against the on-chain anchor and print its graduated status.
//!
//! The adoption surface (Phase 5 plan §5): the one-command demonstration that the whole stack
//! resolves end-to-end. Reads the directory audit log + the anchor views, runs the §4 ladder,
//! and prints the status with its evidence. Exit code: 0 for confirmed/tentative-consistent/
//! absent, 2 for `diverged` (so it composes into monitoring).
//!
//!   node src/cli.ts <did:plc:...> [--rpc URL] [--contract ADDR] [--directory URL]
//!
//! `--rpc` defaults to $STARKNET_RPC; `--contract` to the recorded Sepolia deployment.

import { AnchorReader } from "./starknet.ts";
import { DirectoryClient } from "./directory.ts";
import { check, type CheckResult } from "./status.ts";

/** The item-5 Sepolia anchor (snfoundry.toml) — carries the proof views. */
const DEFAULT_CONTRACT = "0x00816c0b5bbf26d186b78f6ec0e1a8f8ae94ad58fc69595e7b0a334417e5c180";
const DEFAULT_DIRECTORY = "https://plc.directory";

interface Args {
  did: string;
  rpc: string;
  contract: string;
  directory: string;
}

export function parseArgs(argv: string[]): Args {
  const opts = new Map<string, string>();
  let did = "";
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      opts.set(a.slice(2), argv[i + 1] ?? "");
      i += 1;
    } else if (did === "") {
      did = a;
    }
  }
  if (!did) throw new Error("usage: witness <did:plc:...> [--rpc URL] [--contract ADDR] [--directory URL]");
  const rpc = opts.get("rpc") ?? process.env.STARKNET_RPC ?? "";
  if (!rpc) throw new Error("no RPC endpoint: pass --rpc or set STARKNET_RPC");
  return {
    did,
    rpc,
    contract: opts.get("contract") ?? DEFAULT_CONTRACT,
    directory: opts.get("directory") ?? DEFAULT_DIRECTORY,
  };
}

/** Human-readable report for a result (pure — unit-tested). */
export function formatResult(did: string, r: CheckResult): string {
  const lines = [
    `DID:    ${did}`,
    `Status: ${r.status.toUpperCase()}  (${r.reason})`,
    `  directory head:         ${r.evidence.directoryHead ?? "(none)"}`,
    `  anchor confirmed head:  ${r.evidence.anchorConfirmedHead || "(none)"}`,
    `  anchor tentative head:  ${r.evidence.anchorTentativeHead || "(none)"}`,
    `  confirmed proof valid:  ${r.evidence.confirmedProofVerified}`,
  ];
  return lines.join("\n");
}

/** Exit code by status: `diverged` is the only failure (2); everything else is 0. */
export const exitCodeFor = (status: CheckResult["status"]): number => (status === "diverged" ? 2 : 0);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const anchor = AnchorReader.http(args.rpc, args.contract);
  const directory = new DirectoryClient(args.directory);
  const result = await check(args.did, anchor, directory);
  console.log(formatResult(args.did, result));
  process.exit(exitCodeFor(result.status));
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`witness: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
