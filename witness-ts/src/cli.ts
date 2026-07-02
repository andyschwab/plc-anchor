#!/usr/bin/env node
//! `witness` — check a did:plc against the on-chain anchor and print its graduated status.
//!
//! The adoption surface (Phase 5 plan §5): the one-command demonstration that the whole stack
//! resolves end-to-end. Reads the directory audit log + the anchor views, runs the §4 ladder,
//! and prints the status with its evidence. Exit code: 0 for confirmed/tentative-consistent/
//! absent, 2 for `diverged`, 1 for `error` (an unverifiable input — so it composes into
//! monitoring, distinguishing "contradicted" from "couldn't be checked").
//!
//!   node src/cli.ts <did:plc:...> [--rpc URL] [--contract ADDR] [--directory URL]
//!
//! `--rpc` defaults to $STARKNET_RPC; `--contract` to $ANCHOR_CONTRACT_ADDRESS, else the
//! recorded Sepolia deployment. Reading a **mainnet** DID REQUIRES an explicit mainnet contract
//! (flag or env) — the Sepolia default reads the wrong network and would mis-report.

import { AnchorReader } from "./starknet.ts";
import { DirectoryClient } from "./directory.ts";
import { check, type CheckResult } from "./status.ts";

/** The Sepolia anchor (post-4a; `deployments/sepolia.json`) — carries the proof views. Used
 * only when neither --contract nor $ANCHOR_CONTRACT_ADDRESS is given (a testnet/dev default;
 * mainnet callers must pass the mainnet address explicitly). */
const DEFAULT_CONTRACT = "0x01e3cd42e8481a40b366ef32940e8bc050fd79c924c9b838a6dc0338a08fc5c3";
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
    contract: opts.get("contract") ?? process.env.ANCHOR_CONTRACT_ADDRESS ?? DEFAULT_CONTRACT,
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

/** Exit code by status: `diverged` → 2 (contradicted), `error` → 1 (unverifiable input),
 * everything else → 0. */
export const exitCodeFor = (status: CheckResult["status"]): number =>
  status === "diverged" ? 2 : status === "error" ? 1 : 0;

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
