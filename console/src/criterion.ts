//! Roster criterion — the single, deploy-time membership rule for the criterion-driven console.
//!
//! The Eurosky MVP narrows the roster to one fixed rule set at boot from `ROSTER_CRITERION` env,
//! *not* the old user-editable `pds_host` filters (which only ever did an exact-host compare). The
//! one supported form today is `pds_domain:<base>` — a **domain-suffix** match over a DID's PDS
//! host, so `eurosky.social` also captures `*.eurosky.social` subdomains. Like `pdshost.ts`, this
//! only *selects* which DIDs to anchor; it carries no consensus weight (ingest's integrity
//! invariant still guards every anchored byte).

import { pdsHostFromDidDoc, pdsHostFromOp } from "./pdshost.ts";

/** A parsed, immutable membership predicate over a DID's PDS host. */
export interface Criterion {
  /** The rule kind. Only `pds_domain` exists today. */
  readonly kind: "pds_domain";
  /** The matched base domain, normalized to lower-case. */
  readonly base: string;
  /** Human-readable label for the UI (e.g. `PDS = eurosky.social`). */
  readonly label: string;
  /** Whether a raw PDS host satisfies the criterion (domain-suffix, case-insensitive). */
  matchesHost(host: string | null | undefined): boolean;
  /** Whether a PLC operation's PDS host satisfies the criterion. */
  matchesOp(op: unknown): boolean;
  /** Whether a resolved DID document's PDS host satisfies the criterion. */
  matchesDidDoc(doc: unknown): boolean;
}

/** Domain-suffix match: `host === base` or `host` ends in `.base` (both lower-cased). Strips a
 * `host:port` down to the host before comparing, and ignores a leading `.` in `base`. */
function suffixMatch(base: string, host: string | null | undefined): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  const h = host.toLowerCase().split(":")[0];
  const b = base.toLowerCase().replace(/^\.+/, "");
  return h === b || h.endsWith("." + b);
}

/** Parse a `ROSTER_CRITERION` spec into a predicate. Throws on an empty or unknown spec so a
 * misconfigured deployment fails loudly rather than silently matching nothing. */
export function parseCriterion(spec: string | undefined | null): Criterion {
  const raw = (spec ?? "").trim();
  if (raw.length === 0) throw new Error("ROSTER_CRITERION is required (e.g. pds_domain:eurosky.social)");

  const sep = raw.indexOf(":");
  const kind = (sep >= 0 ? raw.slice(0, sep) : raw).trim().toLowerCase();
  const value = (sep >= 0 ? raw.slice(sep + 1) : "").trim();

  if (kind !== "pds_domain") {
    throw new Error(`unsupported ROSTER_CRITERION kind '${kind}' (only 'pds_domain' is supported)`);
  }
  const base = value.toLowerCase().replace(/^\.+/, "");
  if (base.length === 0) throw new Error("pds_domain criterion needs a base domain, e.g. pds_domain:eurosky.social");

  return {
    kind: "pds_domain",
    base,
    label: `PDS = ${base}`,
    matchesHost: (host) => suffixMatch(base, host),
    matchesOp: (op) => suffixMatch(base, pdsHostFromOp(op)),
    matchesDidDoc: (doc) => suffixMatch(base, pdsHostFromDidDoc(doc)),
  };
}
