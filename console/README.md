# `console/` — Layer-2 admin console (build item 6)

The off-chain admin/user tool from `REFERENCE.md` §6: define **which** `did:plc`s we anchor
(membership is off-chain policy — §2, so the contract has no roster getter and this owns it),
watch their **state**, and surface the **`diverged` alarm**. It is **glue, not consensus** — it
composes the already-differential-green pieces and re-implements none of them (CLAUDE.md
guardrail):

- reads status via **`@plc-anchor/witness`** (`check()` → the §4 graduated status);
- writes via **`ingest --did/--roster --submit`** (the integrity invariant stays in ingest);
- the only net-new logic is the **PDS-host parser** (`src/pdshost.ts`), which only *selects*
  DIDs — it carries no consensus weight.

## Roster lifecycle

```
candidate ──approve──▶ approved ──▶ onboarding ──▶ anchored{confirmed|tentative-consistent|diverged|absent}
   ▲  │ (explicit add or filter match)      │ (ingest --submit)        │ (witness check, refreshed)
   │  └─────────────── removed ◀────────────┴──────────────────────────┘
   └── revive
```

The **approve gate** is the cost guardrail: a dynamic filter only ever *proposes* a `candidate`;
a human must approve before the onboarder writes on-chain. Transitions are validated
(`ALLOWED_TRANSITIONS`), so a filter can never skip the gate.

## Layout

- `src/types.ts` — roster/filter shapes + the lifecycle states.
- `src/roster.ts` — the SQLite store (`node:sqlite`, zero deps) + the validated state machine.
- `src/pdshost.ts` — **net-new** PDS-host extraction (modern `plc_operation`, legacy `create`,
  and resolved DID-doc shapes).
- `src/refresh.ts` — status refresher over an injectable `StatusChecker` (testable without a
  live anchor).
- `src/onboard.ts` — drives `ingest --did --submit` over an injectable `CommandRunner`
  (`approved → onboarding → anchored`, or back to `approved` on failure).
- `src/discover.ts` — the filter discover-scan: polls a mirror's `/export`, matches `pds_host`,
  upserts candidates (behind the approve gate).
- `src/witness.ts` — the one binding to `@plc-anchor/witness` (isolated; loaded only at runtime).
- `src/server.ts` — framework-free `node:http` API.
- `src/main.ts` — entry point: API + the worker loops.

## API

| Method | Path | Does |
|---|---|---|
| GET | `/healthz` | liveness, contract address, `writeMode`, counts (incl. diverged) |
| POST | `/auth/login` | exchange `{secret}` for a short-lived session `{token, expiresAt}` |
| GET | `/roster` | list all entries |
| GET | `/roster/diverged` | the alarm list |
| POST | `/roster/dids` | add an explicit DID (`{did}`) → `candidate` |
| GET | `/roster/dids/:did` | one entry |
| POST | `/roster/dids/:did/approve` | `candidate → approved` (the gate) |
| DELETE | `/roster/dids/:did` | → `removed` |
| GET/POST | `/roster/filters` | list / add a `pds_host` filter (`{value}`) |
| DELETE | `/roster/filters/:id` | remove a filter |
| POST | `/worker/discover` | run one discover-scan now |
| POST | `/worker/onboard` | onboard all approved DIDs now (writes on-chain) |
| POST | `/worker/refresh` | check every active DID against the anchor now |

The read-only loops (discover, refresh) run on timers; **onboarding never does** — it spends
on-chain, so it is operator-triggered only (`POST /worker/onboard`), reinforcing the approve
gate.

## Auth (write gate)

This is **Layer-2 access control** — who may curate the roster / trigger the on-chain spend — and
is deliberately separate from contract authorization, which stays the op's embedded signature (the
fee payer is irrelevant; REFERENCE.md §2). Gating the admin UI does not touch that property.

The console is **fail-closed**. `/healthz.writeMode` is one of three states, and **all mutating
routes** (every non-`GET` except `/auth/login`) obey it; **reads always stay open**:

| `writeMode` | When | Mutating routes |
|---|---|---|
| `closed` | **default** — no `CONSOLE_ADMIN_TOKEN`, no open flag | refused with `503` |
| `gated` | `CONSOLE_ADMIN_TOKEN` set | require a valid session |
| `open` | `CONSOLE_ALLOW_OPEN_WRITES=1` and no token | allowed unauthenticated (dev/demo) |

So a fresh deploy can change nothing until you set a secret — that's the point. To gate: set
`CONSOLE_ADMIN_TOKEN` to a shared operator secret (`openssl rand -hex 32`). Clients then
`POST /auth/login {secret}` for a short-lived HMAC-signed bearer token (`CONSOLE_SESSION_TTL_MS`,
default 1h) and send it as `Authorization: Bearer <token>`. The token is stateless (an HMAC over
its expiry), so there is no session store; a leaked request expires and the long-lived secret never
rides on every call. The bundled UI shows an **Unlock** box when `writeMode` is `gated`, keeps the
token in `sessionStorage`, and displays a "writes disabled" notice when `closed`. Run genuinely
open only on purpose with `CONSOLE_ALLOW_OPEN_WRITES=1`.

Auth is a pluggable seam (`src/auth.ts`, `Authenticator`): the shared-secret MVP can be swapped for
wallet-signature ("sign-in with Starknet") verification without touching the routes — only
`login`/`verify` change. Behind Fly's TLS the bearer token never travels in cleartext.

### Status reflects on-chain reality

The refresher checks **every active (non-`removed`) roster DID** against the anchor via
`@plc-anchor/witness`, not just ones the console onboarded. So a DID anchored **anywhere** —
including via `ingest` directly — shows its real §4 status once you add it to the roster, and is
promoted to `anchored` on observation (no write, so the approve gate is untouched). Workflow: set
the Starknet secrets → **Add** the DID → it lights up with its Sepolia status. `absent` means the
anchor doesn't know it yet.

## Running

```sh
# Tests (Node-native TS; node:sqlite needs the flag):
make console-test            # or: cd console && node --experimental-sqlite --test

# Serve (refresh loop enabled only when STARKNET_RPC is set):
STARKNET_RPC=https://<sepolia-rpc> node --experimental-sqlite src/main.ts
```

Env: `PORT` (8787), `ROSTER_DB` (`./roster.db`), `STARKNET_RPC` (enables the refresh loop),
`ANCHOR_CONTRACT_ADDRESS` (default = the Sepolia deployment), `PLC_DIRECTORY_URL`
(`https://plc.directory`), `REFRESH_INTERVAL_MS` (300000; 0 disables), `INGEST_COMMAND` (enables
onboarding; set to `/usr/local/bin/ingest` in the Docker image), `CONSOLE_ADMIN_TOKEN` (gates
writes; **unset = writes closed**), `CONSOLE_SESSION_TTL_MS` (session lifetime, default 3600000),
`CONSOLE_ALLOW_OPEN_WRITES` (`1`/`true` to run open without a token), plus the ingest fee-payer
secrets (`STARKNET_ACCOUNT_ADDRESS`, `STARKNET_ACCOUNT_PRIVATE_KEY`).

## Deploy (Fly)

Two apps: `site/` (static landing) and this console. The console image is **multi-stage** —
stage 1 builds the Rust `ingest` binary (`--features live`) so the Onboard button works on Fly;
stage 2 is the Node runtime with the console + `witness-ts`. Build context is the **repo root**:

```sh
fly deploy --config console/fly.toml --dockerfile console/Dockerfile   # from repo root
fly --config console/fly.toml secrets set STARKNET_RPC=… CONSOLE_ADMIN_TOKEN=… \
    STARKNET_ACCOUNT_ADDRESS=0x… STARKNET_ACCOUNT_PRIVATE_KEY=0x…
```

Without `STARKNET_RPC` the refresh loop is off (`[refresh] disabled`) and the console only curates
policy — that's the usual cause of a live console that "isn't connected."

**Enabling the write gate on Fly.** The console is fail-closed, so a fresh deploy refuses every
change until you set the secret — no image rebuild needed, `secrets set` triggers a rolling
restart and the gate is live on the next boot:

```sh
fly --config console/fly.toml secrets set CONSOLE_ADMIN_TOKEN="$(openssl rand -hex 32)"
# optional: override the 1h session lifetime
fly --config console/fly.toml secrets set CONSOLE_SESSION_TTL_MS=3600000
```

Verify: `curl -s https://<host>/healthz` shows `"writeMode":"gated"`, and an unauthenticated
`curl -X POST https://<host>/roster/dids …` returns `401`. Boot logs show `[auth] writes CLOSED`
until the secret is set. To run intentionally open (local/demo), set `CONSOLE_ALLOW_OPEN_WRITES=1`
instead.

## Not yet here

Mainnet repoint (a fresh contract deploy — see `scripts/deploy.sh` + `deployments/`) · cost
allocation (paymaster/AA) · governance. The durable record lands in `docs/HISTORY.md`.
