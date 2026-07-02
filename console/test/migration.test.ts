//! Migration — opening a store on a *pre-existing* DB from the old (pre-Eurosky) schema must add
//! the new columns and their indexes without crashing. Guards the ordering bug where SCHEMA indexed
//! columns that only exist after #migrate() (Fly volume reboot loop, "no such column: handle").

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RosterStore } from "../src/roster.ts";

/** The roster/meta schema as it existed before the enrichment/anchor columns were added. */
const OLD_SCHEMA = `
CREATE TABLE roster (
  did TEXT PRIMARY KEY, state TEXT NOT NULL, source TEXT NOT NULL, pds_host TEXT,
  status TEXT, status_reason TEXT, status_checked_at INTEGER, head_cid TEXT, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX roster_state_idx ON roster(state);
CREATE INDEX roster_status_idx ON roster(status);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

test("opens a pre-existing old-schema DB, migrates columns + indexes, no crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-mig-"));
  const path = join(dir, "roster.db");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(OLD_SCHEMA);
    seed
      .prepare("INSERT INTO roster (did, state, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("did:plc:old", "anchored", "explicit", 1, 1);
    seed.close();

    // This constructor path is exactly what crashed on the Fly volume.
    const store = RosterStore.open(path);
    const existing = store.get("did:plc:old")!;
    assert.equal(existing.state, "anchored");
    assert.equal(existing.handle, null, "migrated column defaults to null on old rows");

    // The migrated columns + their indexes are usable.
    store.setEnrichment("did:plc:old", {
      handle: "revived.eurosky.social",
      pdsHost: "eurosky.social",
      keyCount: 1,
      lastOpAt: 42,
      tombstoned: false,
    });
    const page = store.query({ q: "revived", sort: "handle" });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].handle, "revived.eurosky.social");

    // Re-opening again (idempotent migration) also must not throw.
    store.close();
    const reopened = RosterStore.open(path);
    assert.equal(reopened.get("did:plc:old")!.handle, "revived.eurosky.social");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
