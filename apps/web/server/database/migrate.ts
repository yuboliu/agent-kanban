import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Pure-local SQL migration runner (stage 2 of the local-only migration).
 *
 * Applies `apps/web/migrations/*.sql` to a local SQLite database in filename
 * order, recording each file in the `d1_migrations` table using the same
 * shape as modern `wrangler d1 migrations apply` (id / name / applied_at), so
 * a database migrated here is compatible with the stage-7 import verification
 * and with `wrangler d1 migrations apply` if it is ever pointed at the same
 * file. No workerd / wrangler involved.
 */
export function applyLocalMigrations(databasePath: string, migrationsDir: string): string[] {
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const applied = new Set(
      db
        .prepare("SELECT name FROM d1_migrations")
        .all()
        .map((row) => (row as { name: string }).name),
    );

    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const appliedNow: string[] = [];
    const tx = db.transaction(() => {
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        db.exec(sql);
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
        appliedNow.push(file);
      }
    });
    tx();
    return appliedNow;
  } finally {
    db.close();
  }
}
