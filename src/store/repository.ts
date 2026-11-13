import type { Database } from "bun:sqlite";
import { bucketOf, flagsFor, type Bucket, type Quadrant, type Status, type Task } from "../domain/task.ts";
import { mergeTags } from "../domain/tags.ts";

type EventType = "created" | "edited" | "moved" | "completed" | "reopened" | "deleted";

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  important: number | null;
  urgent: number | null;
  due_date: string | null;
  status: Status;
  position: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NewTask {
  title: string;
  description?: string | null;
  /** null or missing: Inbox */
  quadrant?: Quadrant | null;
  dueDate?: string | null;
  tags?: string[];
  status?: Status;
}

export interface TaskChanges {
  title?: string;
  description?: string | null;
  dueDate?: string | null;
  tags?: string[];
}

export interface ListOptions {
  bucket?: Bucket;
  /** default "open" */
  status?: Status | "all";
}

const flag = (v: number | null): boolean | null => (v === null ? null : v === 1);
const toInt = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

/** The only way the CLI and the TUI read or change tasks (S2). */
export class TaskRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Runs `fn` in one IMMEDIATE transaction: the write lock is taken up front, so
   * a read-then-write never fails because another process wrote in between.
   * Nested calls become savepoints of the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  get(id: number): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = $id").get({ id }) as TaskRow | null;
    return row ? this.hydrate([row])[0]! : null;
  }

  list(options: ListOptions = {}): Task[] {
    const status = options.status ?? "open";
    const rows = this.db
      .query(
        `SELECT * FROM tasks
         WHERE ($status = 'all' OR status = $status)
         ORDER BY important IS NULL, important DESC, urgent DESC, position, id`,
      )
      .all({ status }) as TaskRow[];
    const tasks = this.hydrate(rows);
    return options.bucket === undefined ? tasks : tasks.filter((t) => bucketOf(t) === options.bucket);
  }

  findOpenByTitle(title: string): Task | null {
    const row = this.db
      .query("SELECT * FROM tasks WHERE status = 'open' AND lower(trim(title)) = lower(trim($title)) LIMIT 1")
      .get({ title }) as TaskRow | null;
    return row ? this.hydrate([row])[0]! : null;
  }

  create(input: NewTask): Task {
    return this.transaction(() => {
      const now = this.now();
      const flags = input.quadrant ? flagsFor(input.quadrant) : { important: null, urgent: null };
      const status = input.status ?? "open";
      const { id } = this.db
        .query(
          `INSERT INTO tasks (title, description, important, urgent, due_date, status, position, created_at, updated_at, completed_at)
           VALUES ($title, $description, $important, $urgent, $due, $status, $position, $now, $now, $completed)
           RETURNING id`,
        )
        .get({
          title: input.title.trim(),
          description: input.description ?? null,
          important: toInt(flags.important),
          urgent: toInt(flags.urgent),
          due: input.dueDate ?? null,
          status,
          position: this.nextPosition(flags.important, flags.urgent),
          now,
          completed: status === "done" ? now : null,
        }) as { id: number };
      this.writeTags(id, mergeTags(input.tags ?? []));
      this.event(id, "created", { to: input.quadrant ?? "inbox" }, now);
      return this.mustGet(id);
    });
  }

  update(id: number, changes: TaskChanges): Task {
    return this.transaction(() => {
      const before = this.mustGet(id);
      const after = {
        title: changes.title !== undefined ? changes.title.trim() : before.title,
        description: changes.description !== undefined ? changes.description : before.description,
        dueDate: changes.dueDate !== undefined ? changes.dueDate : before.dueDate,
        tags: changes.tags !== undefined ? mergeTags(changes.tags) : before.tags,
      };
      const diffBefore: Record<string, unknown> = {};
      const diffAfter: Record<string, unknown> = {};
      for (const key of ["title", "description", "dueDate", "tags"] as const) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
          diffBefore[key] = before[key];
          diffAfter[key] = after[key];
        }
      }
      if (Object.keys(diffAfter).length === 0) return before;
      const now = this.now();
      this.db
        .query("UPDATE tasks SET title = $title, description = $description, due_date = $due, updated_at = $now WHERE id = $id")
        .run({ id, title: after.title, description: after.description, due: after.dueDate, now });
      this.writeTags(id, after.tags);
      this.event(id, "edited", { before: diffBefore, after: diffAfter }, now);
      return this.mustGet(id);
    });
  }

  move(id: number, to: Quadrant): Task {
    return this.transaction(() => {
      const task = this.mustGet(id);
      const from = bucketOf(task);
      if (from === to) return task;
      const now = this.now();
      const flags = flagsFor(to);
      this.db
        .query("UPDATE tasks SET important = $important, urgent = $urgent, position = $position, updated_at = $now WHERE id = $id")
        .run({
          id,
          important: toInt(flags.important),
          urgent: toInt(flags.urgent),
          position: this.nextPosition(flags.important, flags.urgent),
          now,
        });
      this.event(id, "moved", { from, to }, now);
      return this.mustGet(id);
    });
  }

  toggleDone(id: number): Task {
    return this.transaction(() => {
      const task = this.mustGet(id);
      const now = this.now();
      const done = task.status === "open";
      this.db
        .query("UPDATE tasks SET status = $status, completed_at = $completed, updated_at = $now WHERE id = $id")
        .run({ id, status: done ? "done" : "open", completed: done ? now : null, now });
      this.event(id, done ? "completed" : "reopened", { quadrant: bucketOf(task) }, now);
      return this.mustGet(id);
    });
  }

  delete(id: number): void {
    this.transaction(() => {
      const task = this.mustGet(id);
      this.db.query("DELETE FROM tasks WHERE id = $id").run({ id });
      this.event(id, "deleted", { from: bucketOf(task), title: task.title }, this.now());
    });
  }

  /** Swaps the task with its neighbour (same bucket and status). No event: order is not history. */
  reorder(id: number, direction: -1 | 1): Task {
    return this.transaction(() => {
      const task = this.mustGet(id);
      const siblings = this.list({ bucket: bucketOf(task), status: task.status });
      const index = siblings.findIndex((t) => t.id === id);
      const other = siblings[index + direction];
      if (!other) return task;
      // Renumber the bucket so equal positions cannot block a swap.
      siblings[index] = other;
      siblings[index + direction] = task;
      const stmt = this.db.query("UPDATE tasks SET position = $position WHERE id = $id");
      siblings.forEach((t, position) => stmt.run({ id: t.id, position }));
      return this.mustGet(id);
    });
  }

  private mustGet(id: number): Task {
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return task;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private nextPosition(important: boolean | null, urgent: boolean | null): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tasks WHERE important IS $important AND urgent IS $urgent")
      .get({ important: toInt(important), urgent: toInt(urgent) }) as { next: number };
    return row.next;
  }

  private writeTags(id: number, tags: string[]): void {
    this.db.query("DELETE FROM task_tags WHERE task_id = $id").run({ id });
    const insert = this.db.query("INSERT INTO task_tags (task_id, tag) VALUES ($id, $tag)");
    for (const tag of tags) insert.run({ id, tag });
  }

  private event(taskId: number, type: EventType, payload: object, at: string): void {
    this.db
      .query("INSERT INTO events (task_id, type, at, payload) VALUES ($taskId, $type, $at, $payload)")
      .run({ taskId, type, at, payload: JSON.stringify(payload) });
  }

  private hydrate(rows: TaskRow[]): Task[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const tagRows = this.db
      .query(`SELECT task_id, tag FROM task_tags WHERE task_id IN (SELECT value FROM json_each($ids)) ORDER BY rowid`)
      .all({ ids: JSON.stringify(ids) }) as { task_id: number; tag: string }[];
    const tags = new Map<number, string[]>();
    for (const r of tagRows) tags.set(r.task_id, [...(tags.get(r.task_id) ?? []), r.tag]);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      important: flag(r.important),
      urgent: flag(r.urgent),
      dueDate: r.due_date,
      tags: tags.get(r.id) ?? [],
      status: r.status,
      position: r.position,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
    }));
  }
}
