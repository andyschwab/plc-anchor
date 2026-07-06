//! Offline runner: drive `check()` over each adversarial scenario from the generated fixture.
//!
//! The fixture (`scenarios.generated.json`, built by conformance/gen-adversarial-scenarios.mjs)
//! carries real did:plc chains, the anchor's re-derived confirmed/tentative heads (verify-on-read:
//! no on-chain commitment), the malicious mirror's served audit log, and the expected graduated
//! status. This runner reconstructs the `AnchorView` from those bytes and the `MaliciousDirectory`
//! from the served log, then runs the real `check()`. No fakes of the decision logic — only the
//! transport (anchor chain reads, directory fetch) is local.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { directoryHead, type AuditEntry, type LiveChain } from "../witness-ts/src/directory.ts";
import { type AnchorView, check, type CheckResult } from "../witness-ts/src/status.ts";
import { MaliciousDirectory } from "./mirror.ts";

// The scenario fixtures encode nullification via each entry's `nullified` label (the mirror's
// served claim) rather than full signed recovery chains, so this suite drives the status ladder
// with a flag-based live derivation. The witness's crypto re-derivation of `nullified` is covered
// directly in witness-ts/test/nullified.test.ts.
const flagLive = (log: readonly AuditEntry[]): LiveChain => ({
  liveCids: new Set(log.filter((e) => !e.nullified).map((e) => e.cid)),
  head: directoryHead(log),
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "scenarios.generated.json");

/** Anchor reads for a read-class scenario. Verify-on-read: the witness re-derives the confirmed
 * head from the on-chain op log, so a scenario supplies the derived heads directly (the fixture's
 * legacy `confirmedRoot`/`*Proof` fields, from the pre-rearchitecture Merkle model, are ignored). */
export interface ScenarioAnchor {
  did: string;
  anchored: boolean;
  confirmedHead: string;
  tentativeHead: string;
}

/** The defender's verdict on a write-class adversarial submission. */
export interface WriteVerdict {
  rejected: boolean;
  /** The contract / gate's rejection reason string (e.g. `recovery-weaker-key`). */
  reason: string;
  /** Which module enforces it (in-contract verify/recovery, or the off-chain ingest gate). */
  defender: string;
  /** How this rejection was ground-truthed at fixture-generation time. */
  provenance: string;
}

/**
 * A scenario as emitted by the generator — data + prose + expectation, fully self-describing.
 *
 * `read` scenarios drive the witness `check()` (anchor + directory present, `expect` a status).
 * `write` scenarios are malicious submissions the contract/ingest gate rejects (`proposed` +
 * `verdict`), ground-truthed at generation time against @did-plc/lib.
 */
export interface Scenario {
  id: string;
  title: string;
  threat: string;
  class: "read" | "write";
  setup: string[];
  lesson: string;
  /** read-class only. True for the non-attack cases the alarm must stay silent on (the §0 wall). */
  benign?: boolean;
  /** read-class only. */
  anchor?: ScenarioAnchor;
  /** read-class only. */
  directory?: { auditLog: AuditEntry[] };
  /** read-class only. */
  expect?: { status: string; reason: string };
  /** write-class only: what the attacker submits. */
  proposed?: string[];
  /** write-class only: the rejection. */
  verdict?: WriteVerdict;
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

/** Reconstruct an `AnchorView` from a read-class scenario: anchored + an empty raw chain (the
 * confirmed/tentative heads are injected via `deriveAnchor` in `runScenario`). */
export function anchorViewFor(a: ScenarioAnchor): AnchorView {
  return {
    isAnchored: async () => a.anchored,
    chain: async () => [],
  };
}

export function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

/** Run one read-class scenario through the real `check()` and compare to its expectation. */
export async function runScenario(s: Scenario, fixture: Fixture): Promise<ScenarioOutcome> {
  if (!s.anchor || !s.directory || !s.expect) {
    throw new Error(`runScenario: ${s.id} is not a read-class scenario`);
  }
  const anchor = s.anchor;
  const actual = await check(anchor.did, anchorViewFor(anchor), new MaliciousDirectory(s.directory.auditLog), {
    now: () => fixture.now,
    skewHorizonMs: fixture.skewHorizonMs,
    deriveLive: flagLive,
    deriveAnchor: () => ({ confirmedHead: anchor.confirmedHead, tentativeHead: anchor.tentativeHead }),
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
