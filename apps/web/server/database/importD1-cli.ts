import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importFromWranglerD1 } from "./importD1";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "agent-kanban");

/** Auto-discover a wrangler-local D1 sqlite under apps/web/.wrangler. */
function discoverSource(): string | null {
  const root = join(WEB_ROOT, ".wrangler", "state", "v3", "d1");
  const candidates: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".sqlite") && entry !== "metadata.sqlite") {
        candidates.push(full);
      }
    }
  };
  walk(root);
  return candidates[0] ?? null;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm local:migrate --from-wrangler [--source <sqlite>] [--force] [--output-dir <dir>]

Imports old wrangler-local D1 data (or a D1 export restored to SQLite) into a
fresh pure-local database. The source is backed up (0600) with a SHA-256
record, a redacted AMA manifest is written, and the target database is created
from the current migrations. AMA-only tables are never imported.

  --source <path>   source .sqlite (default: auto-discover .wrangler/state/v3/d1)
  --force           overwrite an existing target database
  --output-dir <d>  where to write the backup + manifest (default: target dir)
  AK_DATA_DIR       data dir for the target database (default: ~/.local/share/agent-kanban)
  AK_DATABASE_PATH  full target database path (overrides AK_DATA_DIR)`);
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const sourcePath = flagValue("--source");
  const outputDir = flagValue("--output-dir");
  const force = args.includes("--force");

  const discovered = sourcePath ?? discoverSource();
  if (!discovered) {
    console.error("No wrangler D1 database found — pass --source <sqlite> explicitly.");
    process.exit(1);
  }

  const dataDir = process.env.AK_DATA_DIR ?? DEFAULT_DATA_DIR;
  const databasePath = process.env.AK_DATABASE_PATH ?? join(dataDir, "agent-kanban.sqlite");

  try {
    const result = importFromWranglerD1({
      sourcePath: discovered,
      databasePath,
      migrationsDir: join(WEB_ROOT, "migrations"),
      ...(outputDir ? { outputDir } : {}),
      force,
    });
    console.log(`Imported from ${discovered}`);
    console.log(`Target database: ${databasePath}`);
    console.log(`Source backup:   ${result.backupPath} (sha256 ${result.backupSha256.slice(0, 12)}…)`);
    console.log(`Manifest:        ${result.manifestPath}`);
    console.log(
      `Tables imported: ${result.importedTables.length} (${result.importedTables.reduce((sum, t) => sum + t.rows, 0)} rows total); ` +
        `AMA tasks cleaned: ${result.amaBoundTasksCleaned}; AMA-only maintainers paused: ${result.amaMaintainersPaused}`,
    );
  } catch (error) {
    console.error(`Import failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
