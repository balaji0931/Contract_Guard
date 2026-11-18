import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { migrationStatus, openDatabase, runMigrations } from "../src/db/database.js";
import { MIGRATIONS, type Migration } from "../src/db/migrations.js";

const dirs: string[] = [];
const openHandles: Array<{ close: () => void }> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cg-db-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openHandles.length) openHandles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const EXPECTED_TABLES = [
  "alerts",
  "consumer_use_fields",
  "consumer_uses",
  "consumers",
  "events",
  "findings",
  "operations",
  "schema_migrations",
  "services",
  "spec_versions",
  "wire_fields",
];

describe("openDatabase", () => {
  it("creates the parent directory and applies the baseline migration", () => {
    const target = join(tempDir(), "nested", "deeper", "contract-guard.db");
    const { db, applied } = openDatabase({ path: target });
    openHandles.push(db);

    expect(applied).toEqual(["0001_baseline_registry_schema"]);
    expect(existsSync(target)).toBe(true);
  });

  it("creates every registry table from PLAN.md §5", () => {
    const { db } = openDatabase({ path: join(tempDir(), "cg.db") });
    openHandles.push(db);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    for (const table of EXPECTED_TABLES) expect(tables).toContain(table);
  });

  it("works with an in-memory database", () => {
    const { db, applied } = openDatabase({ path: ":memory:" });
    openHandles.push(db);
    expect(applied).toHaveLength(1);
    expect(migrationStatus(db).pending).toEqual([]);
  });

  it("re-running on the same file is a safe no-op", () => {
    const path = join(tempDir(), "cg.db");

    const first = openDatabase({ path });
    first.db.close();
    expect(first.applied).toEqual(["0001_baseline_registry_schema"]);

    const second = openDatabase({ path });
    openHandles.push(second.db);
    expect(second.applied).toEqual([]);
    expect(migrationStatus(second.db)).toEqual({
      applied: ["0001_baseline_registry_schema"],
      pending: [],
    });
  });

  it("keeps data across reopening the same file", () => {
    const path = join(tempDir(), "cg.db");

    const first = openDatabase({ path });
    first.db.prepare("INSERT INTO services (name, owner) VALUES (?, ?)").run("quote-api", "Quotes team");
    first.db.close();

    const second = openDatabase({ path });
    openHandles.push(second.db);
    const rows = second.db.prepare("SELECT name, owner FROM services").all() as Array<{
      name: string;
      owner: string;
    }>;
    expect(rows).toEqual([{ name: "quote-api", owner: "Quotes team" }]);
  });

  it("enables foreign keys", () => {
    const { db } = openDatabase({ path: join(tempDir(), "cg.db") });
    openHandles.push(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare("INSERT INTO spec_versions (service_id, version, status) VALUES (999, '1.0.0', 'published')")
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("runMigrations", () => {
  it("applies migrations in id order", () => {
    const db = new BetterSqlite3(":memory:");
    openHandles.push(db);

    const fixtures: Migration[] = [
      { id: "0002_second", description: "second", sql: "CREATE TABLE second (x INTEGER);" },
      { id: "0001_first", description: "first", sql: "CREATE TABLE first (x INTEGER);" },
    ];

    expect(runMigrations(db, fixtures)).toEqual(["0001_first", "0002_second"]);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toContain("first");
    expect(names).toContain("second");
  });

  it("rolls back a failing migration completely, leaving no partial schema or record", () => {
    const db = new BetterSqlite3(":memory:");
    openHandles.push(db);

    const broken: Migration = {
      id: "0001_broken",
      description: "creates a table then fails",
      sql: "CREATE TABLE should_not_exist (x INTEGER); SELECT * FROM table_that_is_not_real;",
    };

    expect(() => runMigrations(db, [broken])).toThrow(/migration 0001_broken .* failed/);

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'")
      .get();
    expect(table).toBeUndefined();

    const recorded = db.prepare("SELECT id FROM schema_migrations WHERE id = '0001_broken'").get();
    expect(recorded).toBeUndefined();
  });

  it("skips migrations already recorded and keeps pending ones visible", () => {
    const db = new BetterSqlite3(":memory:");
    openHandles.push(db);

    // Install only the bookkeeping table, so the baseline looks pending.
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)");
    const status = migrationStatus(db);
    expect(status.applied).toEqual([]);
    expect(status.pending).toEqual(MIGRATIONS.map((migration) => migration.id));

    expect(runMigrations(db, [])).toEqual([]);
    expect(migrationStatus(db).pending).toEqual(MIGRATIONS.map((migration) => migration.id));
  });

  it("ships exactly one baseline migration for Phase 0", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual(["0001_baseline_registry_schema"]);
  });

  it("reserves the statuses required by locked decision L-2", () => {
    const { db } = openDatabase({ path: join(tempDir(), "cg.db") });
    openHandles.push(db);
    db.prepare("INSERT INTO services (name) VALUES ('claims-api')").run();
    const serviceId = (db.prepare("SELECT id FROM services WHERE name = 'claims-api'").get() as { id: number }).id;

    const insert = db.prepare(
      "INSERT INTO spec_versions (service_id, version, status, source_file) VALUES (?, ?, ?, ?)",
    );
    for (const status of ["staged", "published", "blocked", "rejected", "invalid"]) {
      expect(() => insert.run(serviceId, `1.0.${status}`, status, `1-${status}.yaml`)).not.toThrow();
    }
    // The same file cannot be intaken twice for one service...
    expect(() => insert.run(serviceId, "1.0.published", "blocked", "1-published.yaml")).toThrow(/UNIQUE/i);
    // ...but a *different* file reusing a reserved version is storable as a
    // rejection row, which is how L-2 records the corrected claims-api 1.1.0.
    expect(() => insert.run(serviceId, "1.0.published", "rejected", "2-fixed.yaml")).not.toThrow();
    expect(() => insert.run(serviceId, "9.9.9", "not_a_status", "3.yaml")).toThrow(/CHECK/i);
  });
});
