import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { applyLocalMigrations } from "./migrate";

/**
 * Stage 7: import old Wrangler/D1 data into a fresh pure-local SQLite
 * database. Copies every business table by column intersection (so removed
 * AMA columns are naturally dropped), backs up the source (0600) with a
 * SHA-256 record, writes a redacted AMA manifest, cleans AMA task bindings,
 * and pauses AMA-only maintainers. The AMA-only tables are never imported.
 */

// AMA-only resource tables: preserved in the backup + manifest, never imported.
const AMA_TABLES = ["ama_agent_sessions", "ama_owner_integrations"];
const SKIP_TABLES = new Set(["_cf_METADATA", "d1_migrations", ...AMA_TABLES]);

export interface ImportedTable {
  table: string;
  rows: number;
}

export interface ImportResult {
  importedTables: ImportedTable[];
  skippedAmaTables: string[];
  backupPath: string;
  backupSha256: string;
  manifestPath: string;
  amaBoundTasksCleaned: number;
  amaMaintainersPaused: number;
}

export interface ImportOptions {
  sourcePath: string;
  databasePath: string;
  migrationsDir: string;
  /** Directory for the source backup + manifest. Defaults to the target's dir. */
  outputDir?: string;
  /** Overwrite an existing target database (default: refuse). */
  force?: boolean;
}

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map((row) => row.name);
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function importFromWranglerD1(options: ImportOptions): ImportResult {
  const { sourcePath, databasePath, migrationsDir, force = false } = options;

  if (!existsSync(sourcePath)) throw new Error(`source database not found: ${sourcePath}`);
  if (existsSync(databasePath) && !force) {
    throw new Error(`target database already exists: ${databasePath} — use --force to overwrite`);
  }

  const outputDir = options.outputDir ?? dirname(databasePath);
  mkdirSync(outputDir, { recursive: true });
  if (!existsSync(databasePath)) mkdirSync(dirname(databasePath), { recursive: true });

  // ── 1. Source backup (0600) + SHA-256 ──────────────────────────────────
  const backupPath = join(outputDir, `d1-backup-${Date.now()}.sqlite`);
  copyFileSync(sourcePath, backupPath);
  chmodSync(backupPath, 0o600);
  const backupSha256 = sha256OfFile(backupPath);

  // ── 2. Fresh baseline ──────────────────────────────────────────────────
  if (existsSync(databasePath)) rmSync(databasePath);
  applyLocalMigrations(databasePath, migrationsDir);

  let dst: Database.Database | null = null;
  try {
    dst = new Database(databasePath);
    // Copy in dependency-free order; validate foreign keys afterwards.
    dst.pragma("foreign_keys = OFF");
    // Read the source in-place via ATTACH; business rows are copied with the
    // `src.` schema prefix (unprefixed would select from the empty target).
    dst.exec(`ATTACH DATABASE ${JSON.stringify(sourcePath)} AS src`);

    const src = new Database(sourcePath, { readonly: true });
    try {
      const tables = tableNames(src).filter((table) => !SKIP_TABLES.has(table));
      const importedTables: ImportedTable[] = [];

      for (const table of tables) {
        const srcCols = tableColumns(src, table);
        const dstCols = tableColumns(dst, table);
        const cols = srcCols.filter((col) => dstCols.includes(col));
        if (cols.length === 0) continue;
        const colList = cols.map(quote).join(", ");
        const result = dst.prepare(`INSERT INTO ${quote(table)} (${colList}) SELECT ${colList} FROM src.${quote(table)}`).run();
        importedTables.push({ table, rows: result.changes });
      }

      // ── 3. AMA cleanup ─────────────────────────────────────────────────
      const amaBoundTasksCleaned = cleanAmaTaskBindings(dst);
      const amaMaintainersPaused = pauseAmaOnlyMaintainers(dst, src);

      // ── 4. Verify ──────────────────────────────────────────────────────
      const fkRows = dst.pragma("foreign_key_check") as unknown[] | undefined;
      const fkViolations = Array.isArray(fkRows) ? fkRows.length : 0;
      if (fkViolations > 0) throw new Error(`foreign key check failed with ${fkViolations} violations`);

      const rowCounts = Object.fromEntries(
        importedTables.map(({ table }) => {
          const row = dst!.prepare(`SELECT COUNT(*) AS c FROM ${quote(table)}`).get() as { c: number };
          return [table, row.c];
        }),
      );

      // ── 5. Redacted AMA manifest ───────────────────────────────────────
      const amaCounts: Record<string, number> = {};
      for (const table of AMA_TABLES) {
        if (tableNames(src).includes(table)) {
          amaCounts[table] = (src.prepare(`SELECT COUNT(*) AS c FROM ${quote(table)}`).get() as { c: number }).c;
        } else {
          amaCounts[table] = 0;
        }
      }

      const manifest = {
        generated_at: new Date().toISOString(),
        source: sourcePath,
        target: databasePath,
        backup: { path: backupPath, sha256: backupSha256 },
        ama: {
          ...amaCounts,
          ama_bound_tasks_cleaned: amaBoundTasksCleaned,
          ama_only_maintainers_paused: amaMaintainersPaused,
          note: "AMA tables and credentials are preserved only in the backup; they are not imported.",
        },
        imported_tables: importedTables,
        row_counts: rowCounts,
      };
      const manifestPath = join(outputDir, `ama-manifest-${Date.now()}.json`);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

      dst.pragma("foreign_keys = ON");
      return {
        importedTables,
        skippedAmaTables: AMA_TABLES,
        backupPath,
        backupSha256,
        manifestPath,
        amaBoundTasksCleaned,
        amaMaintainersPaused,
      };
    } finally {
      src.close();
    }
  } catch (error) {
    dst?.close();
    // Never leave a half-imported target behind.
    if (existsSync(databasePath)) rmSync(databasePath);
    throw error;
  }
}

/**
 * Clears functional AMA bindings from task metadata. Terminal tasks keep
 * their card/actions/messages but lose the binding; active tasks become
 * `error`, lose their assignee and are flagged runtime_removed for a manual
 * retry.
 */
function cleanAmaTaskBindings(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT id, status, metadata FROM tasks
         WHERE json_extract(metadata, '$.annotations."ama.sessionId"') IS NOT NULL
            OR json_extract(metadata, '$.annotations."ama.dispatch.result"') IS NOT NULL`,
    )
    .all() as { id: string; status: string; metadata: string | null }[];
  const update = db.prepare(
    `UPDATE tasks SET
       status = ?,
       assigned_to = NULL,
       metadata = json_set(
         json_set(COALESCE(metadata, '{}'), '$.annotations', json(
           json_remove(
             json_remove(
               COALESCE(json_extract(metadata, '$.annotations'), '{}'),
               '$."ama.sessionId"'
             ),
             '$."ama.dispatch.result"'
           )
         )),
         '$.annotations."runtime.removed"', true
       )
       WHERE id = ?`,
  );
  const active = new Set(["todo", "in_progress", "in_review"]);
  for (const task of rows) {
    const nextStatus = active.has(task.status) ? "error" : task.status;
    update.run(nextStatus, task.id);
  }
  return rows.length;
}

/**
 * Maintainers whose only trigger was AMA (non-local schedule) cannot run on
 * the pure-local runtime: keep the row but pause it.
 */
function pauseAmaOnlyMaintainers(dst: Database.Database, src: Database.Database): number {
  if (!tableColumns(src, "board_maintainers").includes("ama_schedule_id")) return 0;
  const rows = src.prepare(`SELECT id FROM board_maintainers WHERE ama_schedule_id IS NOT NULL AND ama_schedule_id NOT LIKE 'local:%'`).all() as {
    id: string;
  }[];
  const update = dst.prepare("UPDATE board_maintainers SET status = 'paused' WHERE id = ?");
  for (const row of rows) update.run(row.id);
  return rows.length;
}
