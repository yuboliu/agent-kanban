import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLocalMigrations } from "./migrate";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = process.env.AK_DATA_DIR ?? join(homedir(), ".local", "share", "agent-kanban");
const databasePath = process.env.AK_DATABASE_PATH ?? join(dataDir, "agent-kanban.sqlite");

mkdirSync(dirname(databasePath), { recursive: true });
const applied = applyLocalMigrations(databasePath, process.env.AK_MIGRATIONS_DIR ?? join(WEB_ROOT, "migrations"));
console.log(applied.length > 0 ? `applied ${applied.length} migration(s): ${applied.join(", ")}` : "database up to date");
