# `console/` — Layer-2 admin console (build item 6)

The off-chain admin/user tool from `REFERENCE.md` §6: define **which** `did:plc`s we anchor
(membership is off-chain policy — §2, so the contract has no roster getter and this owns it),
watch their **state**, and surface the **`diverged` alarm**. It is **glue, not consensus** — it
composes the already-differential-green pieces and re-implements none of them (CLAUDE.md
guardrail):

- reads status via **`@plc-anchor/witness`** (`check()` → the §4 graduated status);
- writes via **`ingest --did/--roster --submit`** (the integrity invariant stays in ingest);
- the only net-new logic *selects* DIDs — the PDS-host parser (`src/pdshost.ts`) and the
  membership `criterion` (`src/criterion.ts`) — and carries no consensus weight.

## The "Eurosky MVP" shape

This deployment narrows the roster to **one fixed, deploy-time criterion** — accounts hosted on
the `eurosky.social` PDS (~20k) — and is built to be *operable and cost-safe at that scale*. The
per-DID human approve gate does not scale to 20k, so it is replaced by an **Active/Inactive
toggle + a per-tick import budget**: matched DIDs auto-queue, and the operator controls the
on-chain spend with one switch and a cap.

- **Criterion** = `ROSTER_CRITERION=pds_domain:eurosky.social` — a **domain-suffix** match
  (`eurosky.social` and any `*.eurosky.social`). Deploy-time config, not user-editable.
- **Discovery = enumerate then tail.** *Enumerate* pages the PDS's `com.atproto.sync.listRepos`
  to seed the backlog (cheap and complete — `plc.directory` has no "list DIDs on PDS X" API).
  *Tail* polls `/export` from ~now for identity changes matching the criterion.
- **Enrichment** attaches PLC-derivable context (handle, PDS host, rotation-key count, last-op
  time, tombstoned) so 20k bare DIDs are legible. Throttled + cached; display-only.
- **Cost readout**: anchored/pending counts, cumulative + average on-chain fee, so you measure a
  small batch and extrapolate before scaling.

## Roster lifecycle

```
candidate ──auto-approve──▶ approved ──▶ onboarding ──▶ anchored{confirmed|tentative-consistent|diverged|absent}
   ▲  │ (criterion match / explicit add)   │ (ingest --submit, only when Active + within budget)   │ (witness check)
   │  └──────────────── removed ◀──────────┴───────────────────────────────────────────────────────┘
   └── revive
```

Discovery **auto-advances** a matched `candidate` to `approved` (the manual approve endpoint stays
but the criterion UI doesn't use it). The **spend guardrail** is now the onboarder: it processes
`approved` DIDs **only when Active**, up to the per-tick budget. `anchored` still means "present
on-chain" however it got there. Transitions are validated (`ALLOWED_TRANSITIONS`).

## Layout

- `src/types.ts` — roster/settings/query shapes + the lifecycle states.
- `src/roster.ts` — the SQLite store (`node:sqlite`, zero deps) + the validated state machine +
  the paginated `query`/`aggregates` + persisted settings (Active toggle, budget, cursors).
- `src/criterion.ts` — **net-new** membership criterion (`pds_domain:` domain-suffix match).
- `src/pdshost.ts` — **net-new** PDS-host extraction (modern `plc_operation`, legacy `create`,
  resolved DID-doc).
- `src/pds.ts` — PDS `listRepos` transport (enumeration backlog).
- `src/discover.ts` — the two discovery workers: `EnumerationService` (listRepos → auto-approve)
  and `TailService` (`/export` from ~now, criterion-filtered → auto-approve).
- `src/enrich.ts` — identity enrichment (`identityFromLog` + a throttled/cached worker) over an
  injectable resolver.
- `src/onboard.ts` — drives `ingest --did --submit`; gated on **Active** + **budget**; captures
  the tx hash + fee from ingest's `ANCHORED` line.
- `src/fees.ts` — resolves a tx's `actual_fee` via `starknet_getTransactionReceipt`.
- `src/refresh.ts` — status refresher over an injectable `StatusChecker`.
- `src/witness.ts` — the bindings to `@plc-anchor/witness` (`WitnessChecker`, `DirectoryResolver`;
  isolated, loaded only at runtime).
- `src/server.ts` — framework-free `node:http` API.
- `src/main.ts` — entry point: API + the enumerate/tail/enrich/onboard/refresh worker loops.

## API

| Method | Path | Does |
|---|---|---|
| GET | `/healthz` | liveness, contract, `criterion`, `writeMode`, `active`, counts |
| POST | `/auth/login` | exchange `{secret}` for a short-lived session `{token, expiresAt}` |
| GET | `/roster` | **paginated/filtered/sorted** grid → `{rows, total}` (see below) |
| GET | `/roster/aggregates` | counts by state+status, backlog, anchored, fee total/avg, active, cursors |
| GET | `/roster/diverged` | the alarm list |
| POST | `/roster/dids` | add an explicit DID (`{did}`) → `candidate` |
| GET | `/roster/dids/:did` | one entry |
| POST | `/roster/dids/:did/approve` | `candidate → approved` (manual; unused by the criterion UI) |
| DELETE | `/roster/dids/:did` | → `removed` |
| GET/POST | `/settings/active` | read / set the Active toggle (`{active, budget?}`) |
| POST | `/worker/{enumerate,tail,enrich,onboard,refresh}` | kick a worker cycle now |

`GET /roster` query params: `state`, `status`, `q` (substring over DID + handle), `pdsHost`,
`sort` (a column alias), `order` (`asc`/`desc`), `limit` (≤1000), `offset`. All loops run on
timers; **onboarding is a no-op unless Active** (the spend gate), independent of its cadence.

## Cost tracking

ingest emits a machine-readable `ANCHORED <did> tx=<hash>` line on stdout for each accepted tx;
the onboarder captures the tip tx and resolves `actual_fee` via `STARKNET_RPC` (`src/fees.ts`),
accumulating per-DID fee (genesis + appends). If the ingest build predates the `ANCHORED` line, it
degrades to count-only. Fees are stored as raw decimal felt strings (STRK wei) and rolled up in
`/roster/aggregates`.

## Auth (write gate)

This is **Layer-2 access control** — who may curate the roster / flip Active / trigger the spend —
and is deliberately separate from contract authorization, which stays the op's embedded signature
(the fee payer is irrelevant; REFERENCE.md §2). The console is **fail-closed**.
`/healthz.writeMode` is one of three states; **all mutating routes** (every non-`GET` except
`/auth/login`) obey it; **reads always stay open**:

| `writeMode` | When | Mutating routes |
|---|---|---|
| `closed` | **default** — no `CONSOLE_ADMIN_TOKEN`, no open flag | refused with `503` |
| `gated` | `CONSOLE_ADMIN_TOKEN` set | require a valid session |
| `open` | `CONSOLE_ALLOW_OPEN_WRITES=1` and no token | allowed unauthenticated (dev/demo) |

Set `CONSOLE_ADMIN_TOKEN` (`openssl rand -hex 32`); clients `POST /auth/login {secret}` for a
short-lived HMAC-signed bearer token (`CONSOLE_SESSION_TTL_MS`, default 1h) sent as
`Authorization: Bearer <token>`. The token is stateless (an HMAC over its expiry). Auth is a
pluggable seam (`src/auth.ts`) — the shared-secret MVP can be swapped for "sign-in with Starknet"
without touching the routes.

### Status reflects on-chain reality

The refresher checks **every active (non-`removed`) roster DID** against the anchor via
`@plc-anchor/witness`, not just ones the console onboarded — so a DID anchored **anywhere** shows
its real §4 status and is promoted to `anchored` on observation (no write). `absent` means the
anchor doesn't know it yet.

## Running

```sh
# Tests (Node-native TS; node:sqlite needs the flag):
make console-test            # or: cd console && node --experimental-sqlite --test

# Serve the Eurosky MVP (refresh + fee lookup enabled when STARKNET_RPC is set):
ROSTER_CRITERION=pds_domain:eurosky.social PDS_ENDPOINTS=https://eurosky.social \
STARKNET_RPC=https://<sepolia-rpc> node --experimental-sqlite src/main.ts
```

Env (criterion-driven additions in **bold**):

| Env | Meaning | Default |
|---|---|---|
| **`ROSTER_CRITERION`** | membership rule, e.g. `pds_domain:eurosky.social` (enables the tail) | (unset → tail off) |
| **`PDS_ENDPOINTS`** | comma-sep PDS base URLs to enumerate | `https://eurosky.social` |
| **`IMPORT_BUDGET_PER_TICK`** | max on-chain imports per onboard tick | `25` |
| **`ACTIVE_DEFAULT`** | `1`/`true` to boot Active (spend on) | `false` |
| **`ENUMERATE_INTERVAL_MS`** / **`TAIL_INTERVAL_MS`** / **`ENRICH_INTERVAL_MS`** | loop cadences (`0` disables) | `3600000` / `60000` / `30000` |
| `STARKNET_RPC` | JSON-RPC (enables refresh + fee lookups) | (unset → refresh off) |
| `ANCHOR_CONTRACT_ADDRESS` | anchor contract | the Sepolia deployment |
| `PLC_DIRECTORY_URL` / `PLC_MIRROR_URL` | directory base / `/export` source | `https://plc.directory` |
| `REFRESH_INTERVAL_MS` | status refresh + onboard cadence | `300000` |
| `INGEST_COMMAND` | ingest argv (enables on-chain writes) | (unset → onboarding off) |
| `PORT` / `ROSTER_DB` | HTTP port / SQLite path | `8787` / `./roster.db` |
| `CONSOLE_ADMIN_TOKEN` / `CONSOLE_SESSION_TTL_MS` / `CONSOLE_ALLOW_OPEN_WRITES` | the write gate | closed |

The Active toggle, budget, and all cursors persist in the store, so a restart resumes mid-backlog
and honours the last operator toggle (`ACTIVE_DEFAULT` only seeds the first boot).

## Deploy (Fly)

Two apps: `site/` (static landing) and this console. The console image is **multi-stage** — stage
1 builds the Rust `ingest` binary (`--features live`) so onboarding works on Fly; stage 2 is the
Node runtime with the console + `witness-ts`. Build context is the **repo root**:

```sh
fly deploy --config console/fly.toml --dockerfile console/Dockerfile   # from repo root
fly --config console/fly.toml secrets set \
    ROSTER_CRITERION=pds_domain:eurosky.social PDS_ENDPOINTS=https://eurosky.social \
    STARKNET_RPC=… CONSOLE_ADMIN_TOKEN="$(openssl rand -hex 32)" \
    STARKNET_ACCOUNT_ADDRESS=0x… STARKNET_ACCOUNT_PRIVATE_KEY=0x…
```

**First activation must be cheap and measurable**: leave `ACTIVE_DEFAULT` off, set a small
`IMPORT_BUDGET_PER_TICK` (e.g. 5), flip Active on in the UI, confirm ≤budget imports/tick and that
`/roster/aggregates` shows the fee accruing, then scale the budget once the per-DID cost is known.

## Not yet here

Mutable/multi-criterion rosters · mainnet repoint (a fresh contract deploy — `scripts/deploy.sh` +
`deployments/`) · cost allocation (paymaster/AA) · governance · bsky-appview enrichment
(display names/avatars). The durable record lands in `docs/HISTORY.md`.
