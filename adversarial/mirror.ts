//! A malicious PLC mirror, as a `DirectorySource`.
//!
//! The witness's directory input is an interface (`witness-ts/src/status.ts` `DirectorySource`),
//! so an adversarial mirror is just an implementation that serves an attacker-chosen audit log.
//! This is the whole emulator for the offline runner — no network, no server. The live runner
//! (later) wraps the same fixed log in a tiny HTTP server so the real `DirectoryClient` fetch
//! transport is exercised against a real URL; the served bytes are identical.

import type { AuditEntry } from "../witness-ts/src/directory.ts";
import type { DirectorySource } from "../witness-ts/src/status.ts";

/** Serves a fixed, attacker-controlled audit log — whatever the scenario says the mirror lies with. */
export class MaliciousDirectory implements DirectorySource {
  readonly #log: AuditEntry[];

  constructor(log: AuditEntry[]) {
    this.#log = log;
  }

  async auditLog(_did: string): Promise<AuditEntry[]> {
    return this.#log;
  }
}
