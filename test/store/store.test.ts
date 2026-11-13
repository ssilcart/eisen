import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resolveDbPath } from "../../src/store/db.ts";
import { MIGRATIONS, migrate, type Migration } from "../../src/store/migrations.ts";
import { TaskRepository } from "../../src/store/repository.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eisen-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixedClock(start = Date.parse("2026-11-12T10:00:00Z")) {
  let t = start;
  return () => new Date((t += 1000));
}

function repo() {
  const db = openDb(":memory:");
  return { db, repo: new TaskRepository(db, fixedClock()) };
}

function events(db: Database) {
  return db
    .query("SELECT task_id, type, payload FROM events ORDER BY id")
    .all()
    .map((r: any) => ({ taskId: r.task_id, type: r.type, payload: JSON.parse(r.payload) }));
}

describe("database path (S4)", () => {
  test("EISEN_DB wins", () => {
    expect(resolveDbPath({ EISEN_DB: "/x/y.db", HOME: "/h" })).toBe("/x/y.db");
  });
  test("XDG_DATA_HOME, then ~/.local/share", () => {
    expect(resolveDbPath({ XDG_DATA_HOME: "/data", HOME: "/h" })).toBe("/data/eisen/eisen.db");
    expect(resolveDbPath({ HOME: "/h" })).toBe("/h/.local/share/eisen/eisen.db");
  });
  test("creates the directory and the file, in WAL mode", () => {
    const path = join(dir, "nested", "deeper", "eisen.db");
    const db = openDb(path);
    expect(existsSync(path)).toBe(true);
    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    db.close();
  });
});

describe("migrations (S5)", () => {
  test("empty DB migrates to the latest version and re-running changes nothing", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db);
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(MIGRATIONS.length);
    const schema = db.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    migrate(db);
    expect(db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  });

  test("a DB at version N-1 upgrades without data loss", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db);
    const r = new TaskRepository(db, fixedClock());
    r.create({ title: "keep me", quadrant: 2, tags: ["a"] });
    const next: Migration = { version: MIGRATIONS.length + 1, up: "ALTER TABLE tasks ADD COLUMN extra TEXT" };
    migrate(db, [...MIGRATIONS, next]);
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(MIGRATIONS.length + 1);
    const t = r.list()[0]!;
    expect(t.title).toBe("keep me");
    expect(t.tags).toEqual(["a"]);
  });

  test("a migration that rebuilds tasks does not cascade to task_tags", () => {
    const path = join(dir, "rebuild.db");
    const db = openDb(path);
    new TaskRepository(db, fixedClock()).create({ title: "x", quadrant: 1, tags: ["a", "b"] });
    const rebuild: Migration = {
      version: MIGRATIONS.length + 1,
      up: `CREATE TABLE tasks_new (
             id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
             important INTEGER, urgent INTEGER, due_date TEXT, status TEXT NOT NULL DEFAULT 'open',
             position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
           INSERT INTO tasks_new SELECT * FROM tasks;
           DROP TABLE tasks;
           ALTER TABLE tasks_new RENAME TO tasks;`,
    };
    migrate(db, [...MIGRATIONS, rebuild]);
    expect(db.query("SELECT COUNT(*) AS n FROM task_tags").get()).toEqual({ n: 2 });
    expect((db.query("PRAGMA foreign_keys").get() as any).foreign_keys).toBe(1);
    db.close();
  });

  test("a migration that breaks a foreign key is rejected", () => {
    const db = openDb(":memory:");
    new TaskRepository(db, fixedClock()).create({ title: "x", tags: ["a"] });
    const orphan: Migration = { version: MIGRATIONS.length + 1, up: "DELETE FROM tasks" };
    expect(() => migrate(db, [...MIGRATIONS, orphan])).toThrow(/foreign keys/);
    expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
  });

  test("a failing migration is rolled back entirely", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db);
    const bad: Migration = { version: MIGRATIONS.length + 1, up: "CREATE TABLE x (a); SELECT nope FROM missing;" };
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow();
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(MIGRATIONS.length);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'x'").get()).toBeNull();
  });
});

describe("task repository (S6, S8)", () => {
  test("create stores fields, tags and a created event", () => {
    const { db, repo: r } = repo();
    const t = r.create({ title: "Call #bank", quadrant: 1, dueDate: "2026-12-01", tags: ["Bank", "money"] });
    expect(t).toMatchObject({ title: "Call #bank", important: true, urgent: true, dueDate: "2026-12-01", status: "open" });
    expect(t.tags).toEqual(["bank", "money"]);
    expect(events(db)).toEqual([{ taskId: t.id, type: "created", payload: { to: 1 } }]);
  });

  test("create without a quadrant goes to the Inbox", () => {
    const { repo: r } = repo();
    const t = r.create({ title: "later" });
    expect(t.important).toBeNull();
    expect(t.urgent).toBeNull();
    expect(r.list({ bucket: "inbox" }).map((x) => x.id)).toEqual([t.id]);
  });

  test("positions append inside the bucket", () => {
    const { repo: r } = repo();
    const a = r.create({ title: "a", quadrant: 2 });
    const b = r.create({ title: "b", quadrant: 2 });
    r.create({ title: "c", quadrant: 1 });
    expect(r.list({ bucket: 2 }).map((x) => x.title)).toEqual(["a", "b"]);
    expect(b.position).toBeGreaterThan(a.position);
  });

  test("move writes a moved event with from/to and appends at the end", () => {
    const { db, repo: r } = repo();
    r.create({ title: "x", quadrant: 1 });
    const t = r.create({ title: "y" });
    const moved = r.move(t.id, 1);
    expect(moved.important).toBe(true);
    expect(r.list({ bucket: 1 }).map((x) => x.title)).toEqual(["x", "y"]);
    expect(events(db).at(-1)).toEqual({ taskId: t.id, type: "moved", payload: { from: "inbox", to: 1 } });
    r.move(t.id, 1);
    expect(events(db).filter((e) => e.type === "moved")).toHaveLength(1);
  });

  test("update writes one edited event with before/after, none when unchanged", () => {
    const { db, repo: r } = repo();
    const t = r.create({ title: "old", quadrant: 3 });
    const u = r.update(t.id, { title: "new", description: "body", tags: ["z"] });
    expect(u).toMatchObject({ title: "new", description: "body", tags: ["z"] });
    expect(events(db).at(-1)).toEqual({
      taskId: t.id,
      type: "edited",
      payload: { before: { title: "old", description: null, tags: [] }, after: { title: "new", description: "body", tags: ["z"] } },
    });
    r.update(t.id, { title: "new" });
    expect(events(db).filter((e) => e.type === "edited")).toHaveLength(1);
  });

  test("complete and reopen", () => {
    const { db, repo: r } = repo();
    const t = r.create({ title: "x", quadrant: 2 });
    const done = r.toggleDone(t.id);
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const open = r.toggleDone(t.id);
    expect(open.status).toBe("open");
    expect(open.completedAt).toBeNull();
    expect(events(db).map((e) => e.type)).toEqual(["created", "completed", "reopened"]);
    expect(events(db)[1]!.payload).toEqual({ quadrant: 2 });
  });

  test("list hides done tasks unless asked", () => {
    const { repo: r } = repo();
    const t = r.create({ title: "x", quadrant: 2 });
    r.create({ title: "y", quadrant: 2 });
    r.toggleDone(t.id);
    expect(r.list().map((x) => x.title)).toEqual(["y"]);
    expect(r.list({ status: "all" }).map((x) => x.title).sort()).toEqual(["x", "y"]);
    expect(r.list({ status: "done" }).map((x) => x.title)).toEqual(["x"]);
  });

  test("delete is hard, its events stay", () => {
    const { db, repo: r } = repo();
    const t = r.create({ title: "x", quadrant: 4, tags: ["a"] });
    r.delete(t.id);
    expect(r.get(t.id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM task_tags").get()).toEqual({ n: 0 });
    expect(events(db).map((e) => e.type)).toEqual(["created", "deleted"]);
    expect(events(db)[1]!.payload).toEqual({ from: 4, title: "x" });
  });

  test("reorder swaps with the neighbour in the same bucket", () => {
    const { repo: r } = repo();
    r.create({ title: "a", quadrant: 2 });
    const b = r.create({ title: "b", quadrant: 2 });
    r.create({ title: "c", quadrant: 2 });
    r.reorder(b.id, -1);
    expect(r.list({ bucket: 2 }).map((x) => x.title)).toEqual(["b", "a", "c"]);
    r.reorder(b.id, -1);
    expect(r.list({ bucket: 2 }).map((x) => x.title)).toEqual(["b", "a", "c"]);
    r.reorder(b.id, 1);
    r.reorder(b.id, 1);
    expect(r.list({ bucket: 2 }).map((x) => x.title)).toEqual(["a", "c", "b"]);
  });

  test("a failed event write leaves no task row", () => {
    const { db, repo: r } = repo();
    db.run("DROP TABLE events");
    expect(() => r.create({ title: "x", quadrant: 1 })).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  });

  test.each([
    ["update", (r: TaskRepository, id: number) => r.update(id, { title: "changed", tags: ["z"] })],
    ["move", (r: TaskRepository, id: number) => r.move(id, 1)],
    ["toggleDone", (r: TaskRepository, id: number) => r.toggleDone(id)],
    ["delete", (r: TaskRepository, id: number) => r.delete(id)],
  ] as const)("a failed event write rolls back %s", (_name, op) => {
    const { db, repo: r } = repo();
    const t = r.create({ title: "x", quadrant: 4, tags: ["a"] });
    db.run("DROP TABLE events");
    expect(() => op(r, t.id)).toThrow();
    expect(r.get(t.id)).toEqual(t);
  });

  test("nested transactions join the outer one", () => {
    const { repo: r } = repo();
    expect(() =>
      r.transaction(() => {
        r.create({ title: "a" });
        r.create({ title: "b" });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(r.list()).toEqual([]);
    r.transaction(() => {
      r.create({ title: "a" });
      r.create({ title: "b" });
    });
    expect(r.list().map((t) => t.title)).toEqual(["a", "b"]);
  });

  test("unknown ids throw", () => {
    const { repo: r } = repo();
    expect(() => r.move(99, 1)).toThrow(/99/);
  });

  test("findOpenByTitle is trimmed and case-insensitive", () => {
    const { repo: r } = repo();
    const t = r.create({ title: "Call The Bank" });
    expect(r.findOpenByTitle("  call the bank ")?.id).toBe(t.id);
    r.toggleDone(t.id);
    expect(r.findOpenByTitle("call the bank")).toBeNull();
  });
});
