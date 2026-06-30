//! The console HTTP API — framework-free `node:http` (the repo's only other server is the
//! adversarial test mirror; this is the first production one).
//!
//! Thin CRUD over the roster + filters, plus the `diverged` alarm and `/healthz`. All write
//! effects (onboarding, status refresh) happen in the worker; this layer only mutates policy
//! state. The approve gate is enforced here: `POST /roster/dids/:did/approve` is the only path
//! from `candidate` to a state the onboarder will act on.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RosterStore } from "./roster.ts";

/** Optional worker actions, wired by `main.ts`, exposed as manual `POST /worker/*` triggers so
 * an operator can kick a cycle without waiting for the interval. Absent actions return 503. */
export interface WorkerActions {
  discover?: () => Promise<unknown>;
  onboard?: () => Promise<unknown>;
  refresh?: () => Promise<unknown>;
}

export interface ServerConfig {
  contractAddress: string;
  /** Reported by `/healthz`; set by the worker after each successful refresh. */
  lastRefreshAt?: () => number | null;
  actions?: WorkerActions;
}

interface Route {
  method: string;
  /** Path segments; `":did"` / `":id"` capture. */
  parts: string[];
  handle: (ctx: Ctx) => Promise<unknown> | unknown;
}

interface Ctx {
  params: Record<string, string>;
  body: unknown;
  store: RosterStore;
  config: ServerConfig;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function segments(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
}

function match(route: Route, parts: string[]): Record<string, string> | null {
  if (route.parts.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 1) {
    const r = route.parts[i];
    if (r.startsWith(":")) params[r.slice(1)] = parts[i];
    else if (r !== parts[i]) return null;
  }
  return params;
}

function requireDid(params: Record<string, string>): string {
  const did = params.did;
  if (!did || !did.startsWith("did:")) throw new HttpError(400, "invalid did");
  return did;
}

function bodyField(body: unknown, key: string): string {
  if (body === null || typeof body !== "object" || typeof (body as Record<string, unknown>)[key] !== "string") {
    throw new HttpError(400, `missing string field: ${key}`);
  }
  return (body as Record<string, string>)[key];
}

function routes(): Route[] {
  return [
    {
      method: "GET",
      parts: ["healthz"],
      handle: ({ store, config }) => ({
        ok: true,
        contractAddress: config.contractAddress,
        lastRefreshAt: config.lastRefreshAt?.() ?? null,
        counts: {
          total: store.list().length,
          anchored: store.list("anchored").length,
          diverged: store.diverged().length,
        },
      }),
    },
    {
      method: "GET",
      parts: ["roster"],
      handle: ({ store }) => store.list(),
    },
    {
      method: "GET",
      parts: ["roster", "diverged"],
      handle: ({ store }) => store.diverged(),
    },
    {
      method: "POST",
      parts: ["roster", "dids"],
      handle: ({ store, body }) => store.upsertCandidate(bodyField(body, "did"), "explicit"),
    },
    {
      method: "GET",
      parts: ["roster", "dids", ":did"],
      handle: ({ store, params }) => {
        const entry = store.get(requireDid(params));
        if (entry === null) throw new HttpError(404, "not found");
        return entry;
      },
    },
    {
      method: "POST",
      parts: ["roster", "dids", ":did", "approve"],
      handle: ({ store, params }) => store.transition(requireDid(params), "approved"),
    },
    {
      method: "DELETE",
      parts: ["roster", "dids", ":did"],
      handle: ({ store, params }) => store.transition(requireDid(params), "removed"),
    },
    {
      method: "GET",
      parts: ["roster", "filters"],
      handle: ({ store }) => store.listFilters(),
    },
    {
      method: "POST",
      parts: ["roster", "filters"],
      handle: ({ store, body }) => store.addFilter("pds_host", bodyField(body, "value")),
    },
    {
      method: "DELETE",
      parts: ["roster", "filters", ":id"],
      handle: ({ store, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) throw new HttpError(400, "invalid filter id");
        store.removeFilter(id);
        return { ok: true };
      },
    },
    { method: "POST", parts: ["worker", "discover"], handle: ({ config }) => runAction(config, "discover") },
    { method: "POST", parts: ["worker", "onboard"], handle: ({ config }) => runAction(config, "onboard") },
    { method: "POST", parts: ["worker", "refresh"], handle: ({ config }) => runAction(config, "refresh") },
  ];
}

function runAction(config: ServerConfig, name: keyof NonNullable<ServerConfig["actions"]>): Promise<unknown> {
  const action = config.actions?.[name];
  if (action === undefined) throw new HttpError(503, `worker action '${name}' not configured`);
  return Promise.resolve(action());
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

/** Build (but do not listen on) the console HTTP server. */
export function createConsoleServer(store: RosterStore, config: ServerConfig): Server {
  const table = routes();
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const parts = segments(url.pathname);
        const method = req.method ?? "GET";
        for (const route of table) {
          if (route.method !== method) continue;
          const params = match(route, parts);
          if (params === null) continue;
          const body = method === "POST" || method === "PUT" ? await readBody(req) : null;
          const result = await route.handle({ params, body, store, config });
          send(res, 200, result);
          return;
        }
        send(res, 404, { error: "no such route" });
      } catch (err) {
        if (err instanceof HttpError) send(res, err.status, { error: err.message });
        else if (err instanceof Error) send(res, 400, { error: err.message });
        else send(res, 500, { error: "internal error" });
      }
    })();
  });
}
