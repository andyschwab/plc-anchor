//! Onboarder — turns `approved` DIDs into `anchored` ones by driving `ingest --did --submit`.
//!
//! The console never re-implements the write path: `ingest` owns the integrity invariant (a
//! delta is anchored only if its re-encoded CID matches the directory's published CID). We just
//! shell out to it. The runner is injectable so the lifecycle wiring is testable without the
//! `live` feature, a Starknet account, or the network.
//!
//! Authorization stays the op's embedded signature (verified in-contract); the Starknet account
//! these env vars name only *pays* (REFERENCE.md §2). MVP = one project-funded account.

import { spawn } from "node:child_process";
import type { RosterStore } from "./roster.ts";

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs an external command. The real one spawns a child; tests inject a fake. */
export interface CommandRunner {
  run(argv: string[], env: NodeJS.ProcessEnv): Promise<RunResult>;
}

/** Spawns `argv[0]` with the rest as args, capturing output. */
export class SpawnRunner implements CommandRunner {
  run(argv: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => resolve({ ok: false, code: null, stdout, stderr: stderr + err.message }));
      child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    });
  }
}

export interface OnboardConfig {
  /** The ingest invocation as argv, e.g. `["cargo","run","--features","live","--bin","ingest","--"]`
   * or `["/usr/local/bin/ingest"]`. The `--did <did> --submit --source <url>` args are appended. */
  ingestCommand: string[];
  /** PLC mirror/directory base passed as `--source`. */
  source: string;
  /** Max DIDs to anchor per `onboardApproved()` call when the store has no budget override. This
   * (with the Active toggle) is the spend guardrail that replaced the per-DID approve gate. */
  defaultBudget?: number;
}

/** One machine-readable anchor line ingest emits on stdout: `ANCHORED <did> tx=<hash> [fee=<n>]`.
 * `fee` is a raw decimal felt string (STRK wei) and is optional (older ingest omits it). */
export interface AnchorLine {
  did: string;
  tx: string;
  fee: string | null;
}

const ANCHORED_RE = /^ANCHORED\s+(\S+)\s+tx=(\S+)(?:\s+fee=(\S+))?/;

/** Parse the `ANCHORED …` lines from ingest stdout (ignores everything else). */
export function parseAnchorLines(stdout: string): AnchorLine[] {
  const out: AnchorLine[] = [];
  for (const line of stdout.split("\n")) {
    const m = ANCHORED_RE.exec(line.trim());
    if (m) out.push({ did: m[1], tx: m[2], fee: m[3] ?? null });
  }
  return out;
}

/** Resolves a Starknet tx hash to its `actual_fee` (raw decimal felt string, STRK wei) — used to
 * fill in the cost when ingest emits a hash-only `ANCHORED` line. `fees.ts` provides the real
 * (RPC) one; omit it to run count-only. Returns null when the fee can't be read. */
export type FeeResolver = (txHash: string) => Promise<string | null>;

export interface OnboardResult {
  /** Whether the spend gate was on (if off, nothing was attempted). */
  active: boolean;
  /** DIDs handed to ingest this call (≤ budget). */
  attempted: number;
  /** DIDs now anchored. */
  anchored: number;
  /** The effective per-call budget. */
  budget: number;
}

export class Onboarder {
  readonly #store: RosterStore;
  readonly #runner: CommandRunner;
  readonly #config: OnboardConfig;
  readonly #feeResolver: FeeResolver | null;

  constructor(
    store: RosterStore,
    runner: CommandRunner,
    config: OnboardConfig,
    feeResolver: FeeResolver | null = null,
  ) {
    this.#store = store;
    this.#runner = runner;
    this.#config = config;
    this.#feeResolver = feeResolver;
  }

  /** Onboard a single `approved` DID. Moves it `approved → onboarding`, runs ingest, then
   * `→ anchored` on success (recording tx hash + accumulated fee from ingest's `ANCHORED` lines)
   * or `→ approved` (with the error recorded) on failure. */
  async onboard(did: string): Promise<boolean> {
    const entry = this.#store.get(did);
    if (entry === null) throw new Error(`unknown DID: ${did}`);
    if (entry.state !== "approved") throw new Error(`${did} is ${entry.state}, expected approved`);

    this.#store.transition(did, "onboarding");
    const argv = [...this.#config.ingestCommand, "--did", did, "--submit", "--source", this.#config.source];
    const result = await this.#runner.run(argv, process.env);

    if (result.ok) {
      this.#store.transition(did, "anchored");
      // Record on-chain cost from ingest's machine-readable output (degrades to count-only if the
      // ingest build predates the `ANCHORED` line). ingest emits the tx hash; the fee is resolved
      // here via the RPC fee resolver when the line omits it.
      for (const line of parseAnchorLines(result.stdout)) {
        if (line.did !== did) continue;
        let fee = line.fee;
        if (fee === null && this.#feeResolver !== null) {
          fee = await this.#feeResolver(line.tx).catch(() => null);
        }
        this.#store.setAnchorCost(did, line.tx, fee);
      }
      return true;
    }
    this.#store.transition(did, "approved");
    this.#store.setError(did, `ingest exit ${result.code ?? "?"}: ${result.stderr.trim().slice(0, 500)}`);
    return false;
  }

  /** The effective per-call budget: the store override, else the configured default, else 25. */
  budget(): number {
    return this.#store.getBudget() ?? this.#config.defaultBudget ?? 25;
  }

  /** Onboard up to the budget of currently-approved DIDs — but **only when Active** (the spend
   * gate). Inactive → a no-op (`attempted: 0`). Returns the per-call tally. */
  async onboardApproved(): Promise<OnboardResult> {
    const active = this.#store.getActive();
    const budget = this.budget();
    if (!active) return { active: false, attempted: 0, anchored: 0, budget };

    let attempted = 0;
    let anchored = 0;
    for (const entry of this.#store.list("approved")) {
      if (attempted >= budget) break;
      attempted += 1;
      if (await this.onboard(entry.did)) anchored += 1;
    }
    return { active: true, attempted, anchored, budget };
  }
}
