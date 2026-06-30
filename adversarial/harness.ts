//! Offline runner: drive `check()` over each adversarial scenario from the generated fixture.
//!
//! The fixture (`scenarios.generated.json`, built by conformance/gen-adversarial-scenarios.mjs)
//! carries real did:plc chains, the anchor's real Merkle roots + inclusion proofs, the malicious
//! mirror's served audit log, and the expected graduated status. This runner reconstructs the
//! `AnchorView` from those bytes (the proofs are verified by the witness's own `verifyProof`, so
//! a wrong root/format fails here exactly as it would on a real resolver) and the
//! `MaliciousDirectory` from the served log, then runs the real `check()`. No fakes of the
//! decision logic — only the transport (chain reads, directory fetch) is local.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProofStep } from "../witness-ts/src/merkle.ts";
import type { AuditEntry } from "../witness-ts/src/directory.ts";
import { type AnchorView, check, type CheckResult } from "../witness-ts/src/status.ts";
import { MaliciousDirectory } from "./mirror.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "scenarios.generated.json");

/** A scenario as emitted by the generator — data + prose + expectation, fully self-describing. */
export interface Scenario {
  id: string;
  title: string;
  threat: string;
  class: "read" | "write";
  /** True for the non-attack cases the alarm must stay silent on (the §0 restraint wall). */
  benign: boolean;
  setup: string[];
  anchor: {
    did: string;
    anchored: boolean;
    confirmedHead: string;
    tentativeHead: string;
    confirmedRoot: string;
    confirmedProof: { sibling: string; siblingIsLeft: boolean }[];
    tentativeRoot: string;
    tentativeProof: { sibling: string; siblingIsLeft: boolean }[];
  };
  directory: { auditLog: AuditEntry[] };
  expect: { status: string; reason: string };
  lesson: string;
}

export interface Fixture {
  now: number;
  skewHorizonMs: number;
  scenarios: Scenario[];
}

export interface ScenarioOutcome {
  scenario: Scenario;
  actual: CheckResult;
  pass: boolean;
}

const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);

const decodeProof = (steps: { sibling: string; siblingIsLeft: boolean }[]): ProofStep[] =>
  steps.map((s) => ({ sibling: hexToBytes(s.sibling), siblingIsLeft: s.siblingIsLeft }));

/** Reconstruct an `AnchorView` from a scenario's fixture bytes (proofs stay real). */
export function anchorViewFor(s: Scenario): AnchorView {
  const a = s.anchor;
  return {
    isAnchored: async () => a.anchored,
    confirmedProof: async () => ({ head: a.confirmedHead, proof: decodeProof(a.confirmedProof) }),
    tentativeProof: async () => ({ head: a.tentativeHead, proof: decodeProof(a.tentativeProof) }),
    confirmedRoot: async () => hexToBytes(a.confirmedRoot),
    tentativeRoot: async () => hexToBytes(a.tentativeRoot),
  };
}

export function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

/** Run one scenario through the real `check()` and compare to its expectation. */
export async function runScenario(s: Scenario, fixture: Fixture): Promise<ScenarioOutcome> {
  const actual = await check(s.anchor.did, anchorViewFor(s), new MaliciousDirectory(s.directory.auditLog), {
    now: () => fixture.now,
    skewHorizonMs: fixture.skewHorizonMs,
  });
  const pass = actual.status === s.expect.status && actual.reason === s.expect.reason;
  return { scenario: s, actual, pass };
}

/** Run every scenario in the fixture (read-class scenarios run offline; write-class are gated elsewhere). */
export async function runAll(fixture = loadFixture()): Promise<ScenarioOutcome[]> {
  const out: ScenarioOutcome[] = [];
  for (const s of fixture.scenarios) {
    if (s.class !== "read") continue;
    out.push(await runScenario(s, fixture));
  }
  return out;
}
