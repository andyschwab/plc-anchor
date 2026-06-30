//! A malicious PLC mirror — in two interchangeable forms backed by the same audit log.
//!
//! The witness's directory input is an interface (`witness-ts/src/status.ts` `DirectorySource`),
//! so an adversarial mirror is just something that serves an attacker-chosen audit log:
//!   - `MaliciousDirectory` — an in-process `DirectorySource`, the whole emulator for the offline
//!     runner (no network, no server).
//!   - `startMaliciousMirror` — a tiny HTTP server speaking the PLC `/{did}/log/audit` route, so
//!     the *real* `DirectoryClient` fetch transport is exercised end-to-end against a real URL.
//! Both serve the identical `AuditEntry[]` — one source of lies, two delivery modes.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/** A running malicious mirror: its base URL (for `DirectoryClient`) and a `close()`. */
export interface RunningMirror {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Stand up an HTTP server that answers `GET /{did}/log/audit` from `logsByDid`. A DID with no
 * entry returns 404 (which `DirectoryClient` reads as an empty log) — i.e. the "vanishing DID"
 * lie comes for free by simply not listing the DID. Binds an ephemeral loopback port.
 */
export function startMaliciousMirror(logsByDid: Map<string, AuditEntry[]>): Promise<RunningMirror> {
  const server: Server = createServer((req, res) => {
    const match = /^\/(.+)\/log\/audit$/.exec(req.url ?? "");
    if (req.method !== "GET" || !match) {
      res.writeHead(404).end();
      return;
    }
    const did = decodeURIComponent(match[1]);
    const log = logsByDid.get(did);
    if (!log) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "DID not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(log));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
