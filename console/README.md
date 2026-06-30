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
| GET | `/healthz` | liveness, contract address, counts (incl. diverged) |
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
| POST | `/worker/refresh` | refresh all anchored DIDs' status now |

The read-only loops (discover, refresh) run on timers; **onboarding never does** — it spends
on-chain, so it is operator-triggered only (`POST /worker/onboard`), reinforcing the approve
gate.

## Running

```sh
# Tests (Node-native TS; node:sqlite needs the flag):
make console-test            # or: cd console && node --experimental-sqlite --test

# Serve (refresh loop enabled only when STARKNET_RPC is set):
STARKNET_RPC=https://<sepolia-rpc> node --experimental-sqlite src/main.ts
```

Env: `PORT` (8787), `ROSTER_DB` (`./roster.db`), `STARKNET_RPC`, `ANCHOR_CONTRACT_ADDRESS`
(default = the Sepolia deployment), `PLC_DIRECTORY_URL` (`https://plc.directory`),
`REFRESH_INTERVAL_MS` (300000; 0 disables).

## Not yet here (next build phases)

The UI · the `didmarc.dev` landing page · the Fly deploy + mainnet repoint. See the plan; the
durable record lands in `docs/HISTORY.md` when item 6 completes.
