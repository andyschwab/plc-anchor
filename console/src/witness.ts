//! Binding to `@plc-anchor/witness` — the only file that reaches across to the witness package.
//!
//! Isolated so the rest of the console depends on the `StatusChecker` interface, not on witness
//! resolution (tests mock the interface; this file is loaded only at runtime). Reuses the
//! library's `check()` verbatim — the never-false-`diverged` invariant stays there, unduplicated.

import { AnchorReader, check, DirectoryClient } from "../../witness-ts/src/index.ts";
import type { AuditEntry, IdentityResolver } from "./enrich.ts";
import type { CheckOutcome, StatusChecker } from "./refresh.ts";

/** Wraps the witness `check(did)` for the refresher. */
export class WitnessChecker implements StatusChecker {
  readonly #anchor: AnchorReader;
  readonly #directory: DirectoryClient;

  constructor(rpcUrl: string, contractAddress: string, directoryUrl?: string) {
    this.#anchor = AnchorReader.http(rpcUrl, contractAddress);
    this.#directory = new DirectoryClient(directoryUrl);
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
