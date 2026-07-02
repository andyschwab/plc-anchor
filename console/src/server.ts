//! The console HTTP API — framework-free `node:http` (the repo's only other server is the
//! adversarial test mirror; this is the first production one).
//!
//! Thin CRUD over the roster + filters, plus the `diverged` alarm and `/healthz`. All write
//! effects (onboarding, status refresh) happen in the worker; this layer only mutates policy
//! state. The approve gate is enforced here: `POST /roster/dids/:did/approve` is the only path
//! from `candidate` to a state the onboarder will act on.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Authenticator } from "./auth.ts";
import type { RosterStore } from "./roster.ts";

/** The bundled single-page UI, read once at startup (sibling `ui/index.html`). */
function loadUi(): string | null {
  try {
    return readFileSync(fileURLToPath(new URL("./ui/index.html", import.meta.url)), "utf8");
  } catch {
    return null;
  }
}

/** Optional worker actions, wired by `main.ts`, exposed as manual `POST /worker/*` triggers so
 * an operator can kick a cycle without waiting for the interval. Absent actions return 503. */
export interface WorkerActions {
  enumerate?: () => Promise<unknown>;
  tail?: () => Promise<unknown>;
  enrich?: () => Promise<unknown>;
  onboard?: () => Promise<unknown>;
  refresh?: () => Promise<unknown>;
}

/** The live-settings port (implemented by `SettingsStore`); `patch` throws on invalid input. */
export interface SettingsPort {
  get(): unknown;
  patch(partial: Record<string, unknown>): unknown;
}

export interface ServerConfig {
  contractAddress: string;
  /** The current membership criterion label, surfaced in the UI/healthz. A getter (not a string)
   * because the criterion is now runtime-editable, so a cached label would go stale. */
  criterionLabel?: () => string | null;
  /** Runtime-editable settings (enables `GET/PUT /settings`). */
  settings?: SettingsPort;
  /** Boot-only / secret config surfaced read-only alongside `GET /settings` (never secret values —
   * only presence booleans and non-secret identifiers like the contract address / port). */
  locked?: () => Record<string, unknown>;
  /** Reported by `/healthz`; set by the worker after each successful refresh. */
  lastRefreshAt?: () => number | null;
  actions?: WorkerActions;
  /** When set, mutating routes (all non-GET except `/auth/login`) require a valid session. */
  auth?: Authenticator;
  /** Escape hatch: run with writes OPEN when no `auth` is configured. Default is **fail-closed**
   * — without `auth` and without this flag, mutating routes return 503, forcing a deployer to set
   * an admin secret before the console can change anything. Reads are always open. */
  allowOpenWrites?: boolean;
}

/** How mutating routes behave: `gated` = a session is required, `open` = deliberately
 * unauthenticated, `closed` = refused until an admin secret is configured (the default). */
export type WriteMode = "gated" | "open" | "closed";

function writeMode(config: ServerConfig): WriteMode {
  if (config.auth !== undefined) return "gated";
  return config.allowOpenWrites === true ? "open" : "closed";
}

interface Route {
  method: string;
  /** Path segments; `":did"` / `":id"` capture. */
  parts: string[];
  handle: (ctx: Ctx) => Promise<unknown> | unknown;
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  store: RosterStore;
  config: ServerConfig;
}

/** True for the login route, which is the one mutating route exempt from the auth gate. */
function isLoginRoute(parts: string[]): boolean {
  return parts.length === 2 && parts[0] === "auth" && parts[1] === "login";
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

/** Read one optional query param, or undefined if absent/blank. */
function qp(query: URLSearchParams, key: string): string | undefined {
  const v = query.get(key);
  return v !== null && v.length > 0 ? v : undefined;
}

function qpInt(query: URLSearchParams, key: string): number | undefined {
  const v = qp(query, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Enumerate/tail cursor progress for the dashboard, read from persisted meta. */
function cursorProgress(store: RosterStore): {
  tail: string | null;
  enumerate: { pds: string; cursor: string; done: boolean }[];
} {
  const enumerate = store.metaWithPrefix("enumerate_cursor:").map((r) => ({
    pds: r.key.slice("enumerate_cursor:".length),
    cursor: r.value,
    done: r.value === "__complete__",
  }));
  return { tail: store.getMeta("tail_cursor"), enumerate };
}

function routes(): Route[] {
  return [
    {
      method: "GET",
      parts: ["healthz"],
      handle: ({ store, config }) => ({
        ok: true,
        contractAddress: config.contractAddress,
        criterion: config.criterionLabel?.() ?? null,
        writeMode: writeMode(config),
        active: store.getActive(),
        lastRefreshAt: config.lastRefreshAt?.() ?? null,
        counts: {
          total: store.list().length,
          anchored: store.list("anchored").length,
          diverged: store.diverged().length,
        },
      }),
    },
    {
      method: "POST",
      parts: ["auth", "login"],
      handle: ({ body, config }) => {
        if (config.auth === undefined) throw new HttpError(503, "auth not configured");
        const session = config.auth.login(body);
        if (session === null) throw new HttpError(401, "invalid credentials");
        return { ok: true, ...session };
      },
    },
    {
      // Server-side paginated / filtered / sorted grid.
      method: "GET",
      parts: ["roster"],
      handle: ({ store, query }) =>
        store.query({
          state: qp(query, "state") as never,
          status: qp(query, "status") as never,
          q: qp(query, "q"),
          pdsHost: qp(query, "pdsHost"),
          offCriterion: qp(query, "offCriterion") === "1" ? true : undefined,
          sort: qp(query, "sort"),
          order: qp(query, "order") === "asc" ? "asc" : "desc",
          limit: qpInt(query, "limit"),
          offset: qpInt(query, "offset"),
        }),
    },
    {
      method: "GET",
      parts: ["roster", "aggregates"],
      handle: ({ store }) => ({
        ...store.aggregates(),
        active: store.getActive(),
        budget: store.getBudget(),
        cursors: cursorProgress(store),
        workers: store.workerStatuses(),
      }),
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
      // Kept for explicit/manual curation; the criterion path auto-approves, so the UI no longer
      // calls this in the Eurosky deployment.
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
      // Read the spend toggle + budget.
      method: "GET",
      parts: ["settings", "active"],
      handle: ({ store }) => ({ active: store.getActive(), budget: store.getBudget() }),
    },
    {
      // Set the spend toggle; optionally the per-tick budget in the same call.
      method: "POST",
      parts: ["settings", "active"],
      handle: ({ store, body }) => {
        if (body === null || typeof body !== "object") throw new HttpError(400, "expected an object body");
        const b = body as Record<string, unknown>;
        if (typeof b.active !== "boolean") throw new HttpError(400, "missing boolean field: active");
        store.setActive(b.active);
        if ("budget" in b) {
          if (b.budget === null) store.setBudget(null);
          else if (typeof b.budget === "number" && Number.isInteger(b.budget) && b.budget >= 0) {
            store.setBudget(b.budget);
          } else throw new HttpError(400, "budget must be a non-negative integer or null");
        }
        return { active: store.getActive(), budget: store.getBudget() };
      },
    },
    {
      // Full live settings + a read-only snapshot of the boot-only / secret config.
      method: "GET",
      parts: ["settings"],
      handle: ({ config }) => {
        if (config.settings === undefined) throw new HttpError(503, "settings not configured");
        return { settings: config.settings.get(), locked: config.locked?.() ?? {} };
      },
    },
    {
      // Patch live settings (validated in the store; bad input → 400). Auth-gated like all writes.
      method: "PUT",
      parts: ["settings"],
      handle: ({ config, body }) => {
        if (config.settings === undefined) throw new HttpError(503, "settings not configured");
        if (body === null || typeof body !== "object") throw new HttpError(400, "expected an object body");
        try {
          return { settings: config.settings.patch(body as Record<string, unknown>) };
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : "invalid settings");
        }
      },
    },
    { method: "POST", parts: ["worker", "enumerate"], handle: ({ config }) => runAction(config, "enumerate") },
    { method: "POST", parts: ["worker", "tail"], handle: ({ config }) => runAction(config, "tail") },
    { method: "POST", parts: ["worker", "enrich"], handle: ({ config }) => runAction(config, "enrich") },
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
  const ui = loadUi();
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const parts = segments(url.pathname);
        const method = req.method ?? "GET";
        if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          if (ui === null) {
            send(res, 404, { error: "UI not bundled" });
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(ui);
          return;
        }
        for (const route of table) {
          if (route.method !== method) continue;
          const params = match(route, parts);
          if (params === null) continue;
          // Gate mutating routes; login is exempt and reads (GET) stay open. Fail-closed: with no
          // `auth` configured, writes are refused (503) unless `allowOpenWrites` is set.
          if (method !== "GET" && !isLoginRoute(parts)) {
            const mode = writeMode(config);
            if (mode === "closed") {
              send(res, 503, { error: "writes disabled: set CONSOLE_ADMIN_TOKEN" });
              return;
            }
            if (mode === "gated" && !config.auth!.verify(req)) {
              send(res, 401, { error: "unauthorized" });
              return;
            }
          }
          const body = method === "POST" || method === "PUT" ? await readBody(req) : null;
          const result = await route.handle({ params, query: url.searchParams, body, store, config });
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
