//! PDS-host extraction — the one net-new building block of the console.
//!
//! Nothing in the repo parses a DID's service endpoint today (ingest/witness work only with
//! DID + CID + opaque op JSON). The `pds_host` filter needs it, so it lives here as a pure
//! function over the op JSON the directory already serves (audit-log `operation`, or `/export`
//! entries). No consensus weight — this only *selects* which DIDs to anchor; correctness of the
//! anchored bytes stays with ingest's integrity invariant.
//!
//! Two op shapes carry the PDS endpoint:
//!   - modern `plc_operation`: `services.atproto_pds.endpoint` (a URL string);
//!   - legacy `create`:        `service` (a flat URL string).
//! A resolved DID *document* (from `GET /{did}`) uses a third shape; `pdsHostFromDidDoc` covers
//! it for the evaluate path. All three reduce to "take a URL, return its host".

/** The host (`host:port` if non-default) of a URL string, or `null` if it doesn't parse. */
export function hostOf(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Extract the atproto PDS host from a PLC operation (modern or legacy `create`). */
export function pdsHostFromOp(op: unknown): string | null {
  if (op === null || typeof op !== "object") return null;
  const o = op as Record<string, unknown>;

  // Modern plc_operation: services map keyed by service id.
  const services = o.services;
  if (services !== null && typeof services === "object") {
    const pds = (services as Record<string, unknown>).atproto_pds;
    if (pds !== null && typeof pds === "object") {
      const host = hostOf((pds as Record<string, unknown>).endpoint);
      if (host !== null) return host;
    }
  }

  // Legacy `create`: flat `service` URL string.
  return hostOf(o.service);
}

/** Extract the atproto PDS host from a resolved DID document's `service` array. */
export function pdsHostFromDidDoc(doc: unknown): string | null {
  if (doc === null || typeof doc !== "object") return null;
  const service = (doc as Record<string, unknown>).service;
  if (!Array.isArray(service)) return null;
  for (const entry of service) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    // Match by the conventional atproto PDS id/type; fall back to any serviceEndpoint.
    const id = typeof e.id === "string" ? e.id : "";
    const type = typeof e.type === "string" ? e.type : "";
    if (id.endsWith("atproto_pds") || type === "AtprotoPersonalDataServer") {
      const host = hostOf(e.serviceEndpoint);
      if (host !== null) return host;
    }
  }
  return null;
}

/** Whether an op's PDS host matches `host` (exact, case-insensitive). */
export function opMatchesPdsHost(op: unknown, host: string): boolean {
  const found = pdsHostFromOp(op);
  return found !== null && found.toLowerCase() === host.toLowerCase();
}
