import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  up: string;
}

/** S5: one migration per version, never edited once released. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT    NOT NULL,
        description  TEXT,
        important    INTEGER CHECK (important IN (0, 1)),
        urgent       INTEGER CHECK (urgent IN (0, 1)),
        due_date     TEXT,
        status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
        position     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE task_tags (
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag     TEXT    NOT NULL,
        PRIMARY KEY (task_id, tag)
      );
      CREATE INDEX task_tags_by_tag ON task_tags(tag);
      -- Append-only. No foreign key: a deleted task keeps its history.
      -- No CHECK on type: new event types must not need a table rebuild.
      CREATE TABLE events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        type    TEXT    NOT NULL,
        at      TEXT    NOT NULL,
        payload TEXT    NOT NULL DEFAULT '{}'
      );
      CREATE INDEX events_by_task ON events(task_id);
    `,
  },
];

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Applies every pending migration, each in its own IMMEDIATE transaction that
 * re-reads user_version under the write lock, so concurrent processes never
 * apply one twice. Foreign keys are off while migrating (a table rebuild must
 * not cascade) and checked before each commit. Idempotent.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  if (sorted.every((m) => m.version <= userVersion(db))) return;
  const fk = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  db.run("PRAGMA foreign_keys = OFF");
  try {
    for (const m of sorted) {
      db.transaction(() => {
        if (userVersion(db) >= m.version) return;
        db.run(m.up);
        const broken = db.query("PRAGMA foreign_key_check").all();
        if (broken.length > 0) throw new Error(`Migration ${m.version} broke foreign keys: ${JSON.stringify(broken)}`);
        db.run(`PRAGMA user_version = ${Math.trunc(m.version)}`);
      }).immediate();
    }
  } finally {
    db.run(`PRAGMA foreign_keys = ${fk ? "ON" : "OFF"}`);
  }
}
