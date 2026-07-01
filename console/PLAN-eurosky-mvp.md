# Plan — Console "Eurosky MVP": single-roster, Active toggle, 20k-scale table

> **Working execution plan** for a fresh agent. Transient: when it lands, fold the durable
> decisions into `docs/HISTORY.md` (item 6) and delete this file. Read `CLAUDE.md` +
> `REFERENCE.md` first; obey the guardrails (no consensus logic in `console/`).

## Context

The console (`console/`, build item 6) works: it curates a roster, drives `ingest --submit`
on-chain, and shows the §4 graduated status. But it was built for a hand-curated roster with a
per-DID approve gate, and that doesn't fit the first real customer. This phase narrows the
deployment to **one fixed criterion — accounts hosted on the `eurosky.social` PDS (~20k)** — as
the MVP pitch to the Eurosky team, and makes the tool *operable at that scale and cost-safe*.

The current pain (all confirmed against the code):
- **Discovery is impractical.** `discover.ts` scans `/export` from genesis, one manual page of
  1000 at a time, with the loop disabled (`DISCOVER_INTERVAL_MS=0`). At PLC scale it finds
  nothing. There is no "list DIDs on PDS X" API on `plc.directory`.
- **The approve gate doesn't scale** to 20k (nobody clicks Approve 20,000 times).
- **The UI loads all of `/roster` and re-renders every row every 15s** — dies at 20k.
- **Entries are bare DIDs** with no identity context.
- **No cost control or visibility** — testnet was already expensive; mainnet is unknown.

## Settled decisions (do not relitigate)

1. **Criterion = the PDS endpoint `eurosky.social`** (match the op/doc PDS host equal to
   `eurosky.social` OR ending in `.eurosky.social` — a domain-suffix match, replacing today's
   exact-host compare). Deploy-time **env config**, not user-editable.
2. **Discovery = enumerate the PDS, then tail for changes.**
   - Backlog: `com.atproto.sync.listRepos` against Eurosky's PDS (`https://eurosky.social`) →
     filter `did:plc` → auto-queue. Cheap and complete.
   - Ongoing: tail `/export` filtered by the criterion for new/changed/departed accounts (this
     is the identity-change signal the witness exists for).
3. **Approve gate dropped for this deployment.** Matched DIDs auto-queue; the **Active/Inactive
   toggle + a per-tick import budget** are the spend guardrail. Keep the state machine; just
   auto-advance matches and gate the onboarder.
4. **Active toggle** gates only the **on-chain anchoring** (the spend). Discovery, enrichment,
   and status refresh are off-chain/cheap and may run regardless. Default **Inactive** at boot.
5. **Table = server-side** pagination + per-field filter + sort (scales as the roster grows).
6. **Enrichment = PLC-derivable only** (no bsky appview): handle, PDS host, rotation-key count,
   last-op time, tombstoned/active, discovered/anchored timestamps, status.
7. **Cost readout**: anchored vs pending counts + cumulative `actual_fee` (from tx receipts) +
   per-DID average, so you measure a small batch then extrapolate before scaling.
8. **Persist** the toggle, budget, and all cursors in the store (survive restarts).

## Non-goals

Mutable/multi-criterion rosters · governance · paymaster cost-splitting · mainnet cutover (that's
`scripts/deploy.sh` + `deployments/`, separate) · bsky appview enrichment · display names/avatars.

## Config (env; wire in `console/src/main.ts`)

| Env | Meaning | Default |
|---|---|---|
| `ROSTER_CRITERION` | e.g. `pds_domain:eurosky.social` — parsed to a predicate | (required for this deploy) |
| `PDS_ENDPOINTS` | comma-sep PDS base URLs to enumerate via listRepos | `https://eurosky.social` |
| `IMPORT_BUDGET_PER_TICK` | max on-chain imports per active onboard cycle | `25` |
| `ACTIVE_DEFAULT` | Active on at boot? | `false` |
| `ENUMERATE_INTERVAL_MS` / `TAIL_INTERVAL_MS` / `ENRICH_INTERVAL_MS` | loop cadences | see below |

Keep existing: `STARKNET_RPC`, `ANCHOR_CONTRACT_ADDRESS`, account secrets, `INGEST_COMMAND`,
`REFRESH_INTERVAL_MS`. The criterion + PDS endpoints replace the old user-editable `pds_host`
filters; seed the criterion at startup, don't expose filter CRUD in the UI.

## Data model (`console/src/roster.ts`, `types.ts`)

Add to the `roster` table + `RosterEntry` (all nullable except where noted):
`handle`, `keyCount`, `lastOpAt`, `tombstoned` (bool), `discoveredAt`, `anchoredAt`,
`enrichedAt`, `anchorTx`, `anchorFee` (raw felt string). Keep `pdsHost`, `status`, etc.

Add a **settings** accessor (reuse the `meta` KV or a typed `settings` table):
`active` (bool), `import_budget` (int, overrides env), plus cursors `enumerate_cursor:<pds>`,
`tail_cursor`. Provide `getActive()/setActive()`, `getBudget()`.

Indexes for the table queries: `(state)`, `(status)`, `(handle)`, `(pds_host)`, `(anchored_at)`.

### State machine

Keep `candidate → approved → onboarding → anchored{…} → removed` and the observation path.
Change: **discovery auto-advances a matched `candidate` to `approved`** (queued), and the
onboarder processes `approved` **only when Active**, up to the per-tick budget. The manual
approve endpoint stays but is unused by the UI. `anchored` still means "on-chain."

## New/changed modules

- **`console/src/pds.ts` (new)** — `PdsClient.listRepos(baseUrl, cursor)` →
  `GET {base}/xrpc/com.atproto.sync.listRepos?limit=1000&cursor=…` → `{repos:[{did,…}], cursor}`;
  filter `did:plc`. Injectable fetcher (like `DirectoryClient`) for offline tests.
- **`console/src/discover.ts` (change)** — repurpose to the **tail** role: cursor initialized to
  ~now (not genesis); criterion = the domain-suffix predicate (see below). Add an **enumeration
  worker** (can live here or in `pds.ts`) that pages listRepos → `upsertCandidate(did,
  "pds:eurosky.social")` → auto-`approve`. Persist per-PDS enumerate cursor.
- **`console/src/criterion.ts` (new)** — parse `ROSTER_CRITERION` → a predicate over an op /
  DID-doc PDS host. Implement the **domain-suffix match** (`host === base || host.endsWith("."+base)`),
  replacing the exact-host compare in `pdshost.ts` usage. Reuse `pdsHostFromOp`/`pdsHostFromDidDoc`.
- **`console/src/enrich.ts` (new)** — `resolveIdentity(did)` via `DirectoryClient`: DID doc
  (`https://plc.directory/{did}`) → handle (`alsoKnownAs[0]` minus `at://`), PDS host, key count
  (rotationKeys of the latest audit op, or verificationMethod count), tombstoned + `lastOpAt`
  from the audit log. A **throttled** background worker enriches entries with stale/absent
  `enrichedAt` (e.g. ≤5 req/s, re-enrich > 24h). Cache via `enrichedAt`.
- **`console/src/onboard.ts` (change)** — gate `onboardApproved()` on `active` + cap at budget;
  after a successful import, capture the **tx hash** from ingest output and store `anchorTx`;
  look up `actual_fee` via a Starknet `starknet_getTransactionReceipt` RPC call → `anchorFee`.
  (Requires a small **`ingest` change**: emit a machine-readable `ANCHORED <did> tx=<hash>` line
  on stdout — `ingest/src/main.rs` / `starknet_sink.rs`. If out of scope, degrade: count only,
  no fee.)
- **`console/src/refresh.ts`** — unchanged in spirit (checks all active DIDs); already correct.

## API (`console/src/server.ts`)

- `GET /roster` → **paginated/filtered/sorted**: `?state=&status=&q=&pdsHost=&sort=&order=&limit=&offset=`
  → `{ rows, total }`. `q` = substring over DID + handle. SQLite `LIKE` + `LIMIT/OFFSET`.
- `GET /roster/aggregates` → counts by state + status, backlog (approved) size, anchored count,
  cumulative + average `anchorFee`, `active`, enumerate/tail cursor progress.
- `GET/POST /settings/active` → read/set the toggle (`{active:boolean}`); optional `budget`.
- Keep `/roster/diverged`, `/roster/dids/:did`, `/healthz` (extend healthz with `active`).
- **Remove** the `pds_host` filter CRUD routes from the UI surface (criterion is config); the
  routes may stay dormant or be deleted.
- Worker triggers (for staged testing): `/worker/enumerate`, `/worker/tail`, `/worker/enrich`,
  `/worker/onboard`, `/worker/refresh`.

## Worker loops (`console/src/main.ts`)

Independent, each degrading to a no-op without its config; all cursors/flags persisted:
- **enumerate** (until backlog drained, then idle) — listRepos → auto-approved candidates.
- **tail** (`TAIL_INTERVAL_MS`) — `/export` suffix-filtered → candidates/changes.
- **enrich** (`ENRICH_INTERVAL_MS`, throttled) — identity metadata.
- **onboard** (`REFRESH`-ish cadence, **only when `active`**, budget-capped) — the spend.
- **refresh** (`REFRESH_INTERVAL_MS`) — §4 status + diverged alarm.

## UI (`console/src/ui/index.html`)

Rebuild the single page (stay vanilla, no build):
- **Header**: prominent **Active/Inactive toggle** (calls `/settings/active`), a **spend
  readout** (anchored / pending / cumulative fee / avg), and a static "Criterion: PDS =
  eurosky.social" label. Keep the **diverged alarm** pinned on top.
- **Data grid**: server-side paged; per-column **filter inputs** (DID/handle search box, state +
  status dropdowns, PDS host), **sortable** headers, pagination controls. Columns: handle, DID
  (truncated), state, status, PDS host, key count, last-op, anchored-at, fee. Debounce filter
  inputs → `/roster?…`.
- **Remove** the filters CRUD panel.

## Build order (stage it — each stage is a green commit)

1. **Data model + settings** (schema, `RosterEntry` fields, active/budget accessors, indexes) + tests.
2. **Criterion + domain-suffix match** (`criterion.ts`; update `discover`/pdshost usage) + tests.
3. **Discovery** (`pds.ts` listRepos + enumeration worker → auto-approved) + tests (fixture listRepos).
4. **Enrichment** (`enrich.ts` + throttled worker) + tests (fixture DID doc + audit log).
5. **Anchoring w/ Active + budget + cost capture** (`onboard.ts`; the `ingest` tx-hash emit +
   receipt fee lookup) + tests.
6. **API** (paginated `/roster`, `/aggregates`, `/settings/active`) + tests.
7. **UI** (toggle, spend readout, server-side grid, criterion label; drop filters panel).
8. **Wire `main.ts`** (the loops + toggle gating + persistence).
9. **Docs** (update `console/README.md`; fold into `docs/HISTORY.md`; delete this file).

## Verification

- `make console-test` green at each stage (`node --test`; keep the injectable-seam pattern so
  listRepos/enrich/onboard are offline-testable with fixtures).
- **Scale check**: seed a DB with 20k synthetic rows; assert `/roster` paged/filtered/sorted
  queries return in well under a second and the UI grid stays responsive.
- **Cost/staged check (Sepolia)**: set `IMPORT_BUDGET_PER_TICK=5`, flip Active on, confirm ≤5
  imports/tick, `anchorTx`/`anchorFee` populate, `/aggregates` shows cumulative fee; flip off.
- **E2E**: enumerate against `eurosky.social` listRepos (or a fixture), confirm candidates
  auto-approve, enrich shows handles, a few anchor, statuses refresh, diverged alarm still fires.
- Screenshot the new UI (Playwright, as before) for the record.

## Risks / notes

- **`ingest` must emit the tx hash** for fee tracking — small change; if deferred, degrade to
  count-only (no fee) and note it.
- **20k enrichment = 20k HTTP resolves** — throttle (~5/s ≈ 1h full pass); background, cached.
- **Cost ceiling**: Active defaults **off**, budget small (25); first activation must be cheap
  and measurable before scaling. Consider a one-DID "estimate" before bulk.
- **listRepos trust**: enumerating a known PDS is fine; enrichment re-resolves from PLC
  (authoritative) so the anchored bytes never depend on the PDS's self-report — `ingest`'s
  integrity invariant still guards every import.
- **VM**: 20k rows in SQLite is trivial on the shared-1x/1GB Fly VM; keep enrichment throttled so
  it doesn't hammer plc.directory or the box.
