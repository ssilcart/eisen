import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate } from "./migrations.ts";

type Env = Record<string, string | undefined>;

/** S4: EISEN_DB, else $XDG_DATA_HOME/eisen/eisen.db, else ~/.local/share/eisen/eisen.db. */
export function resolveDbPath(env: Env = process.env): string {
  if (env.EISEN_DB) return env.EISEN_DB;
  const dataHome = env.XDG_DATA_HOME || join(env.HOME ?? "", ".local", "share");
  return join(dataHome, "eisen", "eisen.db");
}

export function openDb(path: string = resolveDbPath()): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // Switching a fresh file to WAL ignores busy_timeout: retry it by hand.
  retryWhileLocked(() => db.run("PRAGMA journal_mode = WAL"));
  retryWhileLocked(() => migrate(db));
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

const BUSY_TIMEOUT_MS = 5000;

function retryWhileLocked(fn: () => void): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      fn();
      return;
    } catch (error) {
      const locked = error instanceof Error && /database is (locked|busy)/i.test(error.message);
      if (!locked || Date.now() > deadline) throw error;
      Bun.sleepSync(10 + Math.random() * 20);
    }
  }
}
