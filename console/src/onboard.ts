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
}

export class Onboarder {
  readonly #store: RosterStore;
  readonly #runner: CommandRunner;
  readonly #config: OnboardConfig;

  constructor(store: RosterStore, runner: CommandRunner, config: OnboardConfig) {
    this.#store = store;
    this.#runner = runner;
    this.#config = config;
  }

  /** Onboard a single `approved` DID. Moves it `approved → onboarding`, runs ingest, then
   * `→ anchored` on success or `→ approved` (with the error recorded) on failure. */
  async onboard(did: string): Promise<boolean> {
    const entry = this.#store.get(did);
    if (entry === null) throw new Error(`unknown DID: ${did}`);
    if (entry.state !== "approved") throw new Error(`${did} is ${entry.state}, expected approved`);

    this.#store.transition(did, "onboarding");
    const argv = [...this.#config.ingestCommand, "--did", did, "--submit", "--source", this.#config.source];
    const result = await this.#runner.run(argv, process.env);

    if (result.ok) {
      this.#store.transition(did, "anchored");
      return true;
    }
    this.#store.transition(did, "approved");
    this.#store.setError(did, `ingest exit ${result.code ?? "?"}: ${result.stderr.trim().slice(0, 500)}`);
    return false;
  }

  /** Onboard every currently-approved DID. Returns the count successfully anchored. */
  async onboardApproved(): Promise<number> {
    let anchored = 0;
    for (const entry of this.#store.list("approved")) {
      if (await this.onboard(entry.did)) anchored += 1;
    }
    return anchored;
  }
}
