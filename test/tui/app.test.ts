import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { bucketOf } from "../../src/domain/task.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { importMarkdown } from "../../src/import/importer.ts";
import { openDb } from "../../src/store/db.ts";
import { TaskRepository } from "../../src/store/repository.ts";
import {
  createMatrixApp,
  spawnEditor,
  startTui,
  type AppOptions,
  type EditorPty,
  type MatrixApp,
} from "../../src/tui/app.ts";
import { BUCKET_COLOR, COLOR, paneStyle } from "../../src/tui/theme.ts";

const TODAY = "2026-11-12";

let setup: TestRendererSetup;
let db: Database;
let repo: TaskRepository;
let app: MatrixApp;

async function start(width = 100, height = 30, options: AppOptions = {}) {
  // exitOnCtrlC: false like startTui's renderer, so Ctrl+C reaches the app.
  setup = await createTestRenderer({ width, height, exitOnCtrlC: false });
  app = createMatrixApp(setup.renderer, repo, {
    today: () => TODAY,
    // Never start a real editor by accident: tests that need one pass their own.
    env: {},
    launchEditorPty: () => {
      throw new Error("no PTY in this test");
    },
    runEditor: async () => {
      throw new Error("no editor in this test");
    },
    ...options,
  });
  return frame();
}

async function frame(): Promise<string> {
  await setup.renderOnce();
  return setup.captureCharFrame();
}

async function keys(...names: string[]): Promise<string> {
  for (const name of names) setup.mockInput.pressKey(name);
  return frame();
}

/**
 * Makes `repo.list` throw while `failing()` says so (a locked or unreadable
 * database). Returns a switch: `failNext()` fails the next call only,
 * `failAlways()` every call from now on.
 */
function breakList(target: TaskRepository) {
  const original = target.list.bind(target);
  let mode: "ok" | "once" | "always" = "ok";
  target.list = (...args: Parameters<TaskRepository["list"]>) => {
    if (mode !== "ok") {
      if (mode === "once") mode = "ok";
      throw new Error("database is locked");
    }
    return original(...args);
  };
  return {
    failNext: () => void (mode = "once"),
    failAlways: () => void (mode = "always"),
  };
}

/** "done" if `promise` settles within `ms`, otherwise "stuck". */
function settles(promise: Promise<unknown>, ms = 500): Promise<"done" | "stuck"> {
  return Promise.race([
    promise.then(
      () => "done" as const,
      () => "done" as const,
    ),
    Bun.sleep(ms).then(() => "stuck" as const),
  ]);
}

function byTitle(title: string) {
  return repo.list({ status: "all" }).find((t) => t.title === title);
}

/** The frame without its status line (the last row). */
function grid(f: string): string {
  return f.trimEnd().split("\n").slice(0, -1).join("\n");
}

/** The status line (the last row) of a frame. */
function statusOf(f: string): string {
  return f.trimEnd().split("\n").at(-1)!;
}

/** Row and column of the first occurrence of `text` in the frame. */
function where(f: string, text: string): { row: number; col: number } {
  const rows = f.split("\n");
  const row = rows.findIndex((line) => line.includes(text));
  return { row, col: row < 0 ? -1 : rows[row]!.indexOf(text) };
}

/**
 * A fake editor process on a PTY (S22): records what the app writes to it
 * and the sizes it asks for; the test plays the editor with `emit` (screen
 * output), by writing `path`, and with `exit(code)`.
 */
class FakePty implements EditorPty {
  readonly written: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = false;
  readonly exited: Promise<number>;
  private finish!: (code: number) => void;
  private listener: ((data: Uint8Array) => void) | null = null;

  constructor(
    readonly cmd: string[],
    readonly path: string,
    readonly cols: number,
    readonly rows: number,
  ) {
    this.exited = new Promise((resolve) => (this.finish = resolve));
  }
  onData(listener: (data: Uint8Array) => void): void {
    this.listener = listener;
  }
  write(data: string | Uint8Array): void {
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
    this.finish(143);
  }
  emit(text: string): void {
    this.listener?.(new TextEncoder().encode(text));
  }
  exit(code: number): void {
    this.finish(code);
  }
  /** Everything the app sent to the editor, as text. */
  get typed(): string {
    return this.written.join("");
  }
}

/**
 * A `launchEditorPty` that hands out FakePtys; `play` (if any) runs as the
 * editor once the app has subscribed to the output.
 */
function fakeLauncher(play?: (pty: FakePty) => unknown) {
  const ptys: FakePty[] = [];
  const launch = (cmd: string[], path: string, cols: number, rows: number) => {
    const pty = new FakePty(cmd, path, cols, rows);
    ptys.push(pty);
    if (play) setTimeout(() => void play(pty), 0);
    return pty;
  };
  return { launch, ptys };
}

/** An editor that writes `text` to the file and exits with `code`. */
function writes(text: string, code = 0) {
  return async (pty: FakePty) => {
    await Bun.write(pty.path, text);
    pty.exit(code);
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  repo = new TaskRepository(db);
  repo.create({ title: "Pay rent", quadrant: 1 });
  repo.create({ title: "Call the bank", quadrant: 1 });
  repo.create({ title: "Plan the trip", quadrant: 2 });
  repo.create({ title: "Renew passport", quadrant: 2, dueDate: "2026-11-13" }); // escalated to Q1 (S7)
  repo.create({ title: "Reply to email", quadrant: 3 });
  repo.create({ title: "Watch TV", quadrant: 4 });
  repo.create({ title: "Unsorted idea" });
  repo.create({ title: "Another idea" });
});

afterEach(async () => {
  app?.destroy();
  await setup?.dispose();
});

describe("matrix view (S9)", () => {
  test("shows the four panes with open counts in a 2×2 grid and the Inbox strip with its count", async () => {
    const f = await start();
    expect(f).toContain("Q1 · ✅ Do (3)");
    expect(f).toContain("Q2 · 📅 Schedule (1)");
    expect(f).toContain("Q3 · 🤝 Delegate (1)");
    expect(f).toContain("Q4 · 🧹 Delete (1)");
    expect(f).toContain("📥 Inbox (2)"); // S24: the strip, not the status line
    expect(statusOf(f)).not.toContain("Inbox");
    const q1 = where(f, "Q1 · ✅ Do");
    const q2 = where(f, "Q2 · 📅 Schedule");
    const q3 = where(f, "Q3 · 🤝 Delegate");
    const q4 = where(f, "Q4 · 🧹 Delete");
    expect(q1.row).toBe(q2.row);
    expect(q3.row).toBe(q4.row);
    expect(q3.row).toBeGreaterThan(q1.row);
    expect(q2.col).toBeGreaterThan(q1.col);
    expect(q4.col).toBeGreaterThan(q3.col);
    // Inbox tasks are not in the grid: they are in the strip under it (S24).
    const strip = where(f, "📥 Inbox (2)");
    expect(strip.row).toBeGreaterThan(q3.row);
    expect(where(f, "Unsorted idea").row).toBeGreaterThan(strip.row);
    expect(where(f, "Another idea").row).toBeGreaterThan(strip.row);
  });

  test("an escalated task sits in Q1 with a ! mark and its due date", async () => {
    const f = await start();
    const row = f.split("\n").find((line) => line.includes("Renew passport"))!;
    expect(row).toContain("!");
    expect(row).toContain("2026-11-13");
    expect(where(f, "Renew passport").col).toBeLessThan(where(f, "Q2 · 📅 Schedule").col);
  });

  test("long titles are truncated to the pane width", async () => {
    repo.create({ title: `Very long ${"x".repeat(80)} end`, quadrant: 4 });
    const f = await start(80, 24);
    expect(f).not.toContain(" end");
    expect(f).toContain("…");
  });

  test("a pane windows its list around the selection", async () => {
    for (let i = 1; i <= 30; i++) repo.create({ title: `Chore ${String(i).padStart(2, "0")}`, quadrant: 3 });
    let f = await start(80, 20);
    expect(f).toContain("Chore 01");
    expect(f).not.toContain("Chore 25");
    f = await keys("j", "j", "j"); // Q1 has 3 tasks: the third j crosses to Q3
    for (let i = 0; i < 25; i++) setup.mockInput.pressKey("j");
    f = await frame();
    expect(f).toContain("Chore 25");
    expect(f).not.toContain("Chore 01");
  });

  test("the layout reflows on resize and keeps the four panes", async () => {
    await start();
    setup.resize(60, 16);
    let f = await frame();
    for (const title of ["Q1 · ✅ Do", "Q2 · 📅 Schedule", "Q3 · 🤝 Delegate", "Q4 · 🧹 Delete"]) expect(f).toContain(title);
    expect(f.split("\n")[0]!.length).toBeLessThanOrEqual(60);
    setup.resize(140, 40);
    f = await frame();
    for (const title of ["Q1 · ✅ Do", "Q2 · 📅 Schedule", "Q3 · 🤝 Delegate", "Q4 · 🧹 Delete"]) expect(f).toContain(title);
    expect(where(f, "Q2 · 📅 Schedule").col).toBeGreaterThanOrEqual(70);
  });

  test("a very narrow screen keeps compact pane titles with counts", async () => {
    await start();
    setup.resize(30, 10);
    const f = await frame();
    for (const title of ["Q1 (3)", "Q2 (1)", "Q3 (1)", "Q4 (1)"]) expect(f).toContain(title);
    expect(f).toContain("📥 Inbox (2)");
  });
});

describe("entry point", () => {
  test("eisen with no arguments and no terminal exits 1 instead of hanging", () => {
    const main = new URL("../../src/main.ts", import.meta.url).pathname;
    const r = Bun.spawnSync([process.execPath, main], {
      env: { ...process.env, EISEN_DB: ":memory:" },
      stdin: "pipe",
      stdout: "pipe",
      timeout: 10_000,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("needs a terminal");
  });
});

describe("keys (S10)", () => {
  test("2 moves the selected task to Q2", async () => {
    await start();
    const f = await keys("2");
    expect(bucketOf(byTitle("Pay rent")!)).toBe(2);
    expect(f).toContain("Q1 · ✅ Do (2)");
    expect(f).toContain("Q2 · 📅 Schedule (2)");
  });

  test("j then 4 moves the second task", async () => {
    await start();
    await keys("j", "4");
    expect(bucketOf(byTitle("Call the bank")!)).toBe(4);
    expect(bucketOf(byTitle("Pay rent")!)).toBe(1);
  });

  test("x toggles done; . shows the done panel (S27), never done tasks in the quadrants", async () => {
    await start();
    let f = await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("done");
    expect(grid(f)).not.toContain("Pay rent");
    expect(f).toContain("Done: Pay rent");
    expect(f).toContain("Q1 · ✅ Do (2)");
    f = await keys(".");
    const row = f.split("\n").find((line) => line.includes("Pay rent"))!;
    expect(row).toContain("✓");
    expect(f).toContain("✓ Done (1)");
    expect(where(f, "Pay rent").col).toBeGreaterThan(where(f, "Q2 · 📅 Schedule").col);
    expect(f).toContain("Q1 · ✅ Do (2)");
  });

  test("d asks, n keeps the task, y deletes it", async () => {
    await start();
    let f = await keys("d");
    expect(f).toContain('Delete "Pay rent"? y/n');
    f = await keys("n");
    expect(byTitle("Pay rent")).toBeDefined();
    f = await keys("d", "y");
    expect(byTitle("Pay rent")).toBeUndefined();
    expect(grid(f)).not.toContain("Pay rent");
    expect(f).toContain("Q1 · ✅ Do (2)");
  });

  test("A + typing + Enter adds a task in the focused quadrant with #tags (inline quick-add, S22)", async () => {
    await start();
    await keys("l", "A");
    await setup.mockInput.typeText("Book flights #travel");
    let f = await frame();
    expect(f).toContain("Book flights #travel");
    setup.mockInput.pressEnter();
    f = await frame();
    const task = byTitle("Book flights #travel")!;
    expect(bucketOf(task)).toBe(2);
    expect(task.tags).toEqual(["travel"]);
    expect(f).toContain("Q2 · 📅 Schedule (2)");
  });

  test("Esc cancels the add input without creating anything", async () => {
    await start();
    await keys("A");
    await setup.mockInput.typeText("nope");
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    await frame();
    expect(byTitle("nope")).toBeUndefined();
    expect(repo.list({ status: "all" })).toHaveLength(8);
  });

  test("J reorders the selected task down inside its quadrant", async () => {
    await start();
    setup.mockInput.pressKey("J", { shift: true });
    const f = await frame();
    expect(where(f, "Call the bank").row).toBeLessThan(where(f, "Pay rent").row);
  });

  test("? opens the help and Esc closes it", async () => {
    await start();
    let f = await keys("?");
    expect(f).toContain("Help");
    expect(f).toContain("Toggle done");
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    f = await frame();
    expect(f).not.toContain("Toggle done");
  });

  test("q resolves the app's done promise", async () => {
    await start();
    setup.mockInput.pressKey("q");
    await app.done;
  });
});

describe("selection after a reload", () => {
  beforeEach(() => {
    repo.create({ title: "Hire a cleaner", quadrant: 3 });
  });

  /** Focus Q3 and select its last task, "Hire a cleaner". */
  async function selectLastInQ3() {
    await start();
    // Q1 has 3 tasks: the third j crosses to Q3, the fourth selects its 2nd.
    await keys("j", "j", "j", "j");
    expect(app.state.focus).toBe(3);
    expect(app.state.selected[3]).toBe(1);
  }

  test("deleting the last task of a pane selects the new last one, and x acts on it", async () => {
    await selectLastInQ3();
    await keys("d", "y");
    expect(byTitle("Hire a cleaner")).toBeUndefined();
    expect(app.state.selected[3]).toBe(0);
    const f = await keys("x");
    expect(f).not.toContain("Nothing selected");
    expect(f).toContain("Done: Reply to email");
    expect(byTitle("Reply to email")!.status).toBe("done");
  });

  test("marking the last task done while done tasks are hidden selects the new last one, and x acts on it", async () => {
    await selectLastInQ3();
    let f = await keys("x");
    expect(f).toContain("Done: Hire a cleaner");
    expect(app.state.selected[3]).toBe(0);
    f = await keys("x");
    expect(f).not.toContain("Nothing selected");
    expect(f).toContain("Done: Reply to email");
    expect(byTitle("Reply to email")!.status).toBe("done");
  });
});

describe("repository failures", () => {
  test("q quits even when every reload fails", async () => {
    await start();
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("q");
    } catch {
      // A reload error escaping the key handler is the bug; the assertion below reports it.
    }
    expect(await settles(app.done)).toBe("done");
  });

  test("Ctrl+C quits even when every reload fails", async () => {
    await start();
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("c", { ctrl: true });
    } catch {
      // See above.
    }
    expect(await settles(app.done)).toBe("done");
  });

  test("a failed reload shows the error in the status line and the app keeps working", async () => {
    await start();
    breakList(repo).failNext();
    let f = await keys("x"); // Pay rent is marked done, then the reload fails
    expect(byTitle("Pay rent")!.status).toBe("done");
    expect(f).toContain("Error: database is locked");
    f = await keys("j"); // the next action reloads normally
    expect(f).not.toContain("Error:");
    expect(grid(f)).not.toContain("Pay rent");
    expect(f).toContain("Q1 · ✅ Do (2)");
    f = await keys("x");
    expect(f).toMatch(/Done: (Call the bank|Renew passport)/);
  });

  test("startTui rejects and destroys the renderer when the first load fails", async () => {
    setup = await createTestRenderer({ width: 100, height: 30 });
    breakList(repo).failAlways();
    const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer });
    expect(await settles(run, 2000)).toBe("done");
    await expect(run).rejects.toThrow("database is locked");
    expect(setup.renderer.isDestroyed).toBe(true);
  });
});

describe("edit in $EDITOR, full screen (S11, the S22 fallback)", () => {
  // The test renderer has no real terminal, so its suspend()/resume() throw:
  // replace them with recorders. Returns the call log.
  function stubTerminal(): string[] {
    const calls: string[] = [];
    setup.renderer.suspend = async () => void calls.push("suspend");
    setup.renderer.resume = async () => void calls.push("resume");
    return calls;
  }

  function editedEvents(taskId: number): number {
    const row = db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'edited' AND task_id = $id").get({ id: taskId }) as {
      n: number;
    };
    return row.n;
  }

  // Starts the app with a fake editor and stubbed suspend/resume.
  async function startEditing(runEditor: (path: string) => Promise<number>) {
    await start(100, 30, { runEditor, env: { EISEN_EDITOR_MODE: "fullscreen" } });
    return stubTerminal();
  }

  async function edit(): Promise<string> {
    setup.mockInput.pressKey("e");
    await app.idle();
    return frame();
  }

  test("e writes the task to a temp file, the editor's changes are saved as one edited event", async () => {
    const payRent = byTitle("Pay rent")!;
    repo.update(payRent.id, { description: "Before the 5th", tags: ["todo"] }); // todo: a section tag
    const editsBefore = editedEvents(payRent.id);
    let seen = "";
    let editedPath = "";
    const calls = await startEditing(async (path) => {
      editedPath = path;
      seen = await Bun.file(path).text();
      calls.push("editor");
      await Bun.write(path, "# Pay the rent #home\ndue: 2026-11-30\n\nCall the landlord first #money\n");
      return 0;
    });
    const f = await edit();
    expect(seen).toBe("# Pay rent\n\nBefore the 5th\n");
    expect(dirname(editedPath)).toBe(tmpdir().replace(/\/$/, ""));
    expect(basename(editedPath)).toMatch(new RegExp(`^eisen-${payRent.id}-.+\\.md$`));
    expect(existsSync(editedPath)).toBe(false);
    expect(calls).toEqual(["suspend", "editor", "resume"]);
    const task = repo.get(payRent.id)!;
    expect(task.title).toBe("Pay the rent #home");
    expect(task.dueDate).toBe("2026-11-30");
    expect(task.description).toBe("Call the landlord first #money");
    expect(task.tags).toEqual(["todo", "home", "money"]);
    expect(editedEvents(payRent.id)).toBe(editsBefore + 1);
    expect(f).toContain("Saved");
    expect(f).toContain("Pay the rent #home");
    expect(app.state.selected[1]).toBe(0);
  });

  test("an editor that changes nothing says No changes and writes no event", async () => {
    const id = byTitle("Pay rent")!.id;
    await startEditing(async () => 0);
    const f = await edit();
    expect(f).toContain("No changes");
    expect(editedEvents(id)).toBe(0);
    expect(repo.get(id)!.title).toBe("Pay rent");
  });

  test("a non-zero exit discards the edit", async () => {
    const id = byTitle("Pay rent")!.id;
    const calls = await startEditing(async (path) => {
      await Bun.write(path, "# Changed\n\n");
      return 3;
    });
    const f = await edit();
    expect(f).toContain("Editor exited with code 3");
    expect(repo.get(id)!.title).toBe("Pay rent");
    expect(editedEvents(id)).toBe(0);
    expect(calls).toEqual(["suspend", "resume"]);
  });

  test("an invalid file shows the parse error and changes nothing", async () => {
    const id = byTitle("Pay rent")!.id;
    await startEditing(async (path) => {
      await Bun.write(path, "# Pay rent\ndue: someday\n\n");
      return 0;
    });
    const f = await edit();
    expect(f).toContain('Invalid due date "someday"');
    expect(f).toContain("edit discarded");
    expect(repo.get(id)!.dueDate).toBeNull();
    expect(editedEvents(id)).toBe(0);
  });

  test("resume is called and the temp file removed even when the editor throws", async () => {
    let editedPath = "";
    const calls = await startEditing(async (path) => {
      editedPath = path;
      throw new Error("spawn vi ENOENT");
    });
    const f = await edit();
    expect(calls).toEqual(["suspend", "resume"]);
    expect(f).toContain("Error: spawn vi ENOENT");
    expect(existsSync(editedPath)).toBe(false);
    expect(byTitle("Pay rent")!.title).toBe("Pay rent");
    // The app keeps working.
    await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("done");
  });

  test("keys pressed while the editor runs are ignored", async () => {
    let release!: () => void;
    const editorDone = new Promise<void>((resolve) => (release = resolve));
    let runs = 0;
    await startEditing(async () => {
      runs++;
      await editorDone;
      return 0;
    });
    setup.mockInput.pressKey("e");
    await Bun.sleep(10);
    for (const name of ["x", "j", "e", "d", "y", "q"]) setup.mockInput.pressKey(name);
    setup.mockInput.pressKey("c", { ctrl: true });
    expect(await settles(app.done, 50)).toBe("stuck");
    release();
    await app.idle();
    expect(runs).toBe(1);
    expect(byTitle("Pay rent")!.status).toBe("open");
    expect(app.state.selected[1]).toBe(0);
    expect(repo.list({ status: "all" })).toHaveLength(8);
    // Keys work again once the edit is over.
    await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("done");
  });

  test("e with nothing selected says so and does not open the editor", async () => {
    repo.delete(byTitle("Watch TV")!.id);
    let runs = 0;
    const calls = await startEditing(async () => {
      runs++;
      return 0;
    });
    await keys("l", "j"); // Q2 has one task: j crosses to the empty Q4
    expect(app.state.focus).toBe(4);
    const f = await edit();
    expect(f).toContain("Nothing selected");
    expect(runs).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("floating editor (S22)", () => {
  function events(taskId: number, type: string): number {
    const row = db.query("SELECT COUNT(*) AS n FROM events WHERE type = $type AND task_id = $id").get({ id: taskId, type }) as {
      n: number;
    };
    return row.n;
  }

  /** Hex of an OpenTUI RGBA. */
  const hex = (c: { toInts(): number[] }) =>
    `#${c
      .toInts()
      .slice(0, 3)
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")}`;

  function spanWith(text: string) {
    for (const line of setup.captureSpans().lines) {
      const span = line.spans.find((s) => s.text.includes(text));
      if (span) return span;
    }
    throw new Error(`"${text}" not in the frame`);
  }

  /** Presses `name` and waits for the editor session to settle. */
  async function run(...names: string[]): Promise<string> {
    for (const name of names) setup.mockInput.pressKey(name);
    await app.idle();
    return frame();
  }

  test("a in Q2 opens the editor in a PTY on a 0600 temp file and creates the task there with title, description, due date and tags", async () => {
    let seen = "";
    let mode = 0;
    const { launch, ptys } = fakeLauncher(async (pty) => {
      seen = await Bun.file(pty.path).text();
      mode = statSync(pty.path).mode & 0o777;
      await Bun.write(pty.path, "# Book flights #travel\ndue: 2026-12-01\n\nWindow seat #cheap\n");
      pty.exit(0);
    });
    await start(100, 30, { launchEditorPty: launch, env: { VISUAL: "nvim -u NONE", EDITOR: "vi" } });
    const before = repo.list({ status: "all" }).length;
    const f = await run("l", "a");
    const pty = ptys[0]!;
    expect(ptys).toHaveLength(1);
    expect(pty.cmd).toEqual(["nvim", "-u", "NONE"]);
    expect(dirname(pty.path)).toBe(tmpdir().replace(/\/$/, ""));
    expect(basename(pty.path)).toMatch(/^eisen-new-.+\.md$/);
    // The box is 70 x 20 at 100 x 30: the editor gets its inside.
    expect([pty.cols, pty.rows]).toEqual([68, 18]);
    expect(seen).toBe("# \ndue: \n\n");
    expect(mode).toBe(0o600);
    expect(existsSync(pty.path)).toBe(false);
    const task = byTitle("Book flights #travel")!;
    expect(bucketOf(task)).toBe(2);
    expect(task.description).toBe("Window seat #cheap");
    expect(task.dueDate).toBe("2026-12-01");
    expect(task.tags).toEqual(["travel", "cheap"]);
    expect(events(task.id, "created")).toBe(1);
    expect(repo.list({ status: "all" })).toHaveLength(before + 1);
    expect(f).toContain("Added to Q2 · 📅 Schedule");
    expect(f).toContain("Q2 · 📅 Schedule (2)");
    expect(f).not.toContain("New task ·");
    expect(app.state.focus).toBe(2);
    expect(app.state.selected[2]).toBe(1); // the new task, after Plan the trip
  });

  test("a with the Inbox strip focused creates the task in the Inbox", async () => {
    const { launch } = fakeLauncher(writes("# Call the plumber\n"));
    await start(100, 30, { launchEditorPty: launch });
    await keys("j", "j", "j", "j"); // Q1 (3 tasks) → Q3 (1 task) → the strip
    expect(app.state.focus).toBe("inbox");
    const f = await run("a");
    const task = byTitle("Call the plumber")!;
    expect(bucketOf(task)).toBe("inbox");
    expect(f).toContain("Added to 📥 Inbox");
    expect(f).toContain("📥 Inbox (3)");
    expect(app.state.focus).toBe("inbox");
  });

  test("an empty title creates nothing and says Cancelled", async () => {
    for (const text of ["# \ndue: \n\n", "", "#\n\nonly a description\n"]) {
      const { launch } = fakeLauncher(writes(text));
      await start(100, 30, { launchEditorPty: launch });
      const before = repo.list({ status: "all" }).length;
      const f = await run("a");
      expect(repo.list({ status: "all" })).toHaveLength(before);
      expect(statusOf(f)).toContain("Cancelled");
      app.destroy();
      await setup.dispose();
    }
  });

  test("a non-zero exit creates nothing and says so", async () => {
    const { launch } = fakeLauncher(writes("# Should not exist\n", 1));
    await start(100, 30, { launchEditorPty: launch });
    const f = await run("a");
    expect(byTitle("Should not exist")).toBeUndefined();
    expect(statusOf(f)).toContain("Editor exited with code 1");
  });

  test("a file that does not parse creates nothing and shows the error", async () => {
    const { launch } = fakeLauncher(writes("# Buy milk\ndue: soon\n"));
    await start(100, 30, { launchEditorPty: launch });
    const before = repo.list({ status: "all" }).length;
    const f = await run("a");
    expect(repo.list({ status: "all" })).toHaveLength(before);
    expect(statusOf(f)).toContain("Invalid due date");
    expect(statusOf(f)).toContain("nothing created");
  });

  test("e edits in the box: only what changed is saved, as one edited event, and a section tag stays", async () => {
    const payRent = byTitle("Pay rent")!;
    repo.update(payRent.id, { description: "Before the 5th", tags: ["todo"] });
    const editsBefore = events(payRent.id, "edited");
    let seen = "";
    const { launch, ptys } = fakeLauncher(async (pty) => {
      seen = await Bun.file(pty.path).text();
      await Bun.write(pty.path, "# Pay the rent #home\n\nBefore the 5th\n");
      pty.exit(0);
    });
    await start(100, 30, { launchEditorPty: launch });
    const f = await run("e");
    expect(seen).toBe("# Pay rent\n\nBefore the 5th\n");
    expect(basename(ptys[0]!.path)).toMatch(new RegExp(`^eisen-${payRent.id}-.+\\.md$`));
    expect(existsSync(ptys[0]!.path)).toBe(false);
    const task = repo.get(payRent.id)!;
    expect(task.title).toBe("Pay the rent #home");
    expect(task.description).toBe("Before the 5th");
    expect(task.tags).toEqual(["todo", "home"]);
    expect(events(payRent.id, "edited")).toBe(editsBefore + 1);
    expect(f).toContain("Saved");
    expect(app.state.selected[1]).toBe(0);
  });

  test("e: a non-zero exit or a parse error saves nothing", async () => {
    const id = byTitle("Pay rent")!.id;
    let { launch } = fakeLauncher(writes("# Changed\n", 2));
    await start(100, 30, { launchEditorPty: launch });
    let f = await run("e");
    expect(statusOf(f)).toContain("Editor exited with code 2");
    app.destroy();
    await setup.dispose();
    ({ launch } = fakeLauncher(writes("# Pay rent\ndue: someday\n")));
    await start(100, 30, { launchEditorPty: launch });
    f = await run("e");
    expect(statusOf(f)).toContain('Invalid due date "someday"');
    expect(repo.get(id)!.title).toBe("Pay rent");
    expect(repo.get(id)!.dueDate).toBeNull();
    expect(events(id, "edited")).toBe(0);
  });

  test("the box is drawn over the matrix, titled in the target's colour, with the editor's screen inside", async () => {
    const { launch, ptys } = fakeLauncher((pty) => pty.emit("\u001b[H# Hello from the editor"));
    await start(100, 30, { launchEditorPty: launch });
    await keys("l", "a");
    await Bun.sleep(10);
    let f = await frame();
    expect(f).toContain("New task · 📅 Schedule");
    expect(hex(spanWith("New task · 📅 Schedule").fg)).toBe(BUCKET_COLOR[2].toLowerCase());
    expect(f).toContain("# Hello from the editor");
    // Centred: the title's row is the box's top, 4 rows down at 100 x 30.
    expect(where(f, "New task · 📅 Schedule").row).toBe(4);
    expect(statusOf(f)).toContain("save and quit");
    ptys[0]!.exit(0);
    await app.idle();
    f = await frame();
    expect(f).not.toContain("New task ·");
    expect(f).not.toContain("Hello from the editor");
    expect(statusOf(f)).toContain("Cancelled");

    // e is titled with the task, in the colour of the pane it is shown in.
    const edit = fakeLauncher();
    app.destroy();
    await setup.dispose();
    await start(100, 30, { launchEditorPty: edit.launch });
    await keys("e");
    f = await frame();
    expect(f).toContain("Edit · Pay rent");
    expect(hex(spanWith("Edit · Pay rent").fg)).toBe(BUCKET_COLOR[1].toLowerCase());
    edit.ptys[0]!.exit(0);
    await app.idle();
  });

  test("every key goes to the editor while it is open: q, d, 1, x, Esc and Ctrl+C never reach the matrix", async () => {
    const { launch, ptys } = fakeLauncher();
    await start(100, 30, { launchEditorPty: launch });
    await keys("a");
    await Bun.sleep(10);
    for (const name of ["q", "d", "1", "x", "j"]) setup.mockInput.pressKey(name);
    setup.mockInput.pressKey("c", { ctrl: true });
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    setup.mockInput.pressEnter();
    await frame();
    const pty = ptys[0]!;
    expect(pty.typed).toContain("qd1xj");
    expect(pty.typed).toContain("\u0003");
    expect(pty.typed).toContain("\u001b");
    expect(pty.typed).toContain("\r");
    expect(await settles(app.done, 50)).toBe("stuck");
    expect(byTitle("Pay rent")!.status).toBe("open");
    expect(bucketOf(byTitle("Pay rent")!)).toBe(1);
    expect(app.state.mode).toBe("normal");
    expect(app.state.selected[1]).toBe(0);
    pty.exit(0);
    await app.idle();
    // Back to the matrix: keys act on it again.
    await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("done");
    expect(pty.typed).not.toContain("qd1xjx");
  });

  test("a resize while the editor is open resizes the box and the PTY", async () => {
    const { launch, ptys } = fakeLauncher();
    await start(100, 30, { launchEditorPty: launch });
    await keys("a");
    setup.resize(120, 40);
    let f = await frame();
    const pty = ptys[0]!;
    // 120 x 40: the box is 84 x 27, the editor 82 x 25.
    expect(pty.resizes.at(-1)).toEqual([82, 25]);
    expect(where(f, "New task · ✅ Do").row).toBe(6);
    setup.resize(60, 20);
    f = await frame();
    expect(pty.resizes.at(-1)).toEqual([40, 11]);
    expect(f).toContain("New task · ✅ Do");
    pty.exit(0);
    await app.idle();
  });

  test("when the PTY cannot start, the full-screen editor is used instead", async () => {
    const calls: string[] = [];
    await start(100, 30, {
      launchEditorPty: () => {
        calls.push("launch");
        throw new Error("PTY unsupported");
      },
      runEditor: async (path) => {
        calls.push("editor");
        await Bun.write(path, "# From the fallback\n");
        return 0;
      },
    });
    setup.renderer.suspend = async () => void calls.push("suspend");
    setup.renderer.resume = async () => void calls.push("resume");
    const f = await run("a");
    expect(calls).toEqual(["launch", "suspend", "editor", "resume"]);
    expect(bucketOf(byTitle("From the fallback")!)).toBe(1);
    expect(f).not.toContain("New task ·");
  });

  test("a terminal under 40 x 12 or EISEN_EDITOR_MODE=fullscreen uses the full-screen editor", async () => {
    for (const [width, height, env] of [
      [39, 30, {}],
      [100, 11, {}],
      [100, 30, { EISEN_EDITOR_MODE: "fullscreen" }],
    ] as const) {
      const { launch, ptys } = fakeLauncher();
      let runs = 0;
      await start(width, height, {
        launchEditorPty: launch,
        env,
        runEditor: async (path) => {
          runs++;
          await Bun.write(path, `# Full screen ${width}x${height}\n`);
          return 0;
        },
      });
      setup.renderer.suspend = async () => {};
      setup.renderer.resume = async () => {};
      await run("a");
      expect(ptys).toHaveLength(0);
      expect(runs).toBe(1);
      expect(byTitle(`Full screen ${width}x${height}`)).toBeDefined();
      app.destroy();
      await setup.dispose();
    }
  });

  test("startTui passes its environment on: EISEN_EDITOR_MODE=fullscreen there picks the full-screen editor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eisen-mode-"));
    try {
      setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
      setup.renderer.suspend = async () => {};
      setup.renderer.resume = async () => {};
      const { launch, ptys } = fakeLauncher();
      let ran = false;
      const run = startTui(
        repo,
        {
          today: () => TODAY,
          launchEditorPty: launch,
          runEditor: async (path) => {
            ran = true;
            await Bun.write(path, "# Via startTui\n");
            return 0;
          },
        },
        {
          createRenderer: async () => setup.renderer,
          env: { EISEN_CONFIG: join(dir, "config.json"), EISEN_EDITOR_MODE: "fullscreen" },
        },
      );
      await Bun.sleep(20);
      setup.mockInput.pressKey("a");
      for (let i = 0; i < 50 && !byTitle("Via startTui"); i++) await Bun.sleep(10);
      setup.mockInput.pressKey("q");
      expect(await settles(run, 2000)).toBe("done");
      expect(ran).toBe(true);
      expect(ptys).toHaveLength(0);
      expect(byTitle("Via startTui")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the hints and the help name a (new task in the editor) and A (quick add)", async () => {
    await start(140, 30);
    let f = await keys("j"); // clears the triage offer
    expect(statusOf(f)).toContain("a new · A quick add · e edit");
    f = await keys("?");
    expect(f).toContain("New task in $EDITOR, here or in the Inbox from its strip");
    expect(f).toContain("Quick add: type a title here (#tags work)");
  });

  test("destroying the app while the editor is open kills the editor and deletes the temp file", async () => {
    const { launch, ptys } = fakeLauncher();
    await start(100, 30, { launchEditorPty: launch });
    await keys("a");
    const pty = ptys[0]!;
    expect(existsSync(pty.path)).toBe(true);
    app.destroy();
    expect(await settles(app.idle())).toBe("done");
    expect(pty.killed).toBe(true);
    expect(existsSync(pty.path)).toBe(false);
    expect(repo.list({ status: "all" })).toHaveLength(8);
  });

  test("a failing reload after the editor closes is shown, and q still quits", async () => {
    const { launch, ptys } = fakeLauncher();
    await start(100, 30, { launchEditorPty: launch });
    await keys("a");
    const broken = breakList(repo);
    broken.failAlways();
    ptys[0]!.exit(0);
    await app.idle();
    const f = await frame();
    expect(statusOf(f)).toContain("Error: database is locked");
    setup.mockInput.pressKey("q");
    expect(await settles(app.done)).toBe("done");
  });

  test.skipIf(typeof Bun.Terminal !== "function")(
    "with a real PTY, a $EDITOR script that writes the file creates the task (skipped where Bun has no PTY)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "eisen-pty-"));
      try {
        const script = join(dir, "editor.sh");
        // Writes the task with its terminal size (rows cols: the box's inside) and exits.
        writeFileSync(script, '#!/bin/sh\nprintf "# From a real PTY #pty\\n\\nWritten by sh in %s\\n" "$(stty size)" > "$1"\nexit 0\n');
        chmodSync(script, 0o755);
        setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
        app = createMatrixApp(setup.renderer, repo, { today: () => TODAY, env: { ...process.env, VISUAL: "", EDITOR: script } });
        setup.mockInput.pressKey("l");
        setup.mockInput.pressKey("a");
        expect(await settles(app.idle(), 5000)).toBe("done");
        const task = byTitle("From a real PTY #pty")!;
        expect(task).toBeDefined();
        expect(bucketOf(task)).toBe(2);
        expect(task.description).toBe("Written by sh in 18 68"); // the 70 x 20 box at 100 x 30
        expect(task.tags).toEqual(["pty"]);
        const f = await frame();
        expect(f).toContain("Added to Q2 · 📅 Schedule");
        expect(f).not.toContain("New task ·");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("triage (S12) on the user's fixture", () => {
  const fixture = readFileSync(join(import.meta.dir, "../../fixtures/import/user-tasks.md"), "utf8");
  let inbox: { id: number; title: string; description: string | null }[];

  beforeEach(() => {
    // Only the fixture: 8 open tasks, all in the Inbox (S15).
    db.close();
    db = openDb(":memory:");
    repo = new TaskRepository(db);
    importMarkdown(repo, fixture);
    inbox = repo.list({ bucket: "inbox" });
    expect(inbox).toHaveLength(8);
  });

  function events(taskId: number, type: string): number {
    const row = db.query("SELECT COUNT(*) AS n FROM events WHERE type = $type AND task_id = $id").get({ id: taskId, type }) as {
      n: number;
    };
    return row.n;
  }

  async function escape(): Promise<string> {
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    return frame();
  }

  test("on start a non-empty Inbox is offered for triage, without entering it", async () => {
    const f = await start();
    expect(f).toContain("📥 Inbox (8)");
    expect(statusOf(f)).toContain("press i to triage");
    expect(statusOf(f)).not.toContain("Inbox:");
    expect(app.state.mode).toBe("normal");
    expect(f).toContain("Q1 · ✅ Do (0)");
  });

  test("an empty Inbox is not offered", async () => {
    for (const t of inbox) repo.move(t.id, 2);
    const f = await start();
    expect(f).not.toContain("press i to triage");
    expect(await keys("i")).toContain("Inbox is empty");
  });

  test("i shows a card for the first Inbox task with its description, tags and the key hints", async () => {
    await start(120, 30);
    const f = await keys("i");
    expect(app.state.mode).toBe("triage");
    expect(f).toContain("Triage 1/8");
    expect(f).toContain(inbox[0]!.title);
    expect(f).toContain("poder organizar los subitems");
    expect(f).toContain("#todo");
    expect(f).toContain("1 ✅ Do · 2 📅 Schedule · 3 🤝 Delegate · 4 🧹 Delete · s skip · e edit · d delete · Esc exit");
    // The card replaces the grid and the Inbox strip.
    expect(f).not.toContain("Q2 · 📅 Schedule");
    expect(f).not.toContain("📥 Inbox (");
  });

  test("2 moves the task to Q2 with a moved event and shows the next one", async () => {
    await start(120, 30);
    await keys("i");
    const f = await keys("2");
    const first = repo.get(inbox[0]!.id)!;
    expect(bucketOf(first)).toBe(2);
    expect(first.important).toBe(true);
    expect(first.urgent).toBe(false);
    expect(events(first.id, "moved")).toBe(1);
    expect(f).toContain("Triage 2/8");
    expect(f).toContain(inbox[1]!.title.slice(0, 40));
    expect(f).toContain("Moved to Q2 · 📅 Schedule");
  });

  test("s skips: the task stays in the Inbox and the next one is shown", async () => {
    await start(120, 30);
    const f = await keys("i", "s");
    expect(bucketOf(repo.get(inbox[0]!.id)!)).toBe("inbox");
    expect(events(inbox[0]!.id, "moved")).toBe(0);
    expect(f).toContain("Triage 2/8");
    expect(f).toContain(inbox[1]!.title.slice(0, 40));
  });

  test("d asks; n keeps the task on the card; d y deletes it and shows the next", async () => {
    await start(120, 30);
    const first = inbox[0]!;
    let f = await keys("i", "d");
    expect(f).toContain(`Delete "${first.title}"? y/n`);
    f = await keys("n");
    expect(app.state.mode).toBe("triage");
    expect(f).toContain("Triage 1/8");
    expect(repo.get(first.id)).not.toBeNull();
    f = await keys("d", "y");
    expect(repo.get(first.id)).toBeNull();
    expect(events(first.id, "deleted")).toBe(1);
    expect(app.state.mode).toBe("triage");
    expect(f).toContain("Triage 2/8");
    expect(repo.list({ bucket: "inbox" })).toHaveLength(7);
    expect(statusOf(f)).not.toContain("Inbox:");
  });

  test("Esc in the delete confirmation goes back to the card", async () => {
    await start(120, 30);
    await keys("i", "d");
    const f = await escape();
    expect(app.state.mode).toBe("triage");
    expect(f).toContain("Triage 1/8");
    expect(repo.list({ bucket: "inbox" })).toHaveLength(8);
  });

  test("e edits the current task in the floating editor (S22) and stays on its card", async () => {
    const first = inbox[0]!;
    let title = "";
    const { launch, ptys } = fakeLauncher(async (pty) => {
      title = (await frame()).split("\n").find((l) => l.includes("Edit ·")) ?? "";
      await Bun.write(pty.path, "# Organise subitems in Delivra #delivra\n\nGroup them by epic\n");
      pty.exit(0);
    });
    await start(120, 30, { launchEditorPty: launch });
    await keys("i");
    setup.mockInput.pressKey("e");
    await app.idle();
    const f = await frame();
    expect(ptys).toHaveLength(1);
    expect(title).toContain(`Edit · ${first.title}`);
    const task = repo.get(first.id)!;
    expect(task.title).toBe("Organise subitems in Delivra #delivra");
    expect(task.description).toBe("Group them by epic");
    expect(bucketOf(task)).toBe("inbox");
    expect(events(first.id, "edited")).toBe(1);
    expect(app.state.mode).toBe("triage");
    expect(f).toContain("Triage 1/8");
    expect(f).toContain("Organise subitems in Delivra #delivra");
    expect(f).toContain("Group them by epic");
    expect(f).toContain("Saved");
    // Triage carries on from the edited task.
    await keys("1");
    expect(bucketOf(repo.get(first.id)!)).toBe(1);
  });

  test("finishing the queue returns to the matrix with a summary", async () => {
    await start(120, 30);
    let f = await keys("i", "1", "2", "3", "4", "s", "2", "s");
    expect(f).toContain("Triage 8/8");
    f = await keys("1");
    expect(app.state.mode).toBe("normal");
    expect(f).toContain("Inbox triaged: 6 sorted, 2 skipped");
    expect(f).toContain("📥 Inbox (2)");
    expect(f).toContain("Q1 · ✅ Do (2)");
    expect(f).toContain("Q2 · 📅 Schedule (2)");
    expect(f).not.toContain("Triage 8/8");
    // The matrix works again and nothing quit.
    expect(await settles(app.done, 20)).toBe("stuck");
    await keys("x");
    expect(repo.list({ status: "all" }).filter((t) => t.status === "done").length).toBeGreaterThan(0);
  });

  test("Esc and q leave triage early without quitting", async () => {
    await start(120, 30);
    await keys("i", "2");
    let f = await escape();
    expect(app.state.mode).toBe("normal");
    expect(f).toContain("Triage stopped: 1 sorted, 0 skipped, 7 left in the Inbox");
    expect(f).toContain("Q2 · 📅 Schedule (1)");
    f = await keys("i");
    expect(f).toContain("Triage 1/7");
    f = await keys("q");
    expect(app.state.mode).toBe("normal");
    expect(await settles(app.done, 20)).toBe("stuck");
    // q in the matrix still quits.
    setup.mockInput.pressKey("q");
    expect(await settles(app.done)).toBe("done");
  });

  test("? shows the help over the card and Esc returns to it", async () => {
    await start(120, 30);
    let f = await keys("i", "?");
    expect(f).toContain("Toggle done");
    f = await escape();
    expect(app.state.mode).toBe("triage");
    expect(f).not.toContain("Toggle done");
    expect(f).toContain("Triage 1/8");
  });

  test("the card reflows on resize, including a 30×10 screen, and keys keep working", async () => {
    await start(120, 30);
    await keys("i");
    setup.resize(30, 10);
    let f = await frame();
    expect(f).toContain("Triage 1/8");
    expect(f).not.toContain("📥 Inbox ("); // the card still covers the strip
    for (const row of f.split("\n")) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(30);
    f = await keys("3");
    expect(bucketOf(repo.get(inbox[0]!.id)!)).toBe(3);
    expect(f).toContain("Triage 2/8");
    setup.resize(140, 40);
    f = await frame();
    expect(f).toContain("Triage 2/8");
    expect(f).toContain("1 ✅ Do · 2 📅 Schedule · 3 🤝 Delegate · 4 🧹 Delete · s skip · e edit · d delete · Esc exit");
  });

  test("starting triage on a 30×10 screen does not throw", async () => {
    await start(30, 10);
    const f = await keys("i");
    expect(f).toContain("Triage 1/8");
  });

  test("a failed move keeps the same card and shows the error", async () => {
    await start(120, 30);
    await keys("i");
    const move = repo.move.bind(repo);
    let fail = true;
    repo.move = (id, q) => {
      if (fail) {
        fail = false;
        throw new Error("database is locked");
      }
      return move(id, q);
    };
    let f = await keys("2");
    expect(f).toContain("Error: database is locked");
    expect(f).toContain("Triage 1/8");
    f = await keys("2");
    expect(bucketOf(repo.get(inbox[0]!.id)!)).toBe(2);
    expect(f).toContain("Triage 2/8");
  });

  test("Ctrl+C quits from triage even when every reload fails", async () => {
    await start(120, 30);
    await keys("i");
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("c", { ctrl: true });
    } catch {
      // A reload error escaping the key handler is the bug; the assertion reports it.
    }
    expect(await settles(app.done)).toBe("done");
  });

  test("q leaves triage and q again quits even when every reload fails", async () => {
    await start(120, 30);
    await keys("i");
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("q");
      setup.mockInput.pressKey("q");
    } catch {
      // See above.
    }
    expect(await settles(app.done)).toBe("done");
  });
});

describe("search (S19) on the user's fixture", () => {
  const fixture = readFileSync(join(import.meta.dir, "../../fixtures/import/user-tasks.md"), "utf8");
  const ZOHO = "test prod new activities integration for #zoho";
  const META = "provide new meta permissions";
  const DELIVRA = "en delivra montar los sigueintes features:";
  const API = "Create an epic to store the api calls";
  const CLOUDBEDS = "Create epic for cloudbeds new integration";
  const VACATIONS = "aporove #vacations request from #david";

  function find(prefix: string) {
    return repo.list({ status: "all" }).find((t) => t.title.startsWith(prefix))!;
  }

  beforeEach(() => {
    // The fixture spread over the matrix: zoho in Q1, meta (#rainer) in Q2,
    // delivra in Q3, the api-calls epic done in Q4; four stay in the Inbox,
    // among them cloudbeds ("Rainer" in its description) and vacations.
    db.close();
    db = openDb(":memory:");
    repo = new TaskRepository(db);
    importMarkdown(repo, fixture);
    repo.move(find(ZOHO).id, 1);
    repo.move(find(META).id, 2);
    repo.move(find(DELIVRA).id, 3);
    repo.move(find(API).id, 4);
    repo.toggleDone(find(API).id);
  });

  async function type(text: string): Promise<string> {
    await setup.mockInput.typeText(text);
    return frame();
  }

  async function escape(): Promise<string> {
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    return frame();
  }

  function statusLine(f: string): string {
    return f.trimEnd().split("\n").at(-1)!;
  }

  test("/ opens the input in the status line and filters the panes and the Inbox strip on every keystroke", async () => {
    let f = await start(120, 30);
    expect(f).toContain("📥 Inbox (4)"); // S24: the strip is there before any search
    f = await keys("/");
    expect(app.state.mode).toBe("search");
    expect(f).toContain("📥 Inbox (4)"); // the strip, unfiltered until something is typed
    f = await type("rai");
    expect(statusLine(f)).toContain("/ rai");
    expect(f).toContain(META);
    expect(f).toContain(CLOUDBEDS);
    expect(f).not.toContain(ZOHO);
    f = await type("ner");
    expect(statusLine(f)).toContain("/ rainer");
    expect(statusLine(f)).toContain("2 matches");
    // Each pane shows matches/total; the strip lists the Inbox matches.
    expect(f).toContain("Q1 · ✅ Do (0/1)");
    expect(f).toContain("Q2 · 📅 Schedule (1/1)");
    expect(f).toContain("Q3 · 🤝 Delegate (0/1)");
    expect(f).toContain("Q4 · 🧹 Delete (0/1)");
    expect(f).toContain("📥 Inbox (1/4)");
    expect(grid(f)).toContain(META);
    expect(where(f, CLOUDBEDS).row).toBeGreaterThan(where(f, "Q4 · 🧹 Delete").row);
    expect(grid(f)).not.toContain(VACATIONS);
    // Backspace widens it again, live.
    setup.mockInput.pressBackspace();
    setup.mockInput.pressBackspace();
    setup.mockInput.pressBackspace();
    f = await frame();
    expect(app.state.query).toBe("rai");
  });

  test("global keys typed into the search input do nothing but type", async () => {
    await start(120, 30);
    const before = JSON.stringify(repo.list({ status: "all" }));
    await keys("/");
    const f = await type("qxd1i.?ae");
    expect(app.state.query).toBe("qxd1i.?ae");
    expect(app.state.mode).toBe("search");
    expect(app.state.quit).toBe(false);
    expect(JSON.stringify(repo.list({ status: "all" }))).toBe(before);
    expect(f).not.toContain("Help");
  });

  test("a typo, an accent and an Inbox task are all found", async () => {
    await start(120, 30);
    await keys("/");
    let f = await type("delvira");
    expect(f).toContain("Q3 · 🤝 Delegate (1/1)");
    expect(grid(f)).toContain(DELIVRA);
    setup.mockInput.pressKey("u", { ctrl: true }); // ignored, not typed
    for (let i = 0; i < "delvira".length; i++) setup.mockInput.pressBackspace();
    f = await type("compañía");
    expect(grid(f)).toContain("cuando se elimina una compania");
    expect(f).toContain("📥 Inbox (1/4)");
  });

  test("Enter keeps the filter; 2 moves the selected Inbox match and the filter re-applies after the reload", async () => {
    await start(120, 30);
    await keys("/");
    await type("cloudbeds");
    // The only match is in the Inbox: the focus follows it there.
    expect(app.state.focus).toBe("inbox");
    setup.mockInput.pressEnter();
    let f = await frame();
    expect(app.state.mode).toBe("normal");
    expect(app.state.query).toBe("cloudbeds");
    f = await keys("2");
    expect(bucketOf(find(CLOUDBEDS))).toBe(2);
    expect(f).toContain("Moved to Q2 · 📅 Schedule");
    expect(f).toContain("Q2 · 📅 Schedule (1/2)");
    expect(f).toContain("📥 Inbox (0/3)");
    expect(grid(f)).not.toContain(META); // still filtered
    expect(app.state.query).toBe("cloudbeds");
  });

  test("after Enter, x and J act on the selected match and it stays visible", async () => {
    await start(120, 30);
    await keys("/");
    await type("zoho");
    setup.mockInput.pressEnter();
    await frame();
    expect(app.state.focus).toBe(1);
    let f = await keys("x");
    expect(find(ZOHO).status).toBe("done");
    expect(f).toContain("Done: ");
    // Search covers done tasks: the match stays, now with a ✓.
    const row = f.split("\n").find((line) => line.includes(ZOHO))!;
    expect(row).toContain("✓");
    f = await keys("x");
    expect(find(ZOHO).status).toBe("open");
  });

  test("j from a bottom pane enters the Inbox strip and d deletes the selected match there", async () => {
    await start(120, 30);
    await keys("/");
    await type("rainer");
    setup.mockInput.pressEnter();
    await frame();
    expect(app.state.focus).toBe(2);
    await keys("j", "j"); // Q2 → Q4 (no match) → Inbox strip
    expect(app.state.focus).toBe("inbox");
    let f = await keys("d");
    expect(f).toContain(`Delete "${CLOUDBEDS}"? y/n`);
    f = await keys("y");
    expect(repo.list({ status: "all" }).some((t) => t.title === CLOUDBEDS)).toBe(false);
    expect(f).toContain("📥 Inbox (0/3)");
  });

  test("a in the focused Inbox strip adds to the Inbox, and the new match shows up there", async () => {
    await start(120, 30);
    await keys("/");
    await type("cloudbeds");
    setup.mockInput.pressEnter();
    await frame();
    expect(app.state.focus).toBe("inbox");
    let f = await keys("A");
    expect(f).toContain("Add to 📥 Inbox:");
    await type("Ask cloudbeds for keys");
    setup.mockInput.pressEnter();
    f = await frame();
    const added = repo.list({ status: "all" }).find((t) => t.title === "Ask cloudbeds for keys")!;
    expect(bucketOf(added)).toBe("inbox");
    expect(f).toContain("Added to 📥 Inbox");
    expect(f).toContain("📥 Inbox (2/5)");
  });

  test("Esc clears the filter and restores the view; / again edits the query, prefilled", async () => {
    await start(120, 30);
    await keys("/");
    await type("zoho");
    setup.mockInput.pressEnter();
    let f = await frame();
    f = await keys("/");
    expect(statusLine(f)).toContain("/ zoho");
    expect(app.state.query).toBe("zoho");
    f = await type(" prod");
    expect(app.state.query).toBe("zoho prod");
    expect(f).toContain("Q1 · ✅ Do (1/1)");
    f = await escape();
    expect(app.state.mode).toBe("normal");
    expect(app.state.query).toBe("");
    expect(f).toContain("📥 Inbox (4)"); // S24: unfiltered again, still shown
    expect(f).toContain("Q1 · ✅ Do (1)");
    expect(f).toContain("Q2 · 📅 Schedule (1)");
    expect(f).toContain("Q4 · 🧹 Delete (0)");
    expect(grid(f)).toContain(META);
    expect(grid(f)).not.toContain(API); // done and hidden again
    // Esc after Enter also clears it.
    await keys("/");
    await type("zoho");
    setup.mockInput.pressEnter();
    await frame();
    f = await escape();
    expect(app.state.query).toBe("");
    expect(grid(f)).toContain(META);
  });

  test("done tasks appear dimmed with ✓ in their quadrant while the done panel is off", async () => {
    await start(120, 30);
    expect(app.state.donePanel).toBe(false);
    await keys("/");
    const f = await type("api calls");
    expect(f).toContain("Q4 · 🧹 Delete (1/1)");
    const row = f.split("\n").find((line) => line.includes(API))!;
    expect(row).toContain("✓");
    const spans = setup.captureSpans().lines.flatMap((l) => l.spans);
    const title = spans.find((s) => s.text.includes("Create an epic"))!;
    expect(title.attributes & TextAttributes.DIM).toBeTruthy();
  });

  test("no results says so, in the input and after Enter", async () => {
    await start(120, 30);
    await keys("/");
    let f = await type("xyzzy");
    expect(statusLine(f)).toContain('No matches for "xyzzy"');
    expect(f).toContain("Q1 · ✅ Do (0/1)");
    expect(f).toContain("📥 Inbox (0/4)");
    setup.mockInput.pressEnter();
    f = await frame();
    expect(statusLine(f)).toContain('No matches for "xyzzy"');
    expect(await keys("x")).toContain("Nothing selected");
  });

  test("the layout reflows on resize during a search, down to 30×10, and typing keeps working", async () => {
    await start(120, 30);
    await keys("/");
    await type("rainer");
    setup.resize(70, 18);
    let f = await frame();
    expect(f).toContain("📥 Inbox (1/4)");
    expect(statusLine(f)).toContain("rainer");
    expect(f).toContain("(1/1)");
    setup.resize(30, 10);
    f = await frame();
    expect(f.split("\n").every((line) => Bun.stringWidth(line) <= 30)).toBe(true);
    setup.resize(120, 30);
    setup.mockInput.pressBackspace();
    f = await frame();
    expect(app.state.query).toBe("raine");
    expect(f).toContain("📥 Inbox (1/4)");
  });

  test("q and Ctrl+C still quit while a search is kept and every reload fails", async () => {
    await start(120, 30);
    await keys("/");
    await type("zoho");
    setup.mockInput.pressEnter();
    await frame();
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("q");
    } catch {
      // See "repository failures".
    }
    expect(await settles(app.done)).toBe("done");
  });

  test("Ctrl+C quits from the search input even when every reload fails", async () => {
    await start(120, 30);
    await keys("/");
    await type("zo");
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("c", { ctrl: true });
    } catch {
      // See "repository failures".
    }
    expect(await settles(app.done)).toBe("done");
  });

  test("a failed reload while searching keeps the last results and shows the error", async () => {
    await start(120, 30);
    await keys("/");
    await type("zoho");
    setup.mockInput.pressEnter();
    await frame();
    breakList(repo).failNext();
    const f = await keys("x");
    expect(f).toContain("Error: database is locked");
    expect(grid(f)).toContain(ZOHO);
  });

  test("i triages the whole Inbox and returns to the kept filter", async () => {
    await start(120, 30);
    await keys("/");
    await type("rainer");
    setup.mockInput.pressEnter();
    await frame();
    let f = await keys("i");
    expect(app.state.mode).toBe("triage");
    expect(f).toContain("Triage 1/4"); // every open Inbox task, not only the matches
    f = await escape();
    expect(app.state.mode).toBe("normal");
    expect(app.state.query).toBe("rainer");
    expect(f).toContain("📥 Inbox (1/4)");
    expect(f).toContain("Q2 · 📅 Schedule (1/1)");
  });
});

describe("spawnEditor", () => {
  test("runs $VISUAL/$EDITOR split on whitespace with the file as last argument, and returns its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eisen-editor-"));
    try {
      const script = join(dir, "fake-editor.sh");
      writeFileSync(script, 'printf "%s|%s\\n" "$1" "$(cat "$2")" > "$2"\nexit 0\n');
      const file = join(dir, "task.md");
      writeFileSync(file, "# Old");
      expect(await spawnEditor(file, { VISUAL: `sh ${script} --flag`, EDITOR: "nope" })).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("--flag|# Old\n");
      expect(await spawnEditor(file, { EDITOR: "false" })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("presets and settings (S20, S21)", () => {
  let dir: string;
  let configEnv: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eisen-app-config-"));
    configEnv = { EISEN_CONFIG: join(dir, "config.json") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const save = (preset: "classic" | "priority" | "focus") => void saveConfig(configEnv, { preset });

  async function escape(): Promise<string> {
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    return frame();
  }

  test("the default titles are the classic emoji titles", async () => {
    const f = await start();
    for (const title of ["Q1 · ✅ Do (3)", "Q2 · 📅 Schedule (1)", "Q3 · 🤝 Delegate (1)", "Q4 · 🧹 Delete (1)"]) expect(f).toContain(title);
  });

  test("the preset option sets the titles", async () => {
    const f = await start(100, 30, { preset: "focus" });
    for (const title of ["Q1 · 🔥 Urgent (3)", "Q2 · ⭐ Important (1)", "Q3 · ⚡ Needs attention (1)", "Q4 · 🧊 Someday (1)"]) {
      expect(f).toContain(title);
    }
  });

  test(", lists the presets with their labels and marks the current one", async () => {
    await start(100, 30);
    const f = await keys(",");
    expect(app.state.mode).toBe("settings");
    expect(f).toContain("Settings");
    expect(f).toContain("› Classic · current");
    expect(f).toContain("Priority");
    expect(f).toContain("Focus");
    for (const label of ["1 🔴 Urgent & Important", "2 🟠 Not Urgent & Important", "3 ⚡ Needs attention", "4 🧊 Someday"]) {
      expect(f).toContain(label);
    }
    expect(f).toContain("j/k choose · Enter save · Esc cancel");
  });

  test(", → focus → Enter saves to the config file and changes the titles at once", async () => {
    await start(100, 30, { savePreset: save });
    await keys(",", "j", "j");
    expect(await frame()).toContain("› Focus");
    setup.mockInput.pressEnter();
    const f = await frame();
    expect(app.state.mode).toBe("normal");
    expect(app.state.preset).toBe("focus");
    for (const title of ["🔥 Urgent (3)", "⭐ Important (1)", "⚡ Needs attention (1)", "🧊 Someday (1)"]) expect(f).toContain(title);
    expect(f).not.toContain("✅ Do");
    expect(f).not.toContain("Settings");
    expect(readFileSync(configEnv.EISEN_CONFIG!, "utf8")).toContain('"preset": "focus"');
    expect(loadConfig(configEnv).config.preset).toBe("focus");
    // Messages use the new labels too.
    expect(await keys("2")).toContain("Moved to Q2 · ⭐ Important");
  });

  test("arrows choose too", async () => {
    await start(100, 30, { savePreset: save });
    await keys(",");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("up");
    await frame();
    setup.mockInput.pressEnter();
    expect(await frame()).toContain("Q1 · 🔴 Urgent & Important (3)");
  });

  test("Esc cancels: nothing is saved and the titles stay", async () => {
    let calls = 0;
    await start(100, 30, { savePreset: () => void calls++ });
    await keys(",", "j", "j");
    const f = await escape();
    expect(app.state.mode).toBe("normal");
    expect(app.state.preset).toBe("classic");
    expect(calls).toBe(0);
    expect(f).toContain("Q1 · ✅ Do (3)");
    expect(f).not.toContain("Settings");
  });

  test("keys in the settings never reach the matrix", async () => {
    await start(100, 30, { savePreset: save });
    await keys(",");
    for (const k of ["x", "d", "y", "1", "4", "a", "e", "i", "/", ".", "?", "q", "l", "h"]) setup.mockInput.pressKey(k);
    setup.mockInput.pressKey("J", { shift: true });
    await frame();
    expect(app.state.mode).toBe("settings");
    expect(await settles(app.done, 50)).toBe("stuck");
    const rent = byTitle("Pay rent")!;
    expect(rent.status).toBe("open");
    expect(bucketOf(rent)).toBe(1);
    expect(repo.list({ status: "all" })).toHaveLength(8);
    expect(app.state.focus).toBe(1);
    expect(app.state.donePanel).toBe(false);
    expect(existsSync(configEnv.EISEN_CONFIG!)).toBe(false);
  });

  test("a failed save shows the error and keeps the previous preset", async () => {
    await start(100, 30, {
      savePreset: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    await keys(",", "j", "j");
    setup.mockInput.pressEnter();
    const f = await frame();
    expect(app.state.preset).toBe("classic");
    expect(f).toContain("Error: EACCES: permission denied");
    expect(f).toContain("Q1 · ✅ Do (3)");
  });

  test("the help lists , and the active preset's quadrants", async () => {
    await start(100, 30, { preset: "focus" });
    const f = await keys("?");
    expect(f).toContain("Settings: quadrant names");
    expect(f).toContain("Send to 🔥 Urgent");
    expect(f).toContain("Send to 🧊 Someday");
  });

  test("the triage hints follow the preset", async () => {
    await start(120, 30, { preset: "focus" });
    const f = await keys("i");
    expect(f).toContain("1 🔥 Urgent · 2 ⭐ Important · 3 ⚡ Needs attention · 4 🧊 Someday");
  });

  test("the add prompt names the quadrant with the preset's label", async () => {
    await start(100, 30, { preset: "priority" });
    expect(await keys("A")).toContain("Add to Q1 · 🔴 Urgent & Important:");
  });

  test("narrow panes still fall back to Q1 (n) with long labels", async () => {
    await start(60, 16, { preset: "priority" });
    const f = await frame();
    for (const title of ["Q1 (3)", "Q2 (1)", "Q3 (1)", "Q4 (1)"]) expect(f).toContain(title);
    expect(f).not.toContain("Urgent");
  });

  test("a config warning passed in shows in the status line at start", async () => {
    const f = await start(120, 30, { warning: "Config: invalid JSON, using defaults (~/.config/eisen/config.json)" });
    expect(f).toContain("Config: invalid JSON, using defaults");
  });

  test("startTui reads the preset, and shows a config warning", async () => {
    writeFileSync(configEnv.EISEN_CONFIG!, '{"preset": "focus"}');
    setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
    let run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env: configEnv });
    await Bun.sleep(20);
    expect(await frame()).toContain("Q1 · 🔥 Urgent (3)");
    setup.mockInput.pressKey("q");
    await run;
    await setup.dispose();

    writeFileSync(configEnv.EISEN_CONFIG!, '{"preset": "fantasy"}');
    setup = await createTestRenderer({ width: 120, height: 30, exitOnCtrlC: false });
    run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env: configEnv });
    await Bun.sleep(20);
    const f = await frame();
    expect(f).toContain('unknown preset "fantasy"');
    expect(f).toContain("Q1 · ✅ Do (3)");
    setup.mockInput.pressKey("q");
    await run;
  });

  test("startTui saves the preset picked in the settings to the config file", async () => {
    // 120 columns: startTui turns the preview on (S25), and at 100 the sidebar leaves Q1 too narrow for this title.
    setup = await createTestRenderer({ width: 120, height: 30, exitOnCtrlC: false });
    const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env: configEnv });
    await Bun.sleep(20);
    await keys(",", "j");
    setup.mockInput.pressEnter();
    expect(await frame()).toContain("Q1 · 🔴 Urgent & Important (3)");
    setup.mockInput.pressKey("q");
    await run;
    expect(JSON.parse(readFileSync(configEnv.EISEN_CONFIG!, "utf8"))).toEqual({ preset: "priority" });
  });
});

describe("quadrant colours (S23)", () => {
  // Hex of an OpenTUI RGBA.
  const hex = (c: { toInts(): number[] }) =>
    `#${c
      .toInts()
      .slice(0, 3)
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")}`;
  const lower = (s: string) => s.toLowerCase();

  type Span = ReturnType<TestRendererSetup["captureSpans"]>["lines"][number]["spans"][number];

  // The span holding `text`, the span before it on its row, and the first span of the next row.
  function spanOf(text: string): { span: Span; before: Span | undefined; below: Span | undefined } {
    const { lines } = setup.captureSpans();
    for (let row = 0; row < lines.length; row++) {
      const spans = lines[row]!.spans;
      const i = spans.findIndex((s) => s.text.includes(text));
      if (i >= 0) return { span: spans[i]!, before: spans[i - 1], below: lines[row + 1]?.spans[0] };
    }
    throw new Error(`"${text}" not in the frame`);
  }

  const isBold = (s: Span) => (s.attributes & TextAttributes.BOLD) !== 0;

  test("the focused pane's border and title are in its colour, bold; the others dim with a tinted title", async () => {
    await start();
    const q1 = spanOf("Q1 · ✅ Do (3)");
    expect(hex(q1.span.fg)).toBe(lower(BUCKET_COLOR[1]));
    expect(isBold(q1.span)).toBe(true);
    expect(q1.before!.text).toContain("╭");
    expect(hex(q1.before!.fg)).toBe(lower(BUCKET_COLOR[1]));
    expect(q1.below!.text).toBe("│");
    expect(hex(q1.below!.fg)).toBe(lower(BUCKET_COLOR[1]));

    const q2 = spanOf("Q2 · 📅 Schedule (1)");
    expect(hex(q2.span.fg)).toBe(lower(BUCKET_COLOR[2]));
    expect(isBold(q2.span)).toBe(false);
    expect(q2.before!.text.endsWith("╭─")).toBe(true);
    expect(hex(q2.before!.fg)).toBe(lower(COLOR.border));

    const q3 = spanOf("Q3 · 🤝 Delegate (1)");
    expect(hex(q3.span.fg)).toBe(lower(BUCKET_COLOR[3]));
    expect(hex(q3.before!.fg)).toBe(lower(COLOR.border));
  });

  test("the selected row is highlighted with the focused pane's colour, and the colour follows the focus", async () => {
    await start();
    expect(hex(spanOf("Pay rent").span.bg)).toBe(lower(paneStyle(1, true).selectBg));
    await keys("l");
    const q2 = spanOf("Q2 · 📅 Schedule (1)");
    expect(isBold(q2.span)).toBe(true);
    expect(hex(q2.before!.fg)).toBe(lower(BUCKET_COLOR[2]));
    expect(hex(spanOf("Plan the trip").span.bg)).toBe(lower(paneStyle(2, true).selectBg));
    const q1 = spanOf("Q1 · ✅ Do (3)");
    expect(hex(q1.span.fg)).toBe(lower(BUCKET_COLOR[1]));
    expect(isBold(q1.span)).toBe(false);
    expect(hex(q1.before!.fg)).toBe(lower(COLOR.border));
  });

  test("the colours do not depend on the preset", async () => {
    await start(100, 30, { preset: "focus" });
    expect(hex(spanOf("Q1 · 🔥 Urgent (3)").span.fg)).toBe(lower(BUCKET_COLOR[1]));
    expect(hex(spanOf("Q4 · 🧊 Someday (1)").span.fg)).toBe(lower(BUCKET_COLOR[4]));
  });

  test("the search Inbox strip uses the Inbox colour", async () => {
    await start(100, 30);
    await keys("/");
    await setup.mockInput.typeText("idea");
    await frame();
    expect(app.state.focus).toBe("inbox"); // the only matches are in the Inbox
    const strip = spanOf("📥 Inbox (2/2)");
    expect(hex(strip.span.fg)).toBe(lower(BUCKET_COLOR.inbox));
    expect(isBold(strip.span)).toBe(true);
    expect(hex(strip.before!.fg)).toBe(lower(BUCKET_COLOR.inbox));
    expect(hex(spanOf("Unsorted idea").span.bg)).toBe(lower(paneStyle("inbox", true).selectBg));
  });

  test("the Inbox strip without a search: grey title, dim border; focused it is grey, bold, with a tinted row (S24)", async () => {
    await start(100, 30);
    let strip = spanOf("📥 Inbox (2)");
    expect(hex(strip.span.fg)).toBe(lower(BUCKET_COLOR.inbox));
    expect(isBold(strip.span)).toBe(false);
    expect(hex(strip.before!.fg)).toBe(lower(COLOR.border));
    await keys("j", "j", "j", "j"); // Q1 has 3 tasks, Q3 one: the fourth j enters the strip
    expect(app.state.focus).toBe("inbox");
    strip = spanOf("📥 Inbox (2)");
    expect(hex(strip.span.fg)).toBe(lower(BUCKET_COLOR.inbox));
    expect(isBold(strip.span)).toBe(true);
    expect(hex(strip.before!.fg)).toBe(lower(BUCKET_COLOR.inbox));
    expect(hex(spanOf("Unsorted idea").span.bg)).toBe(lower(paneStyle("inbox", true).selectBg));
    // Q3 is not focused any more.
    expect(isBold(spanOf("Q3 · 🤝 Delegate (1)").span)).toBe(false);
  });
});

describe("Inbox strip always visible (S24) on the user's fixture", () => {
  const fixture = readFileSync(join(import.meta.dir, "../../fixtures/import/user-tasks.md"), "utf8");
  let inbox: { id: number; title: string }[];

  beforeEach(() => {
    // Only the fixture: 8 open tasks, all in the Inbox (S15).
    db.close();
    db = openDb(":memory:");
    repo = new TaskRepository(db);
    importMarkdown(repo, fixture);
    inbox = repo.list({ bucket: "inbox" });
    expect(inbox).toHaveLength(8);
  });

  function events(taskId: number, type: string): number {
    const row = db.query("SELECT COUNT(*) AS n FROM events WHERE type = $type AND task_id = $id").get({ id: taskId, type }) as {
      n: number;
    };
    return row.n;
  }

  /** Short prefix of the i-th Inbox task's title, safe from truncation. */
  const title = (i: number) => inbox[i]!.title.slice(0, 30);

  /** Focus the strip from the start: Q1 and Q3 are empty, so j j. */
  async function enterStrip(): Promise<string> {
    const f = await keys("j", "j");
    expect(app.state.focus).toBe("inbox");
    return f;
  }

  async function escape(): Promise<string> {
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    return frame();
  }

  test("at 120×30 the strip lists the Inbox under the grid: 7 rows, titled with the open count, scrolling", async () => {
    const f = await start(120, 30);
    const strip = where(f, "📥 Inbox (8)");
    expect(strip.row).toBe(30 - 1 - 7);
    expect(strip.row).toBeGreaterThan(where(f, "Q3 · 🤝 Delegate (0)").row);
    // 5 rows inside the border; the rest scrolls.
    for (let i = 0; i < 5; i++) expect(where(f, title(i)).row).toBe(strip.row + 1 + i);
    expect(f).not.toContain(title(5));
    expect(f).toContain("1-5 of 8");
    expect(statusOf(f)).toContain("press i to triage");
    expect(statusOf(f)).not.toContain("Inbox");
    await enterStrip();
    for (let i = 0; i < 7; i++) setup.mockInput.pressKey("j");
    const g = await frame();
    expect(app.state.selected.inbox).toBe(7);
    expect(g).toContain(title(7));
    expect(g).toContain("4-8 of 8");
  });

  test("at 60×16 and 30×10 the strip keeps 3 rows and the grid its four panes", async () => {
    let f = await start(60, 16);
    expect(where(f, "📥 Inbox (8)").row).toBe(16 - 1 - 3);
    expect(where(f, title(0)).row).toBe(16 - 1 - 3 + 1);
    expect(f).toContain("1-1 of 8");
    for (const t of ["Q1 · ✅ Do (0)", "Q2 · 📅 Schedule (0)", "Q3 · 🤝 Delegate (0)", "Q4 · 🧹 Delete (0)"]) {
      expect(f).toContain(t);
    }
    setup.resize(30, 10);
    f = await frame();
    expect(where(f, "📥 Inbox (8)").row).toBe(10 - 1 - 3);
    for (const t of ["Q1 (0)", "Q2 (0)", "Q3 (0)", "Q4 (0)"]) expect(f).toContain(t);
    for (const row of f.split("\n")) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(30);
  });

  test("on a tiny screen the strip is one title line and the grid keeps its rows; nothing throws from 1×1 to 300×100", async () => {
    let f = await start(30, 8);
    const rows = f.split("\n");
    expect(rows[8 - 1 - 1]).toContain("📥 Inbox (8)");
    expect(f).not.toContain(title(0));
    for (const t of ["Q1 (0)", "Q3 (0)"]) expect(f).toContain(t);
    for (const [w, h] of [
      [1, 1],
      [2, 2],
      [1, 30],
      [300, 1],
      [12, 3],
      [20, 9],
      [300, 100],
      [30, 8],
    ] as const) {
      setup.resize(w, h);
      f = await frame();
      for (const row of f.split("\n")) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(w);
    }
    // With no rows left for the grid, its borders do not spill over the strip's line.
    setup.resize(50, 2);
    f = await frame();
    expect(f.split("\n")[0]!.trim()).toBe("📥 Inbox (8)");
    setup.resize(30, 8);
    await frame();
    // Focused, the one-line strip still takes the keys.
    await enterStrip();
    f = await keys("x");
    expect(repo.get(inbox[0]!.id)!.status).toBe("done");
    expect(f.split("\n")[8 - 1 - 1]).toContain("📥 Inbox (7)");
    setup.resize(300, 100);
    f = await frame();
    const strip = where(f, "📥 Inbox (7)");
    expect(strip.row).toBe(100 - 1 - 8);
    for (let i = 1; i < 7; i++) expect(f).toContain(title(i));
  });

  test("j j reaches the strip; 2 sorts the selected task into Q2 with one moved event and the count drops", async () => {
    await start(120, 30);
    await enterStrip();
    expect(app.state.selected.inbox).toBe(0);
    const f = await keys("2");
    const first = repo.get(inbox[0]!.id)!;
    expect(bucketOf(first)).toBe(2);
    expect(events(first.id, "moved")).toBe(1);
    expect(f).toContain("Moved to Q2 · 📅 Schedule");
    expect(f).toContain("📥 Inbox (7)");
    expect(f).toContain("Q2 · 📅 Schedule (1)");
    expect(where(f, title(0)).row).toBeLessThan(where(f, "📥 Inbox (7)").row); // now in the grid
    // The focus stays on the strip, on the next task.
    expect(app.state.focus).toBe("inbox");
    expect(app.state.selected.inbox).toBe(0);
    await keys("3");
    expect(bucketOf(repo.get(inbox[1]!.id)!)).toBe(3);
  });

  test("sorting the last row of the strip clamps the selection to the new last row", async () => {
    await start(120, 30);
    await enterStrip();
    for (let i = 0; i < 7; i++) setup.mockInput.pressKey("j");
    await keys("4");
    expect(bucketOf(repo.get(inbox[7]!.id)!)).toBe(4);
    expect(app.state.selected.inbox).toBe(6);
    await keys("1");
    expect(bucketOf(repo.get(inbox[6]!.id)!)).toBe(1);
  });

  test("x marks the selected Inbox task done; . shows it in the done panel, not the strip; x there reopens it", async () => {
    await start(120, 30);
    await enterStrip();
    for (let i = 0; i < 7; i++) setup.mockInput.pressKey("j");
    let f = await keys("x");
    const last = inbox[7]!;
    expect(repo.get(last.id)!.status).toBe("done");
    expect(f).toContain(`Done: ${last.title.slice(0, 30)}`);
    expect(f).toContain("📥 Inbox (7)");
    expect(grid(f)).not.toContain(title(7));
    f = await keys(".");
    const row = f.split("\n").find((line) => line.includes(title(7)))!;
    expect(row).toContain("✓");
    expect(f).toContain("📥 Inbox (7)"); // the count is of open tasks
    expect(f).toContain("✓ Done (1)");
    expect(where(f, title(7)).row).toBeLessThan(where(f, "📥 Inbox (7)").row); // in the sidebar, not the strip
    // Up out of the strip to the bottom pane it came from, then right into the panel (via Q4).
    for (let i = 0; i < 20 && app.state.focus === "inbox"; i++) await keys("k");
    await keys("l", "l");
    expect(app.state.focus).toBe("done");
    f = await keys("x");
    expect(repo.get(last.id)!.status).toBe("open");
    expect(f).toContain("📥 Inbox (8)");
  });

  test("d asks; y deletes the selected Inbox task", async () => {
    await start(120, 30);
    await enterStrip();
    let f = await keys("j", "d");
    expect(statusOf(f)).toContain(`Delete "${inbox[1]!.title.slice(0, 60)}`);
    f = await keys("y");
    expect(repo.get(inbox[1]!.id)).toBeNull();
    expect(events(inbox[1]!.id, "deleted")).toBe(1);
    expect(f).toContain("📥 Inbox (7)");
    expect(app.state.focus).toBe("inbox");
  });

  test("A with the strip focused adds to the Inbox and selects the new task; A in a quadrant still adds there", async () => {
    await start(120, 30);
    await enterStrip();
    let f = await keys("A");
    expect(f).toContain("Add to 📥 Inbox:");
    await setup.mockInput.typeText("Book the dentist #health");
    setup.mockInput.pressEnter();
    f = await frame();
    const added = byTitle("Book the dentist #health")!;
    expect(bucketOf(added)).toBe("inbox");
    expect(added.tags).toEqual(["health"]);
    expect(f).toContain("Added to 📥 Inbox");
    expect(f).toContain("📥 Inbox (9)");
    expect(f).toContain("Book the dentist #health");
    expect(app.state.focus).toBe("inbox");
    expect(app.state.selected.inbox).toBe(8);
    // From Q4 it goes to Q4: 8 k walk up the strip, the 9th leaves it for Q3.
    for (let i = 0; i < 9; i++) setup.mockInput.pressKey("k");
    await keys("l", "A");
    expect(app.state.focus).toBe(4);
    await setup.mockInput.typeText("Clean the desk");
    setup.mockInput.pressEnter();
    await frame();
    expect(bucketOf(byTitle("Clean the desk")!)).toBe(4);
  });

  test("e edits the selected Inbox task in the floating editor, and it stays in the Inbox", async () => {
    const { launch } = fakeLauncher(writes("# Organise subitems in Delivra\n\nGroup them by epic\n"));
    await start(120, 30, { launchEditorPty: launch });
    await enterStrip();
    setup.mockInput.pressKey("e");
    await app.idle();
    const f = await frame();
    const task = repo.get(inbox[0]!.id)!;
    expect(task.title).toBe("Organise subitems in Delivra");
    expect(bucketOf(task)).toBe("inbox");
    expect(events(task.id, "edited")).toBe(1);
    expect(f).toContain("Saved");
    expect(f).toContain("Organise subitems in Delivra");
    expect(app.state.focus).toBe("inbox");
  });

  test("J/K reorder inside the Inbox and the selection follows the task", async () => {
    await start(120, 30);
    await enterStrip();
    setup.mockInput.pressKey("J", { shift: true });
    let f = await frame();
    expect(repo.list({ bucket: "inbox" }).map((t) => t.id).slice(0, 2)).toEqual([inbox[1]!.id, inbox[0]!.id]);
    expect(app.state.selected.inbox).toBe(1);
    expect(where(f, title(1)).row).toBeLessThan(where(f, title(0)).row);
    setup.mockInput.pressKey("K", { shift: true });
    f = await frame();
    expect(repo.list({ bucket: "inbox" }).map((t) => t.id).slice(0, 2)).toEqual([inbox[0]!.id, inbox[1]!.id]);
    expect(app.state.selected.inbox).toBe(0);
  });

  test("k at the top goes back to the pane the strip was entered from; h/l keep the strip", async () => {
    await start(120, 30);
    await keys("j", "l", "j"); // Q1 → Q3 → Q4 → strip
    expect(app.state.focus).toBe("inbox");
    await keys("h", "l");
    expect(app.state.focus).toBe("inbox");
    await keys("k");
    expect(app.state.focus).toBe(4);
    await keys("h", "j", "k");
    expect(app.state.focus).toBe(3);
  });

  test("a resize keeps the strip, its focus and its selection", async () => {
    await start(120, 30);
    await enterStrip();
    await keys("j");
    setup.resize(60, 16);
    let f = await frame();
    expect(app.state.focus).toBe("inbox");
    expect(app.state.selected.inbox).toBe(1);
    expect(f).toContain("📥 Inbox (8)");
    expect(f).toContain(inbox[1]!.title.slice(0, 20));
    setup.resize(120, 30);
    f = await keys("2");
    expect(bucketOf(repo.get(inbox[1]!.id)!)).toBe(2);
    expect(f).toContain("📥 Inbox (7)");
  });

  test("search still filters the strip; Esc restores it with the focus and the match kept", async () => {
    await start(120, 30);
    await keys("/");
    await setup.mockInput.typeText("cloudbeds");
    let f = await frame();
    expect(f).toContain("📥 Inbox (1/8)");
    expect(app.state.focus).toBe("inbox");
    setup.mockInput.pressEnter();
    await frame();
    f = await escape();
    expect(app.state.query).toBe("");
    expect(f).toContain("📥 Inbox (8)");
    expect(app.state.focus).toBe("inbox");
    const cloudbeds = inbox.findIndex((t) => t.title.includes("cloudbeds"));
    expect(app.state.selected.inbox).toBe(cloudbeds);
  });

  test("triage covers the grid and the strip and still sorts; Esc shows the strip with the new count", async () => {
    await start(120, 30);
    await enterStrip();
    let f = await keys("i");
    expect(f).toContain("Triage 1/8");
    expect(f).not.toContain("📥 Inbox (");
    expect(statusOf(f)).not.toContain("Inbox:");
    await keys("2");
    expect(bucketOf(repo.get(inbox[0]!.id)!)).toBe(2);
    expect(events(inbox[0]!.id, "moved")).toBe(1);
    f = await escape();
    expect(app.state.mode).toBe("normal");
    expect(f).toContain("📥 Inbox (7)");
    expect(f).toContain("Triage stopped");
  });

  test("the help names the strip, and closing it leaves no Inbox count in the status line", async () => {
    await start(120, 30);
    let f = await keys("?");
    expect(f).toContain("Inbox strip");
    expect(statusOf(f)).not.toContain("Inbox:");
    f = await escape();
    expect(f).not.toContain("Inbox strip");
  });

  test("q quits from the focused strip even when every reload fails", async () => {
    await start(120, 30);
    await enterStrip();
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("q");
    } catch {
      // See "repository failures".
    }
    expect(await settles(app.done)).toBe("done");
  });

  test("Ctrl+C quits from the focused strip even when every reload fails", async () => {
    await start(120, 30);
    await enterStrip();
    breakList(repo).failAlways();
    try {
      setup.mockInput.pressKey("c", { ctrl: true });
    } catch {
      // See above.
    }
    expect(await settles(app.done)).toBe("done");
  });
});

describe("rebindable keys (S30)", () => {
  let dir: string;
  let configEnv: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eisen-app-keys-"));
    configEnv = { EISEN_CONFIG: join(dir, "config.json") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The help row that holds `text`.
  function helpRow(f: string, text: string): string {
    return f.split("\n").find((line) => line.includes(text)) ?? "";
  }

  test("toggle_done on space: space marks done, x does nothing, help and hints show space", async () => {
    await start(140, 30, { keys: { toggle_done: ["space"] } });
    let f = await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("open");
    f = await keys(" ");
    expect(byTitle("Pay rent")!.status).toBe("done");
    f = await keys("j", "k");
    expect(statusOf(f)).toContain("space done");
    expect(statusOf(f)).not.toContain("x done");
    f = await keys("?");
    expect(helpRow(f, "Toggle done")).toContain("space");
    expect(helpRow(f, "Toggle done")).not.toMatch(/\bx\b/);
  });

  test("triage keys come from the keymap, and the card's hints show them", async () => {
    await start(140, 30, { keys: { "triage.skip": ["n"], "triage.send_q2": ["w"] } });
    const f = await keys("i");
    expect(f).toContain("n skip");
    expect(f).toContain("w 📅 Schedule");
    expect(f).not.toContain("s skip");
    await keys("s");
    expect(app.state.triage?.index).toBe(0);
    await keys("w");
    expect(app.state.triage?.sorted).toBe(1);
    await keys("n");
    expect(app.state.triage).toBeNull();
  });

  test("bad overrides are ignored and warned in the status line: the first one plus (+N more)", async () => {
    const f = await start(140, 30, { keys: { fly: ["f"], toggle_done: ["d"], quit: [] } });
    expect(statusOf(f)).toContain("Config: keys.fly is not an action, ignored (+2 more)");
    await keys("q");
    expect(app.state.quit).toBe(true);
  });

  test("a single warning shows without a count; the config warning comes first", async () => {
    const f = await start(140, 30, { warning: "Config: invalid JSON, using defaults", keys: { fly: ["f"] } });
    expect(statusOf(f)).toContain("Config: invalid JSON, using defaults (+1 more)");
    app.destroy();
    await setup.dispose();
    const g = await start(140, 30, { keys: { fly: ["f"] } });
    expect(statusOf(g)).toContain("Config: keys.fly is not an action, ignored");
    expect(statusOf(g)).not.toContain("more)");
  });

  test("startTui reads the key overrides from the config file", async () => {
    writeFileSync(configEnv.EISEN_CONFIG!, '{"keys": {"toggle_done": ["space"], "__proto__": ["x"]}}');
    setup = await createTestRenderer({ width: 140, height: 30, exitOnCtrlC: false });
    const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env: configEnv });
    await Bun.sleep(20);
    expect(statusOf(await frame())).toContain("Config: keys.__proto__ is not an action, ignored");
    await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("open");
    await keys(" ");
    expect(byTitle("Pay rent")!.status).toBe("done");
    setup.mockInput.pressKey("q");
    await run;
  });

  test("startTui warns about a keys section that is not an object", async () => {
    writeFileSync(configEnv.EISEN_CONFIG!, '{"keys": ["x"]}');
    setup = await createTestRenderer({ width: 140, height: 30, exitOnCtrlC: false });
    const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env: configEnv });
    await Bun.sleep(20);
    expect(statusOf(await frame())).toContain("Config: keys is not an object");
    setup.mockInput.pressKey("q");
    await run;
  });
});

// Hex of an OpenTUI RGBA, lowercase.
const hexOf = (c: { toInts(): number[] }) =>
  `#${c
    .toInts()
    .slice(0, 3)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;

// The span right before the one holding `title` on its row: the row's mark.
function markOf(title: string) {
  for (const line of setup.captureSpans().lines) {
    const i = line.spans.findIndex((s) => s.text.includes(title));
    if (i > 0) return line.spans[i - 1]!;
  }
  throw new Error(`"${title}" not in the frame`);
}

describe("done panel in the sidebar (S26, S27)", () => {
  let saved: Record<string, unknown>[];

  beforeEach(() => {
    saved = [];
    // One second per repository write, from noon UTC: completion order is deterministic.
    let t = Date.parse("2026-11-12T12:00:00Z");
    repo = new TaskRepository(db, () => new Date((t += 1000)));
    repo.toggleDone(byTitle("Watch TV")!.id);
  });

  function open(width = 140, height = 40, over: AppOptions = {}) {
    return start(width, height, { view: { donePanel: true }, saveView: (patch) => void saved.push(patch), ...over });
  }

  // The row holding `text`, from the done panel's left border on.
  function panelRow(f: string, text: string): string {
    const col = where(f, "✓ Done").col;
    return f.split("\n").find((line) => line.includes(text))!.slice(col - 2);
  }

  test("at 140×40 the done panel is a right sidebar titled ✓ Done (n), the grid and the strip to its left", async () => {
    const f = await open();
    expect(f).toContain("✓ Done (1)");
    const panel = where(f, "✓ Done (1)");
    expect(panel.row).toBe(where(f, "Q1 · ✅ Do").row);
    expect(panel.col).toBeGreaterThan(where(f, "Q2 · 📅 Schedule").col);
    expect(where(f, "Watch TV").col).toBeGreaterThan(panel.col - 2);
    expect(f).toContain("Q4 · 🧹 Delete (0)");
    // The sidebar runs the full height above the status line; the strip stops at its left.
    expect(where(f, "📥 Inbox (2)").col).toBeLessThan(panel.col);
    const last = grid(f).split("\n").at(-1)!.trimEnd();
    expect(last.endsWith("╯")).toBe(true);
    expect((last.match(/╰/g) ?? []).length).toBe(2); // the strip's corner and the panel's
  });

  test("done panel off (the default here): no sidebar, the done task is not in the grid", async () => {
    const f = await start(140, 40);
    expect(f).not.toContain("✓ Done");
    expect(grid(f)).not.toContain("Watch TV");
  });

  test("x on a Q1 task removes it from Q1 and puts it at the top of the panel", async () => {
    await open();
    const f = await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("done");
    expect(f).toContain("Q1 · ✅ Do (2)");
    expect(f).toContain("✓ Done (2)");
    const panel = where(f, "✓ Done (2)");
    expect(where(f, "Pay rent").col).toBeGreaterThan(panel.col - 2);
    expect(where(f, "Pay rent").row).toBe(panel.row + 1);
    expect(where(f, "Watch TV").row).toBe(panel.row + 2);
  });

  test("x in the panel reopens the task back in Q1", async () => {
    repo.toggleDone(byTitle("Pay rent")!.id);
    let f = await open();
    expect(f).toContain("Q1 · ✅ Do (2)");
    await keys("l", "l");
    expect(app.state.focus).toBe("done");
    f = await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("open");
    expect(f).toContain("Reopened: Pay rent");
    expect(f).toContain("Q1 · ✅ Do (3)");
    expect(f).toContain("✓ Done (1)");
    expect(where(f, "Pay rent").col).toBeLessThan(where(f, "Q2 · 📅 Schedule").col);
    // The focus stays in the panel, on what is left there; h goes back to Q2.
    expect(app.state.focus).toBe("done");
    await keys("h");
    expect(app.state.focus).toBe(2);
  });

  test("rows: ✓ in the task's quadrant colour (Inbox grey), the title, MM-DD on the right", async () => {
    repo.toggleDone(byTitle("Unsorted idea")!.id);
    const f = await open();
    const day = (iso: string) => {
      const d = new Date(iso);
      return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const tv = byTitle("Watch TV")!;
    const row = panelRow(f, "Watch TV");
    expect(row).toContain("✓ Watch TV");
    expect(row.trimEnd().replace(/│$/, "").trimEnd().endsWith(day(tv.completedAt!))).toBe(true);
    expect(markOf("Watch TV").text).toBe("✓ ");
    expect(hexOf(markOf("Watch TV").fg)).toBe(BUCKET_COLOR[4].toLowerCase());
    expect(hexOf(markOf("Unsorted idea").fg)).toBe(BUCKET_COLOR.inbox.toLowerCase());
  });

  test("J/K in the panel say the order is by completion; 1 moves the task, still done; d deletes after y", async () => {
    repo.toggleDone(byTitle("Plan the trip")!.id);
    await open();
    await keys("l", "l");
    setup.mockInput.pressKey("J", { shift: true });
    let f = await frame();
    expect(statusOf(f)).toContain("Done tasks are ordered by completion");
    f = await keys("1");
    const trip = byTitle("Plan the trip")!;
    expect(bucketOf(trip)).toBe(1);
    expect(trip.status).toBe("done");
    expect(f).toContain("✓ Done (2)");
    f = await keys("d");
    expect(f).toContain('Delete "Plan the trip"? y/n');
    f = await keys("y");
    expect(byTitle("Plan the trip")).toBeUndefined();
    expect(f).toContain("✓ Done (1)");
  });

  test("a search with a done match lists it only in the panel, matches/total in its title", async () => {
    await open();
    await keys("/");
    await setup.mockInput.typeText("watch");
    const f = await frame();
    expect(f).toContain("✓ Done (1/1)");
    expect(f).toContain("Q4 · 🧹 Delete (0/0)");
    expect(f.split("\n").filter((line) => line.includes("Watch TV"))).toHaveLength(1);
    expect(where(f, "Watch TV").col).toBeGreaterThan(where(f, "✓ Done").col - 2);
    // The keys act on the match in the panel.
    expect(app.state.focus).toBe("done");
  });

  test("with the panel on but the sidebar hidden (under 100 columns), done matches show in their quadrant with ✓", async () => {
    await open(90, 30);
    await keys("/");
    await setup.mockInput.typeText("watch");
    const f = await frame();
    expect(f).not.toContain("✓ Done");
    expect(f).toContain("Q4 · 🧹 Delete (1/1)");
    expect(f.split("\n").find((line) => line.includes("Watch TV"))!).toContain("✓");
  });

  test("under 100 columns the sidebar hides once with a message, focus returns, and it comes back on resize", async () => {
    await open(140, 40);
    await keys("l", "l");
    expect(app.state.focus).toBe("done");
    setup.resize(90, 30);
    let f = await frame();
    expect(f).not.toContain("✓ Done");
    expect(statusOf(f)).toContain("Sidebar hidden: needs 100 columns");
    expect(app.state.focus).toBe(2);
    f = await keys("j");
    expect(statusOf(f)).not.toContain("Sidebar hidden");
    setup.resize(95, 30);
    f = await frame();
    expect(statusOf(f)).not.toContain("Sidebar hidden");
    setup.resize(140, 40);
    f = await frame();
    expect(f).toContain("✓ Done (1)");
  });

  test(". toggles the panel and persists donePanel through the injected saver, never with undefined fields", async () => {
    let f = await open(140, 40, { view: { donePanel: false } });
    expect(f).not.toContain("✓ Done");
    f = await keys(".");
    expect(f).toContain("✓ Done (1)");
    expect(statusOf(f)).toContain("Done panel on");
    f = await keys(".");
    expect(f).not.toContain("✓ Done");
    expect(saved).toEqual([{ donePanel: true }, { donePanel: false }]);
    for (const patch of saved) expect(Object.values(patch)).not.toContain(undefined);
  });

  test(". under 100 columns still toggles and saves, and says the sidebar is hidden", async () => {
    await open(90, 30, { view: { donePanel: false } });
    const f = await keys(".");
    expect(app.state.donePanel).toBe(true);
    expect(saved).toEqual([{ donePanel: true }]);
    expect(statusOf(f)).toContain("Sidebar hidden: needs 100 columns");
  });

  test("a save error shows in the status line and the session keeps the new value", async () => {
    await open(140, 40, {
      view: { donePanel: false },
      saveView: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const f = await keys(".");
    expect(statusOf(f)).toContain("EACCES: permission denied");
    expect(f).toContain("✓ Done (1)");
    expect(app.state.donePanel).toBe(true);
  });

  test("the help and the hints describe . as the done panel", async () => {
    await open();
    let f = await keys("j"); // past the start-up triage offer
    expect(statusOf(f)).toContain(". done panel");
    f = await keys("?");
    expect(f).toContain("Show / hide the done panel");
    expect(f).not.toContain("Show / hide done tasks");
  });

  describe("startTui (S29)", () => {
    let dir: string;
    let env: Record<string, string>;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "eisen-view-"));
      env = { EISEN_CONFIG: join(dir, "config.json") };
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("reads view.donePanel and bullets from the config; . saves donePanel there, other keys kept", async () => {
      writeFileSync(env.EISEN_CONFIG!, '{"preset": "classic", "view": {"donePanel": true, "bullets": false}, "extra": 1}');
      setup = await createTestRenderer({ width: 140, height: 40, exitOnCtrlC: false });
      const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env });
      await Bun.sleep(20);
      let f = await frame();
      expect(f).toContain("✓ Done (1)");
      expect(f.split("\n").find((line) => line.includes("Call the bank"))!).toContain("  Call the bank");
      f = await keys(".");
      expect(f).not.toContain("✓ Done");
      setup.mockInput.pressKey("q");
      await run;
      expect(JSON.parse(readFileSync(env.EISEN_CONFIG!, "utf8"))).toEqual({
        preset: "classic",
        view: { donePanel: false, bullets: false },
        extra: 1,
      });
    });

    test("defaults with no file: done panel off, bullets on, nothing written", async () => {
      setup = await createTestRenderer({ width: 140, height: 40, exitOnCtrlC: false });
      const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env });
      await Bun.sleep(20);
      const f = await frame();
      expect(f).not.toContain("✓ Done");
      expect(f).toContain("• Call the bank");
      setup.mockInput.pressKey("q");
      await run;
      expect(existsSync(env.EISEN_CONFIG!)).toBe(false);
    });
  });
});

describe("bullets (S28)", () => {
  test("open rows start with • in the pane's colour, escalated ones with !, in the quadrants and the strip", async () => {
    const f = await start(120, 30, { view: { bullets: true } });
    for (const title of ["Pay rent", "Call the bank", "Plan the trip", "Reply to email", "Watch TV", "Unsorted idea", "Another idea"]) {
      expect(f.split("\n").find((line) => line.includes(title))!).toContain(`• ${title}`);
    }
    expect(f.split("\n").find((line) => line.includes("Renew passport"))!).toContain("! Renew passport");
    expect(markOf("Call the bank").text).toBe("• ");
    expect(hexOf(markOf("Call the bank").fg)).toBe(BUCKET_COLOR[1].toLowerCase());
    expect(hexOf(markOf("Plan the trip").fg)).toBe(BUCKET_COLOR[2].toLowerCase());
    expect(hexOf(markOf("Unsorted idea").fg)).toBe(BUCKET_COLOR.inbox.toLowerCase());
  });

  test("the selected row keeps its highlight across the bullet", async () => {
    await start(120, 30, { view: { bullets: true } });
    const mark = markOf("Pay rent");
    expect(mark.text).toBe("• ");
    expect(hexOf(mark.bg)).toBe(paneStyle(1, true).selectBg.toLowerCase());
  });

  test("bullets off (the default here) keeps the blank mark", async () => {
    const f = await start(120, 30);
    expect(f).not.toContain("•");
    expect(f.split("\n").find((line) => line.includes("Call the bank"))!).toContain("  Call the bank");
  });

  test("toggle_bullets (no default key) toggles them and saves bullets through the saver", async () => {
    const saved: unknown[] = [];
    let f = await start(120, 30, { view: { bullets: true }, keys: { toggle_bullets: ["b"] }, saveView: (p) => void saved.push(p) });
    expect(f).toContain("• Call the bank");
    f = await keys("b");
    expect(f).not.toContain("•");
    expect(statusOf(f)).toContain("Bullets off");
    f = await keys("b");
    expect(f).toContain("• Call the bank");
    expect(saved).toEqual([{ bullets: false }, { bullets: true }]);
  });
});

describe("preview panel (S25, S26)", () => {
  let saved: Record<string, unknown>[];

  beforeEach(() => {
    saved = [];
    repo.update(byTitle("Pay rent")!.id, { description: "Transfer to the landlord\nbefore the 5th", tags: ["home"] });
    repo.update(byTitle("Call the bank")!.id, { description: "Ask about the card fee" });
  });

  function open(width = 140, height = 40, over: AppOptions = {}) {
    return start(width, height, { view: { preview: true }, saveView: (patch) => void saved.push(patch), ...over });
  }

  // Column of the preview panel's left border.
  function panelCol(f: string): number {
    return where(f, "Preview").col - 2;
  }

  // The text of the preview panel only (each row from its left border on).
  function panel(f: string): string {
    const col = panelCol(f);
    return grid(f)
      .split("\n")
      .map((line) => line.slice(col))
      .join("\n");
  }

  test("at 140×40 a right sidebar shows the selected task: title, bucket, tags, description, footer", async () => {
    const f = await open();
    expect(f).toContain("Preview");
    expect(where(f, "Preview").row).toBe(where(f, "Q1 · ✅ Do").row);
    expect(panelCol(f)).toBeGreaterThan(where(f, "Q2 · 📅 Schedule").col);
    const p = panel(f);
    expect(p).toContain("Pay rent");
    expect(p).toContain("Q1 · ✅ Do");
    expect(p).toContain("#home");
    expect(p).toContain("Transfer to the landlord");
    expect(p).toContain("before the 5th");
    expect(p).toMatch(/created \d{4}-\d{2}-\d{2} · updated \d{4}-\d{2}-\d{2}/);
    // The bucket label is drawn in the quadrant's colour.
    const label = setup
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .filter((s) => s.text.includes("Q1 · ✅ Do"))
      .at(-1)!;
    expect(hexOf(label.fg)).toBe(BUCKET_COLOR[1].toLowerCase());
  });

  test("follows j, the Inbox strip and a search match; an escalated due date gets !", async () => {
    await open();
    let p = panel(await keys("j"));
    expect(p).toContain("Ask about the card fee");
    expect(p).not.toContain("Transfer to the landlord");
    p = panel(await keys("j"));
    expect(p).toContain("Renew passport");
    expect(p).toContain("due: 2026-11-13 !");
    await keys("j", "j"); // Q3, then the Inbox strip
    expect(app.state.focus).toBe("inbox");
    expect(panel(await frame())).toContain("📥 Inbox");
    await keys("/");
    await setup.mockInput.typeText("trip");
    p = panel(await frame());
    expect(p).toContain("Plan the trip");
    expect(p).toContain("Q2 · 📅 Schedule");
  });

  test("updates after an edit in the editor", async () => {
    const { launch } = fakeLauncher(writes("# Pay rent\n\nNew landlord, new account\n"));
    await open(140, 40, { launchEditorPty: launch });
    setup.mockInput.pressKey("e");
    await app.idle();
    const p = panel(await frame());
    expect(p).toContain("New landlord, new account");
    expect(p).not.toContain("Transfer to the landlord");
  });

  test("updates after x and after 1–4: it shows the task now selected", async () => {
    await open();
    let p = panel(await keys("x"));
    expect(byTitle("Pay rent")!.status).toBe("done");
    expect(p).toContain("Call the bank");
    expect(p).not.toContain("Transfer to the landlord");
    // From the strip, 1 sends "Unsorted idea" to Q1; the strip selects the next one.
    await keys("j", "j", "j");
    expect(app.state.focus).toBe("inbox");
    p = panel(await frame());
    expect(p).toContain("Unsorted idea");
    p = panel(await keys("1"));
    expect(p).toContain("Another idea");
    expect(p).not.toContain("Unsorted idea");
  });

  test("a task in the done panel shows ✓ Done · its completion date", async () => {
    repo.toggleDone(byTitle("Pay rent")!.id);
    await open(140, 40, { view: { preview: true, donePanel: true } });
    await keys("l", "l");
    expect(app.state.focus).toBe("done");
    const p = panel(await frame());
    expect(p).toContain("Transfer to the landlord");
    expect(p).toMatch(/✓ Done · \d{4}-\d{2}-\d{2}/);
  });

  test("an empty pane shows No task selected", async () => {
    repo.toggleDone(byTitle("Watch TV")!.id);
    await open();
    const p = panel(await keys("l", "j"));
    expect(app.state.focus).toBe(4);
    expect(p).toContain("No task selected");
  });

  test("p hides it and saves {preview: false}; p again brings it back", async () => {
    let f = await open();
    f = await keys("p");
    expect(grid(f)).not.toContain("Preview");
    expect(f).not.toContain("Transfer to the landlord");
    expect(statusOf(f)).toContain("Preview off");
    f = await keys("p");
    expect(f).toContain("Transfer to the landlord");
    expect(saved).toEqual([{ preview: false }, { preview: true }]);
    for (const patch of saved) expect(Object.values(patch)).not.toContain(undefined);
  });

  test("a save error shows in the status line and the session keeps the new value", async () => {
    await open(140, 40, {
      saveView: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const f = await keys("p");
    expect(statusOf(f)).toContain("EACCES: permission denied");
    expect(grid(f)).not.toContain("Preview");
    expect(app.state.preview).toBe(false);
  });

  test("ctrl+d / ctrl+u scroll a 40-line description; a new selection goes back to the top", async () => {
    const description = Array.from({ length: 40 }, (_, i) => `step ${String(i + 1).padStart(2, "0")}`).join("\n");
    repo.update(byTitle("Pay rent")!.id, { description });
    let p = panel(await open());
    expect(p).toContain("step 01");
    expect(p).not.toContain("step 40");
    setup.mockInput.pressKey("d", { ctrl: true });
    p = panel(await frame());
    expect(p).not.toContain("step 01");
    expect(p).toContain("Pay rent"); // the header stays
    for (let i = 0; i < 10; i++) setup.mockInput.pressKey("d", { ctrl: true });
    p = panel(await frame());
    expect(p).toContain("step 40");
    setup.mockInput.pressKey("u", { ctrl: true });
    p = panel(await frame());
    expect(p).not.toContain("step 40");
    // The keys never moved the selection.
    expect(app.state.focus).toBe(1);
    expect(app.state.selected[1]).toBe(0);
    p = panel(await keys("j", "k"));
    expect(p).toContain("step 01");
    // The next task is long too, so only the reset (not the clamp) brings it to the top.
    const other = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`).join("\n");
    for (const t of repo.list({ status: "all" })) if (t.title !== "Pay rent") repo.update(t.id, { description: other });
    p = panel(await open());
    for (let i = 0; i < 10; i++) setup.mockInput.pressKey("d", { ctrl: true });
    p = panel(await frame());
    expect(p).toContain("step 40");
    p = panel(await keys("j"));
    expect(p).toContain("line 01");
  });

  test("stacked with the done panel: preview on top, done panel below, both in the sidebar", async () => {
    repo.toggleDone(byTitle("Watch TV")!.id);
    const f = await open(140, 40, { view: { preview: true, donePanel: true } });
    const preview = where(f, "Preview");
    const done = where(f, "✓ Done (1)");
    expect(preview.row).toBe(0);
    expect(done.row).toBeGreaterThan(preview.row + 5);
    // The preview's bottom border sits right above the done panel's top one, at the right edge.
    const rowsOf = f.split("\n");
    expect(rowsOf[done.row - 1]!.trimEnd().endsWith("╯")).toBe(true);
    expect(rowsOf[done.row]!.trimEnd().endsWith("╮")).toBe(true);
    expect(panel(f)).toContain("Transfer to the landlord");
    expect(where(f, "Watch TV").row).toBe(done.row + 1);
  });

  test("under 100 columns the sidebar hides with a message; p still toggles and saves", async () => {
    let f = await open(90, 30);
    expect(f).not.toContain("Preview");
    expect(statusOf(f)).toContain("Sidebar hidden: needs 100 columns");
    await keys("p");
    expect(app.state.preview).toBe(false);
    expect(saved).toEqual([{ preview: false }]);
    setup.resize(140, 40);
    f = await frame();
    expect(grid(f)).not.toContain("Preview");
    f = await keys("p");
    expect(f).toContain("Transfer to the landlord");
  });

  test("the preview is not focusable: l from Q2 stays in Q2 without the done panel", async () => {
    await open();
    await keys("l", "l");
    expect(app.state.focus).toBe(2);
  });

  test("the help lists the toggle and the scroll keys", async () => {
    await open();
    const f = await keys("?");
    expect(f).toContain("Show / hide the preview");
    expect(f).toMatch(/ctrl\+d \/ ctrl\+u\s+Scroll the preview/);
  });

  test("off (the default here): no sidebar", async () => {
    const f = await start(140, 40);
    expect(f).not.toContain("Preview");
    expect(f).not.toContain("Transfer to the landlord");
  });

  describe("startTui (S29)", () => {
    let dir: string;
    let env: Record<string, string>;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "eisen-preview-"));
      env = { EISEN_CONFIG: join(dir, "config.json") };
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("on by default; p writes preview: false to the config file, other keys kept", async () => {
      writeFileSync(env.EISEN_CONFIG!, '{"preset": "classic", "extra": 1}');
      setup = await createTestRenderer({ width: 140, height: 40, exitOnCtrlC: false });
      const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env });
      await Bun.sleep(20);
      let f = await frame();
      expect(f).toContain("Transfer to the landlord");
      f = await keys("p");
      expect(f).not.toContain("Transfer to the landlord");
      setup.mockInput.pressKey("q");
      await run;
      expect(JSON.parse(readFileSync(env.EISEN_CONFIG!, "utf8"))).toEqual({
        preset: "classic",
        view: { preview: false },
        extra: 1,
      });
    });

    test("reads view.preview false from the config", async () => {
      writeFileSync(env.EISEN_CONFIG!, '{"view": {"preview": false}}');
      setup = await createTestRenderer({ width: 140, height: 40, exitOnCtrlC: false });
      const run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env });
      await Bun.sleep(20);
      expect(await frame()).not.toContain("Transfer to the landlord");
      setup.mockInput.pressKey("q");
      await run;
    });
  });
});

describe("command line (S31)", () => {
  let saved: Record<string, unknown>[];

  beforeEach(() => {
    saved = [];
  });

  function open(width = 140, height = 40, over: AppOptions = {}) {
    return start(width, height, { view: { preview: true }, saveView: (patch) => void saved.push(patch), ...over });
  }

  async function type(text: string): Promise<string> {
    await setup.mockInput.typeText(text);
    return frame();
  }

  async function enter(): Promise<string> {
    setup.mockInput.pressEnter();
    return frame();
  }

  async function tab(): Promise<string> {
    setup.mockInput.pressTab();
    return frame();
  }

  async function escape(): Promise<string> {
    setup.mockInput.pressEscape();
    await Bun.sleep(30); // L11: an Escape followed at once by a key merges
    return frame();
  }

  test(": opens a `:` input in the status line with a cursor; typed keys do not fire matrix actions", async () => {
    await open();
    let f = await type(":");
    expect(app.state.mode).toBe("command");
    expect(statusOf(f)).toContain(":█");
    f = await type("xqp");
    expect(statusOf(f)).toContain(":xqp█");
    expect(app.state.quit).toBe(false);
    expect(app.state.preview).toBe(true);
    expect(byTitle("Pay rent")!.status).toBe("open");
    expect(saved).toEqual([]);
  });

  test(":preview⏎ toggles the preview and the saver receives the patch", async () => {
    await open();
    await type(":preview");
    let f = await enter();
    expect(app.state.mode).toBe("normal");
    expect(app.state.preview).toBe(false);
    expect(saved).toEqual([{ preview: false }]);
    expect(statusOf(f)).toContain("Preview off");
    expect(grid(f)).not.toContain("Preview");
    await type(":preview");
    f = await enter();
    expect(app.state.preview).toBe(true);
    expect(saved).toEqual([{ preview: false }, { preview: true }]);
  });

  test(":done on / :bullets off set the value explicitly and save only when it changes", async () => {
    await open(140, 40, { view: { preview: true, bullets: true } });
    await type(":done on");
    await enter();
    expect(app.state.donePanel).toBe(true);
    await type(":done on");
    let f = await enter();
    expect(app.state.donePanel).toBe(true);
    expect(statusOf(f)).toContain("Done panel already on");
    await type(":bullets off");
    f = await enter();
    expect(app.state.bullets).toBe(false);
    expect(statusOf(f)).toContain("Bullets off");
    expect(saved).toEqual([{ donePanel: true }, { bullets: false }]);
  });

  test(":pre⇥ completes to :preview, then Tab cycles on / off", async () => {
    await open();
    await type(":pre");
    let f = await tab();
    expect(app.state.mode).toBe("command");
    expect(statusOf(f)).toContain(":preview █");
    f = await tab();
    expect(statusOf(f)).toContain(":preview on█");
    f = await tab();
    expect(statusOf(f)).toContain(":preview off█");
    f = await tab();
    expect(statusOf(f)).toContain(":preview on█");
    expect(saved).toEqual([]);
  });

  test(":add Call bank #fin⏎ creates it in the focused quadrant with tag fin", async () => {
    await open();
    await keys("l"); // Q2
    await type(":add Call bank #fin");
    const f = await enter();
    const task = byTitle("Call bank #fin")!;
    expect(task).toBeDefined();
    expect(bucketOf(task)).toBe(2);
    expect(task.tags).toEqual(["fin"]);
    expect(statusOf(f)).toContain("Added to Q2");
    expect(app.state.mode).toBe("normal");
  });

  test(":add from the Inbox strip adds to the Inbox", async () => {
    await open();
    // Down Q1's rows, through Q3, into the strip.
    for (let i = 0; i < 10 && app.state.focus !== "inbox"; i++) await keys("j");
    expect(app.state.focus).toBe("inbox");
    await type(":add Someday maybe");
    await enter();
    expect(bucketOf(byTitle("Someday maybe")!)).toBe("inbox");
  });

  // quit is rebound so a `q` leaking to the matrix cannot quit by itself.
  test(":q⏎ quits", async () => {
    await open(140, 40, { keys: { quit: ["Q"] } });
    await type(":q");
    expect(app.state.quit).toBe(false);
    await enter();
    expect(await settles(app.done)).toBe("done");
  });

  test(":quit⏎ quits", async () => {
    await open(140, 40, { keys: { quit: ["Q"] } });
    await type(":quit");
    expect(app.state.quit).toBe(false);
    await enter();
    expect(await settles(app.done)).toBe("done");
  });

  test("an unknown command or a bad argument says so and changes nothing", async () => {
    await open();
    await type(":foo bar");
    let f = await enter();
    expect(statusOf(f)).toContain("Unknown command: foo");
    expect(app.state.mode).toBe("normal");
    await type(":preview maybe");
    f = await enter();
    expect(statusOf(f)).toContain("Usage: :preview [on|off]");
    expect(app.state.preview).toBe(true);
    expect(saved).toEqual([]);
    expect(repo.list({ status: "all" })).toHaveLength(8);
  });

  test("Esc cancels without running anything; matrix keys work again afterwards", async () => {
    await open();
    await type(":preview");
    let f = await escape();
    expect(app.state.mode).toBe("normal");
    expect(statusOf(f)).not.toContain(":preview");
    expect(app.state.preview).toBe(true);
    expect(saved).toEqual([]);
    f = await keys("p");
    expect(app.state.preview).toBe(false);
  });

  test("Backspace on an empty line closes it", async () => {
    await open();
    await type(":a");
    setup.mockInput.pressBackspace();
    let f = await frame();
    expect(statusOf(f)).toContain(":█");
    expect(app.state.mode).toBe("command");
    setup.mockInput.pressBackspace();
    f = await frame();
    expect(app.state.mode).toBe("normal");
  });

  test("↑/↓ walk this session's history; Enter runs the recalled line", async () => {
    await open();
    await type(":bullets");
    await enter();
    await type(":done");
    await enter();
    await type(":x");
    setup.mockInput.pressArrow("up");
    let f = await frame();
    expect(statusOf(f)).toContain(":done█");
    setup.mockInput.pressArrow("up");
    f = await frame();
    expect(statusOf(f)).toContain(":bullets█");
    setup.mockInput.pressArrow("down");
    f = await frame();
    expect(statusOf(f)).toContain(":done█");
    setup.mockInput.pressArrow("down");
    f = await frame();
    expect(statusOf(f)).toContain(":x█");
    setup.mockInput.pressArrow("up");
    await enter();
    expect(saved).toEqual([{ bullets: true }, { donePanel: true }, { donePanel: false }]);
  });

  test(":search bank⏎ filters like / bank Enter and keeps the filter", async () => {
    await open();
    await type(":search bank");
    const f = await enter();
    expect(app.state.mode).toBe("normal");
    expect(app.state.query).toBe("bank");
    expect(grid(f)).toContain("Call the bank");
    expect(grid(f)).not.toContain("Pay rent");
    expect(statusOf(f)).toContain("1 match");
  });

  test(":help, :settings and :triage open their modes", async () => {
    await open();
    await type(":help");
    await enter();
    expect(app.state.mode).toBe("help");
    await escape();
    await type(":settings");
    await enter();
    expect(app.state.mode).toBe("settings");
    await escape();
    await type(":triage");
    await enter();
    expect(app.state.mode).toBe("triage");
  });

  test("the help lists the command line under its current key (S30)", async () => {
    await open(140, 40, { keys: { command_line: [";"] } });
    let f = await keys("?");
    expect(f).toContain("Command line");
    expect(f.split("\n")[where(f, "Command line").row]).toMatch(/│\s*; +Command line/);
    await escape();
    f = await type(";");
    expect(app.state.mode).toBe("command");
  });
});

describe("editor modes (S32)", () => {
  const FORM: AppOptions = { editor: { mode: "form", command: "nvim", display: "floating" } };

  function events(taskId: number, type: string): number {
    const row = db.query("SELECT COUNT(*) AS n FROM events WHERE type = $type AND task_id = $id").get({ id: taskId, type }) as {
      n: number;
    };
    return row.n;
  }

  const hex = (c: { toInts(): number[] }) =>
    `#${c
      .toInts()
      .slice(0, 3)
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")}`;

  function spanWith(text: string) {
    for (const line of setup.captureSpans().lines) {
      const span = line.spans.find((s) => s.text.includes(text));
      if (span) return span;
    }
    throw new Error(`"${text}" not in the frame`);
  }

  // Types `text` one key at a time (each character is one keypress).
  async function type(text: string): Promise<string> {
    for (const ch of text) setup.mockInput.pressKey(ch);
    return frame();
  }

  async function tab(shift = false): Promise<string> {
    setup.mockInput.pressTab(shift ? { shift: true } : undefined);
    return frame();
  }

  async function enter(): Promise<string> {
    setup.mockInput.pressEnter();
    return frame();
  }

  async function escape(): Promise<string> {
    setup.mockInput.pressEscape();
    await Bun.sleep(30); // L11: an Escape followed at once by a key merges
    return frame();
  }

  // Ctrl+S, then waits for the form's session to settle when it closes.
  async function save(): Promise<string> {
    setup.mockInput.pressKey("s", { ctrl: true });
    await settles(app.idle(), 200);
    return frame();
  }

  test("form: a in Q2 opens the form titled in Q2's colour; title, due and a two-line description create one task with its #tags", async () => {
    await start(100, 30, FORM);
    const before = repo.list({ status: "all" }).length;
    let f = await keys("l", "a");
    expect(f).toContain("New task · 📅 Schedule");
    expect(hex(spanWith("New task · 📅 Schedule").fg)).toBe(BUCKET_COLOR[2].toLowerCase());
    // Centred like the floating editor: the box's top row is 4 at 100 x 30.
    expect(where(f, "New task · 📅 Schedule").row).toBe(4);
    expect(f).toContain("Title");
    expect(f).toContain("Due");
    expect(f).toContain("Description");
    expect(statusOf(f)).toContain("Ctrl+S save");
    await type("Book flights #travel");
    await enter(); // Enter in Title: next field
    await type("2026-12-01");
    await enter(); // Enter in Due: next field
    await type("Window seat #cheap");
    await enter(); // Enter in Description: a newline
    f = await type("Aisle if not");
    expect(f).toContain("Book flights #travel");
    expect(f).toContain("2026-12-01");
    expect(f).toContain("Aisle if not");
    f = await save();
    const task = byTitle("Book flights #travel")!;
    expect(task).toBeDefined();
    expect(bucketOf(task)).toBe(2);
    expect(task.dueDate).toBe("2026-12-01");
    expect(task.description).toBe("Window seat #cheap\nAisle if not");
    expect(task.tags).toEqual(["travel", "cheap"]);
    expect(events(task.id, "created")).toBe(1);
    expect(repo.list({ status: "all" })).toHaveLength(before + 1);
    expect(f).not.toContain("New task ·");
    expect(statusOf(f)).toContain("Added to Q2 · 📅 Schedule");
    expect(app.state.focus).toBe(2);
    expect(app.state.selected[2]).toBe(1);
  });

  test("form: a with the Inbox strip focused creates in the Inbox", async () => {
    await start(100, 30, FORM);
    await keys("j", "j", "j", "j");
    expect(app.state.focus).toBe("inbox");
    const f = await keys("a");
    expect(f).toContain("New task · 📥 Inbox");
    await type("Call the plumber");
    await save();
    expect(bucketOf(byTitle("Call the plumber")!)).toBe("inbox");
  });

  test("form: e shows the task; changing only the description saves it as exactly one edited event", async () => {
    const payRent = byTitle("Pay rent")!;
    repo.update(payRent.id, { description: "Before the 5th", tags: ["todo"] });
    const editsBefore = events(payRent.id, "edited");
    await start(100, 30, FORM);
    let f = await keys("e");
    expect(f).toContain("Edit · Pay rent");
    expect(hex(spanWith("Edit · Pay rent").fg)).toBe(BUCKET_COLOR[1].toLowerCase());
    expect(f).toContain("Before the 5th");
    await tab();
    await tab();
    await type(" or the 6th");
    f = await save();
    const task = repo.get(payRent.id)!;
    expect(task.description).toBe("Before the 5th or the 6th");
    expect(task.title).toBe("Pay rent");
    expect(task.dueDate).toBeNull();
    expect(task.tags).toEqual(["todo"]);
    expect(events(payRent.id, "edited")).toBe(editsBefore + 1);
    expect(statusOf(f)).toContain("Saved");
    expect(f).not.toContain("Edit · Pay rent");
  });

  test("form: e then Ctrl+S with nothing changed says No changes and writes no event", async () => {
    const id = byTitle("Pay rent")!.id;
    await start(100, 30, FORM);
    await keys("e");
    const f = await save();
    expect(statusOf(f)).toContain("No changes");
    expect(events(id, "edited")).toBe(0);
  });

  test("form: e can clear the due date and adds the description's #tags", async () => {
    const id = byTitle("Renew passport")!.id;
    await start(100, 30, FORM);
    // Renew passport is escalated into Q1 (S7), under Pay rent and Call the bank.
    await keys("j", "j");
    let f = await keys("e");
    expect(f).toContain("Edit · Renew passport");
    expect(f).toContain("2026-11-13");
    await tab();
    for (let i = 0; i < 10; i++) setup.mockInput.pressBackspace();
    await tab();
    await type("Photos first #admin");
    f = await save();
    const task = repo.get(id)!;
    expect(task.dueDate).toBeNull();
    expect(task.description).toBe("Photos first #admin");
    expect(task.tags).toEqual(["admin"]);
    expect(events(id, "edited")).toBe(1);
  });

  test("form: an invalid due shows an inline error and saves nothing; fixing it saves", async () => {
    await start(100, 30, FORM);
    const before = repo.list({ status: "all" }).length;
    await keys("a");
    await type("Buy milk");
    await tab();
    await type("2026-13-45");
    let f = await save();
    expect(f).toContain('Invalid due date "2026-13-45"');
    expect(f).toContain("New task · ✅ Do"); // still open
    expect(repo.list({ status: "all" })).toHaveLength(before);
    for (let i = 0; i < 10; i++) setup.mockInput.pressBackspace(); // the focus is on Due
    await type("2026-12-24");
    f = await save();
    expect(byTitle("Buy milk")!.dueDate).toBe("2026-12-24");
    expect(f).not.toContain("Invalid due date");
    expect(repo.list({ status: "all" })).toHaveLength(before + 1);
  });

  test("form: an empty title on a new task is Cancelled; on an edit it is an inline error", async () => {
    await start(100, 30, FORM);
    const before = repo.list({ status: "all" }).length;
    await keys("a");
    await tab();
    await tab();
    await type("only a description");
    let f = await save();
    expect(statusOf(f)).toContain("Cancelled");
    expect(f).not.toContain("New task ·");
    expect(repo.list({ status: "all" })).toHaveLength(before);

    const id = byTitle("Pay rent")!.id;
    await keys("e");
    for (let i = 0; i < 8; i++) setup.mockInput.pressBackspace();
    f = await save();
    expect(f).toContain("Empty title");
    expect(f).toContain("Edit · Pay rent");
    expect(repo.get(id)!.title).toBe("Pay rent");
    await escape();
    await escape();
    await settles(app.idle(), 200);
    expect(events(id, "edited")).toBe(0);
    expect(await frame()).not.toContain("Edit · Pay rent");
  });

  test("form: Esc with nothing changed closes at once; with changes it asks once and the second Esc discards", async () => {
    await start(100, 30, FORM);
    const before = repo.list({ status: "all" }).length;
    await keys("a");
    await escape();
    await settles(app.idle(), 200);
    let f = await frame();
    expect(f).not.toContain("New task ·");
    expect(statusOf(f)).toContain("Cancelled");

    await keys("a");
    await type("x");
    f = await escape();
    expect(f).toContain("Discard changes? Esc again");
    expect(f).toContain("New task ·");
    // Any other key carries on editing and drops the question.
    f = await type("y");
    expect(f).not.toContain("Discard changes?");
    expect(f).toContain("xy");
    f = await escape();
    expect(f).toContain("Discard changes? Esc again");
    await escape();
    await settles(app.idle(), 200);
    f = await frame();
    expect(f).not.toContain("New task ·");
    expect(statusOf(f)).toContain("Cancelled");
    expect(repo.list({ status: "all" })).toHaveLength(before);
    // Back on the matrix: keys act on it again.
    await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("done");
  });

  test("form: Esc on an edit with nothing changed closes without an event", async () => {
    const id = byTitle("Pay rent")!.id;
    await start(100, 30, FORM);
    await keys("e");
    await escape();
    await settles(app.idle(), 200);
    const f = await frame();
    expect(f).not.toContain("Edit · Pay rent");
    expect(events(id, "edited")).toBe(0);
  });

  test("form: matrix keys typed into the title only type, once each; q, Ctrl+C and Enter never reach the matrix", async () => {
    await start(100, 30, FORM);
    await keys("a");
    await type("xdq1j?:,/iAe.p");
    setup.mockInput.pressKey("c", { ctrl: true });
    let f = await frame();
    expect(f).toContain("xdq1j?:,/iAe.p");
    expect(f).not.toContain("xxdd");
    expect(app.state.mode).toBe("normal");
    expect(app.state.selected[1]).toBe(0);
    expect(byTitle("Pay rent")!.status).toBe("open");
    expect(bucketOf(byTitle("Pay rent")!)).toBe(1);
    expect(await settles(app.done, 50)).toBe("stuck");
    f = await save();
    const task = byTitle("xdq1j?:,/iAe.p")!;
    expect(task).toBeDefined();
    expect(bucketOf(task)).toBe(1);
    expect(repo.list({ status: "all" })).toHaveLength(9);
  });

  test("form: Tab and Shift+Tab move between the fields and wrap", async () => {
    await start(100, 30, FORM);
    await keys("a");
    await type("T");
    await tab();
    await type("2026-01-02");
    await tab(true); // back to Title
    await type("X");
    await tab();
    await tab(); // Description
    await type("d");
    await tab(); // wraps to Title
    await type("Y");
    await tab(true); // wraps back to Description
    await type("e");
    await save();
    const task = byTitle("TXY")!;
    expect(task).toBeDefined();
    expect(task.dueDate).toBe("2026-01-02");
    expect(task.description).toBe("de");
  });

  test("form: a resize re-lays the box; down to 30 x 10 it still takes keys and saves", async () => {
    await start(100, 30, FORM);
    await keys("a");
    setup.resize(120, 40);
    let f = await frame();
    expect(where(f, "New task · ✅ Do").row).toBe(6);
    setup.resize(30, 10);
    f = await frame();
    expect(f).toContain("New task");
    await type("Tiny");
    setup.resize(100, 30);
    f = await frame();
    expect(where(f, "New task · ✅ Do").row).toBe(4);
    expect(f).toContain("Tiny");
    await save();
    expect(bucketOf(byTitle("Tiny")!)).toBe(1);
  });

  test("form: under 40 x 12 the form fills the screen above the status line instead of the full-screen editor", async () => {
    let runs = 0;
    await start(36, 11, {
      ...FORM,
      runEditor: async () => {
        runs++;
        return 0;
      },
    });
    const f = await keys("a");
    expect(f).toContain("New task");
    expect(where(f, "New task").row).toBe(0);
    await type("Small");
    await save();
    expect(runs).toBe(0);
    expect(byTitle("Small")).toBeDefined();
  });

  test("form: e on the triage card edits it and returns to the same card", async () => {
    await start(120, 30, FORM);
    await keys("i");
    expect(app.state.mode).toBe("triage");
    const id = app.state.triage!.queue[0]!;
    const title = repo.get(id)!.title;
    let f = await keys("e");
    expect(f).toContain(`Edit · ${title}`);
    await tab();
    await tab();
    await type("Needs a plan #later");
    f = await save();
    const task = repo.get(id)!;
    expect(task.description).toBe("Needs a plan #later");
    expect(task.tags).toEqual(["later"]);
    expect(events(id, "edited")).toBe(1);
    expect(bucketOf(task)).toBe("inbox");
    expect(app.state.mode).toBe("triage");
    expect(app.state.triage!.queue[app.state.triage!.index]).toBe(id);
    expect(f).toContain("Needs a plan #later");
    expect(statusOf(f)).toContain("Saved");
  });

  test("form: A and :add stay one-line quick adds", async () => {
    await start(100, 30, FORM);
    let f = await keys("A");
    expect(app.state.mode).toBe("add");
    expect(f).not.toContain("New task ·");
    await type("Quick one");
    await enter();
    expect(bucketOf(byTitle("Quick one")!)).toBe(1);
    await type(":add Another quick");
    f = await enter();
    expect(f).not.toContain("New task ·");
    expect(byTitle("Another quick")).toBeDefined();
  });

  test("command mode launches editor.command in the floating PTY, whatever $VISUAL says", async () => {
    const { launch, ptys } = fakeLauncher();
    await start(100, 30, {
      launchEditorPty: launch,
      env: { VISUAL: "vim", EDITOR: "vi" },
      editor: { mode: "command", command: "nano", display: "floating" },
    });
    await keys("a");
    await Bun.sleep(10);
    const f = await frame();
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.cmd).toEqual(["nano"]);
    expect(basename(ptys[0]!.path)).toMatch(/^eisen-new-.+\.md$/);
    expect(f).toContain("New task · ✅ Do");
    expect(statusOf(f)).toContain("nano");
    await Bun.write(ptys[0]!.path, "# Written in nano\n");
    ptys[0]!.exit(0);
    await app.idle();
    expect(bucketOf(byTitle("Written in nano")!)).toBe(1);
  });

  test("command mode splits editor.command on whitespace", async () => {
    const { launch, ptys } = fakeLauncher(writes("# Split\n"));
    await start(100, 30, { launchEditorPty: launch, editor: { mode: "command", command: "nvim -u NONE", display: "floating" } });
    setup.mockInput.pressKey("a");
    await app.idle();
    expect(ptys[0]!.cmd).toEqual(["nvim", "-u", "NONE"]);
    expect(byTitle("Split")).toBeDefined();
  });

  test("display fullscreen uses the full-screen editor for auto and command", async () => {
    for (const mode of ["auto", "command"] as const) {
      const { launch, ptys } = fakeLauncher();
      let runs = 0;
      await start(100, 30, {
        launchEditorPty: launch,
        editor: { mode, command: "nano", display: "fullscreen" },
        runEditor: async (path) => {
          runs++;
          await Bun.write(path, `# Full ${mode}\n`);
          return 0;
        },
      });
      setup.renderer.suspend = async () => {};
      setup.renderer.resume = async () => {};
      setup.mockInput.pressKey("a");
      await app.idle();
      expect(ptys).toHaveLength(0);
      expect(runs).toBe(1);
      expect(byTitle(`Full ${mode}`)).toBeDefined();
      app.destroy();
      await setup.dispose();
    }
  });

  test("EISEN_EDITOR_MODE=fullscreen overrides display floating", async () => {
    const { launch, ptys } = fakeLauncher();
    let runs = 0;
    await start(100, 30, {
      launchEditorPty: launch,
      env: { EISEN_EDITOR_MODE: "fullscreen" },
      editor: { mode: "command", command: "nano", display: "floating" },
      runEditor: async (path) => {
        runs++;
        await Bun.write(path, "# Env wins\n");
        return 0;
      },
    });
    setup.renderer.suspend = async () => {};
    setup.renderer.resume = async () => {};
    setup.mockInput.pressKey("a");
    await app.idle();
    expect(ptys).toHaveLength(0);
    expect(runs).toBe(1);
    expect(byTitle("Env wins")).toBeDefined();
  });

  test("the default full-screen editor in command mode runs editor.command on the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eisen-cmd-"));
    try {
      const script = join(dir, "editor.sh");
      // Called as `editor.sh marker <file>`: writes a title naming its first argument.
      writeFileSync(script, '#!/bin/sh\nprintf "# From the command %s\\n" "$1" > "$2"\nexit 0\n');
      chmodSync(script, 0o755);
      setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
      app = createMatrixApp(setup.renderer, repo, {
        today: () => TODAY,
        env: { VISUAL: "false" },
        editor: { mode: "command", command: `${script} marker`, display: "fullscreen" },
      });
      setup.renderer.suspend = async () => {};
      setup.renderer.resume = async () => {};
      setup.mockInput.pressKey("a");
      expect(await settles(app.idle(), 5000)).toBe("done");
      expect(byTitle("From the command marker")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setEditor changes the editor at runtime (for the settings screen)", async () => {
    const { launch, ptys } = fakeLauncher();
    await start(100, 30, { launchEditorPty: launch });
    expect(app.editor).toEqual({ mode: "auto", command: "nvim", display: "floating" });
    app.setEditor({ mode: "form", command: "nvim", display: "floating" });
    expect(app.editor.mode).toBe("form");
    const f = await keys("a");
    expect(ptys).toHaveLength(0);
    expect(f).toContain("Description");
    await escape();
    await settles(app.idle(), 200);
    app.setEditor({ mode: "command", command: "hx", display: "floating" });
    await keys("a");
    expect(ptys[0]!.cmd).toEqual(["hx"]);
    ptys[0]!.exit(0);
    await app.idle();
  });

  test("startTui reads the editor settings and shows their warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eisen-editor-"));
    const env = { EISEN_CONFIG: join(dir, "config.json") };
    try {
      writeFileSync(env.EISEN_CONFIG, '{"editor": {"mode": "command", "command": "nano"}}');
      setup = await createTestRenderer({ width: 120, height: 30, exitOnCtrlC: false });
      const { launch, ptys } = fakeLauncher();
      let run = startTui(repo, { today: () => TODAY, launchEditorPty: launch }, { createRenderer: async () => setup.renderer, env });
      await Bun.sleep(20);
      setup.mockInput.pressKey("a");
      await Bun.sleep(20);
      expect(ptys).toHaveLength(1);
      expect(ptys[0]!.cmd).toEqual(["nano"]);
      ptys[0]!.exit(0);
      await Bun.sleep(20);
      setup.mockInput.pressKey("q");
      expect(await settles(run, 2000)).toBe("done");
      await setup.dispose();

      writeFileSync(env.EISEN_CONFIG, '{"editor": {"mode": "fancy"}}');
      setup = await createTestRenderer({ width: 120, height: 30, exitOnCtrlC: false });
      run = startTui(repo, { today: () => TODAY }, { createRenderer: async () => setup.renderer, env });
      await Bun.sleep(20);
      expect(statusOf(await frame())).toContain('Config: editor.mode "fancy" unknown');
      setup.mockInput.pressKey("q");
      expect(await settles(run, 2000)).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
