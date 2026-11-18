/**
 * SQLite access layer (locked decision T-2: better-sqlite3, synchronous API).
 *
 * `openDatabase` creates the directory for a file-backed DB, applies pending
 * migrations idempotently, and returns a ready handle. Each migration runs in
 * its own transaction and is recorded in `schema_migrations`, so calling
 * `openDatabase` again on the same file is a safe no-op.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { MIGRATIONS, type Migration } from "./migrations.js";

export type Database = BetterSqlite3.Database;

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

function appliedMigrationIds(db: Database): Set<string> {
  const rows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Apply pending migrations in order. Returns the ids applied by this call. */
export function runMigrations(db: Database, migrations: Migration[] = MIGRATIONS): string[] {
  db.exec(MIGRATIONS_TABLE);
  const applied = appliedMigrationIds(db);
  const pending = [...migrations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((migration) => !applied.has(migration.id));

  const record = db.prepare("INSERT INTO schema_migrations (id) VALUES (?)");
  const justApplied: string[] = [];
  for (const migration of pending) {
    // One transaction per migration: schema + its record commit together, or not at all.
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id);
    });
    try {
      apply();
      justApplied.push(migration.id);
    } catch (error) {
      throw new Error(
        `migration ${migration.id} (${migration.description}) failed: ${(error as Error).message}`,
      );
    }
  }
  return justApplied;
}

export interface OpenDatabaseOptions {
  /** File path, or ":memory:". */
  path: string;
  migrations?: Migration[];
}

export function openDatabase({ path, migrations }: OpenDatabaseOptions): {
  db: Database;
  applied: string[];
} {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const applied = runMigrations(db, migrations);
  return { db, applied };
}

/** Migrations recorded vs still pending, for the health endpoint and tests. */
export function migrationStatus(db: Database): { applied: string[]; pending: string[] } {
  const applied = [...appliedMigrationIds(db)].sort();
  const pending = MIGRATIONS.map((m) => m.id)
    .filter((id) => !applied.includes(id))
    .sort();
  return { applied, pending };
}
