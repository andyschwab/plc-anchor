//! Binding to `@plc-anchor/witness` — the only file that reaches across to the witness package.
//!
//! Isolated so the rest of the console depends on the `StatusChecker` interface, not on witness
//! resolution (tests mock the interface; this file is loaded only at runtime). Reuses the
//! library's `check()` verbatim — the never-false-`diverged` invariant stays there, unduplicated.

import { AnchorReader, CachingAnchorView, check, DirectoryClient } from "../../witness-ts/src/index.ts";
import type { AuditEntry, IdentityResolver } from "./enrich.ts";
import type { CheckOutcome, StatusChecker } from "./refresh.ts";

/** A 32-byte root as plain hex — an opaque, comparable snapshot key for the refresher's
 * root-change gate (not felt-stripped like `starknet.ts`'s calldata encoding; leading zero bytes
 * must stay distinguishable here). */
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Wraps the witness `check(did)` for the refresher.
 *
 * `confirmedRoot`/`tentativeRoot` are contract-wide values shared by every DID in a refresh
 * cycle, so reads go through a `CachingAnchorView` that memoizes them for the cycle — `beginCycle`
 * resets it, called once per `refreshAll()` rather than once per DID (RPC cost optimization).
 * `currentRoots()` surfaces those same (cached) reads to the refresher's root-change gate. */
export class WitnessChecker implements StatusChecker {
  readonly #anchor: CachingAnchorView;
  readonly #directory: DirectoryClient;

  constructor(rpcUrl: string, contractAddress: string, directoryUrl?: string) {
    this.#anchor = new CachingAnchorView(AnchorReader.http(rpcUrl, contractAddress));
    this.#directory = new DirectoryClient(directoryUrl);
  }

  beginCycle(): void {
    this.#anchor.reset();
  }

  async currentRoots(): Promise<{ confirmedRoot: string; tentativeRoot: string }> {
    const [confirmedRoot, tentativeRoot] = await Promise.all([
      this.#anchor.confirmedRoot(),
      this.#anchor.tentativeRoot(),
    ]);
    return { confirmedRoot: toHex(confirmedRoot), tentativeRoot: toHex(tentativeRoot) };
  }

  async check(did: string): Promise<CheckOutcome> {
    const result = await check(did, this.#anchor, this.#directory);
    return {
      status: result.status,
      reason: result.reason,
      // Prefer the directory's served head; fall back to the anchor tip when the directory is
      // silent (e.g. `absent`). Never throws on a missing head.
      headCid: result.evidence.directoryHead ?? result.evidence.anchorTentativeHead ?? null,
    };
  }
}

/** Adapts the witness `DirectoryClient` to the enrichment `IdentityResolver` seam, so `enrich.ts`
 * stays witness-free (and offline-testable) while the real HTTP resolution reuses the library. */
export class DirectoryResolver implements IdentityResolver {
  readonly #directory: DirectoryClient;

  constructor(directoryUrl?: string) {
    this.#directory = new DirectoryClient(directoryUrl);
  }

  async auditLog(did: string): Promise<AuditEntry[]> {
    return this.#directory.auditLog(did);
  }
}
