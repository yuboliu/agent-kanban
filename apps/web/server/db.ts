import { customAlphabet } from "nanoid";
import type { AppDatabase } from "./database/appDatabase";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nanoid = customAlphabet(alphabet, 8);
const nanoid12 = customAlphabet(alphabet, 12);

export function newId(): string {
  return nanoid();
}

export function newLongId(): string {
  return nanoid12();
}

// Platform-neutral database handle. Repos only depend on this D1-shaped
// contract; the runtime supplies either Cloudflare D1 (Worker) or the local
// better-sqlite3 adapter (pure-local Node runtime).
export type D1 = AppDatabase;

// Hard ceiling on rows returned from a single task partition (actions or
// messages). Protects the read budget against tasks with runaway row counts.
// Any fetch that returns exactly this many rows is at the cap — callers
// must assume older/newer rows beyond this point were silently truncated.
export const MAX_TASK_PARTITION_ROWS = 500;

export function parseJsonFields<T>(row: T, fields: (keyof T)[]): T {
  for (const f of fields) {
    if (typeof row[f] === "string") row[f] = JSON.parse(row[f] as string);
  }
  return row;
}
