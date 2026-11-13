import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { bucketOf } from "../../src/domain/task.ts";
import { importMarkdown } from "../../src/import/importer.ts";
import { openDb } from "../../src/store/db.ts";
import { TaskRepository } from "../../src/store/repository.ts";
import { createMatrixApp, spawnEditor, startTui, type AppOptions, type MatrixApp } from "../../src/tui/app.ts";

const TODAY = "2026-11-12";

let setup: TestRendererSetup;
let db: Database;
let repo: TaskRepository;
let app: MatrixApp;

async function start(width = 100, height = 30, options: AppOptions = {}) {
  // exitOnCtrlC: false like startTui's renderer, so Ctrl+C reaches the app.
  setup = await createTestRenderer({ width, height, exitOnCtrlC: false });
  app = createMatrixApp(setup.renderer, repo, { today: () => TODAY, ...options });
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

/** Row and column of the first occurrence of `text` in the frame. */
function where(f: string, text: string): { row: number; col: number } {
  const rows = f.split("\n");
  const row = rows.findIndex((line) => line.includes(text));
  return { row, col: row < 0 ? -1 : rows[row]!.indexOf(text) };
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
  test("shows the four panes with open counts in a 2×2 grid and the Inbox count", async () => {
    const f = await start();
    expect(f).toContain("Q1 · Do (3)");
    expect(f).toContain("Q2 · Schedule (1)");
    expect(f).toContain("Q3 · Delegate (1)");
    expect(f).toContain("Q4 · Delete (1)");
    expect(f).toContain("Inbox: 2");
    const q1 = where(f, "Q1 · Do");
    const q2 = where(f, "Q2 · Schedule");
    const q3 = where(f, "Q3 · Delegate");
    const q4 = where(f, "Q4 · Delete");
    expect(q1.row).toBe(q2.row);
    expect(q3.row).toBe(q4.row);
    expect(q3.row).toBeGreaterThan(q1.row);
    expect(q2.col).toBeGreaterThan(q1.col);
    expect(q4.col).toBeGreaterThan(q3.col);
    // Inbox tasks are not in the grid.
    expect(f).not.toContain("Unsorted idea");
  });

  test("an escalated task sits in Q1 with a ! mark and its due date", async () => {
    const f = await start();
    const row = f.split("\n").find((line) => line.includes("Renew passport"))!;
    expect(row).toContain("!");
    expect(row).toContain("2026-11-13");
    expect(where(f, "Renew passport").col).toBeLessThan(where(f, "Q2 · Schedule").col);
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
    for (const title of ["Q1 · Do", "Q2 · Schedule", "Q3 · Delegate", "Q4 · Delete"]) expect(f).toContain(title);
    expect(f.split("\n")[0]!.length).toBeLessThanOrEqual(60);
    setup.resize(140, 40);
    f = await frame();
    for (const title of ["Q1 · Do", "Q2 · Schedule", "Q3 · Delegate", "Q4 · Delete"]) expect(f).toContain(title);
    expect(where(f, "Q2 · Schedule").col).toBeGreaterThanOrEqual(70);
  });

  test("a very narrow screen keeps compact pane titles with counts", async () => {
    await start();
    setup.resize(30, 10);
    const f = await frame();
    for (const title of ["Q1 (3)", "Q2 (1)", "Q3 (1)", "Q4 (1)"]) expect(f).toContain(title);
    expect(f).toContain("Inbox: 2");
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
    expect(f).toContain("Q1 · Do (2)");
    expect(f).toContain("Q2 · Schedule (2)");
  });

  test("j then 4 moves the second task", async () => {
    await start();
    await keys("j", "4");
    expect(bucketOf(byTitle("Call the bank")!)).toBe(4);
    expect(bucketOf(byTitle("Pay rent")!)).toBe(1);
  });

  test("x toggles done; . shows done tasks dimmed with ✓", async () => {
    await start();
    let f = await keys("x");
    expect(byTitle("Pay rent")!.status).toBe("done");
    expect(grid(f)).not.toContain("Pay rent");
    expect(f).toContain("Done: Pay rent");
    expect(f).toContain("Q1 · Do (2)");
    f = await keys(".");
    const row = f.split("\n").find((line) => line.includes("Pay rent"))!;
    expect(row).toContain("✓");
    expect(f).toContain("Q1 · Do (2)");
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
    expect(f).toContain("Q1 · Do (2)");
  });

  test("a + typing + Enter adds a task in the focused quadrant with #tags", async () => {
    await start();
    await keys("l", "a");
    await setup.mockInput.typeText("Book flights #travel");
    let f = await frame();
    expect(f).toContain("Book flights #travel");
    setup.mockInput.pressEnter();
    f = await frame();
    const task = byTitle("Book flights #travel")!;
    expect(bucketOf(task)).toBe(2);
    expect(task.tags).toEqual(["travel"]);
    expect(f).toContain("Q2 · Schedule (2)");
  });

  test("Esc cancels the add input without creating anything", async () => {
    await start();
    await keys("a");
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
    expect(f).toContain("Q1 · Do (2)");
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

describe("edit in $EDITOR (S11)", () => {
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
    await start(100, 30, { runEditor });
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
    expect(f).toContain("Inbox: 8");
    expect(f).toContain("press i to triage");
    expect(app.state.mode).toBe("normal");
    expect(f).toContain("Q1 · Do (0)");
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
    expect(f).toContain("1 Do · 2 Schedule · 3 Delegate · 4 Delete · s skip · e edit · d delete · Esc exit");
    // The card replaces the grid.
    expect(f).not.toContain("Q2 · Schedule");
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
    expect(f).toContain("Moved to Q2 · Schedule");
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
    expect(f).toContain("Inbox: 7");
  });

  test("Esc in the delete confirmation goes back to the card", async () => {
    await start(120, 30);
    await keys("i", "d");
    const f = await escape();
    expect(app.state.mode).toBe("triage");
    expect(f).toContain("Triage 1/8");
    expect(repo.list({ bucket: "inbox" })).toHaveLength(8);
  });

  test("e edits the current task with the editor and stays on its card", async () => {
    const first = inbox[0]!;
    await start(120, 30, {
      runEditor: async (path) => {
        await Bun.write(path, "# Organise subitems in Delivra #delivra\n\nGroup them by epic\n");
        return 0;
      },
    });
    setup.renderer.suspend = async () => {};
    setup.renderer.resume = async () => {};
    await keys("i");
    setup.mockInput.pressKey("e");
    await app.idle();
    const f = await frame();
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
    expect(f).toContain("Inbox: 2");
    expect(f).toContain("Q1 · Do (2)");
    expect(f).toContain("Q2 · Schedule (2)");
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
    expect(f).toContain("Q2 · Schedule (1)");
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
    expect(f).toContain("Inbox: 8");
    for (const row of f.split("\n")) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(30);
    f = await keys("3");
    expect(bucketOf(repo.get(inbox[0]!.id)!)).toBe(3);
    expect(f).toContain("Triage 2/8");
    setup.resize(140, 40);
    f = await frame();
    expect(f).toContain("Triage 2/8");
    expect(f).toContain("1 Do · 2 Schedule · 3 Delegate · 4 Delete · s skip · e edit · d delete · Esc exit");
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
    expect(f).not.toContain("Inbox (");
    f = await keys("/");
    expect(app.state.mode).toBe("search");
    expect(f).toContain("Inbox (4)"); // the strip, unfiltered until something is typed
    f = await type("rai");
    expect(statusLine(f)).toContain("/ rai");
    expect(f).toContain(META);
    expect(f).toContain(CLOUDBEDS);
    expect(f).not.toContain(ZOHO);
    f = await type("ner");
    expect(statusLine(f)).toContain("/ rainer");
    expect(statusLine(f)).toContain("2 matches");
    // Each pane shows matches/total; the strip lists the Inbox matches.
    expect(f).toContain("Q1 · Do (0/1)");
    expect(f).toContain("Q2 · Schedule (1/1)");
    expect(f).toContain("Q3 · Delegate (0/1)");
    expect(f).toContain("Q4 · Delete (0/1)");
    expect(f).toContain("Inbox (1/4)");
    expect(grid(f)).toContain(META);
    expect(where(f, CLOUDBEDS).row).toBeGreaterThan(where(f, "Q4 · Delete").row);
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
    expect(f).toContain("Q3 · Delegate (1/1)");
    expect(grid(f)).toContain(DELIVRA);
    setup.mockInput.pressKey("u", { ctrl: true }); // ignored, not typed
    for (let i = 0; i < "delvira".length; i++) setup.mockInput.pressBackspace();
    f = await type("compañía");
    expect(grid(f)).toContain("cuando se elimina una compania");
    expect(f).toContain("Inbox (1/4)");
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
    expect(f).toContain("Moved to Q2 · Schedule");
    expect(f).toContain("Q2 · Schedule (1/2)");
    expect(f).toContain("Inbox (0/3)");
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
    expect(f).toContain("Inbox (0/3)");
  });

  test("a in the focused Inbox strip adds to the Inbox, and the new match shows up there", async () => {
    await start(120, 30);
    await keys("/");
    await type("cloudbeds");
    setup.mockInput.pressEnter();
    await frame();
    expect(app.state.focus).toBe("inbox");
    let f = await keys("a");
    expect(f).toContain("Add to Inbox:");
    await type("Ask cloudbeds for keys");
    setup.mockInput.pressEnter();
    f = await frame();
    const added = repo.list({ status: "all" }).find((t) => t.title === "Ask cloudbeds for keys")!;
    expect(bucketOf(added)).toBe("inbox");
    expect(f).toContain("Added to Inbox");
    expect(f).toContain("Inbox (2/5)");
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
    expect(f).toContain("Q1 · Do (1/1)");
    f = await escape();
    expect(app.state.mode).toBe("normal");
    expect(app.state.query).toBe("");
    expect(f).not.toContain("Inbox (");
    expect(f).toContain("Q1 · Do (1)");
    expect(f).toContain("Q2 · Schedule (1)");
    expect(f).toContain("Q4 · Delete (0)");
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

  test("done tasks appear dimmed with ✓ even while . hides them", async () => {
    await start(120, 30);
    expect(app.state.showDone).toBe(false);
    await keys("/");
    const f = await type("api calls");
    expect(f).toContain("Q4 · Delete (1/1)");
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
    expect(f).toContain("Q1 · Do (0/1)");
    expect(f).toContain("Inbox (0/4)");
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
    expect(f).toContain("Inbox (1/4)");
    expect(statusLine(f)).toContain("rainer");
    expect(f).toContain("(1/1)");
    setup.resize(30, 10);
    f = await frame();
    expect(f.split("\n").every((line) => Bun.stringWidth(line) <= 30)).toBe(true);
    setup.resize(120, 30);
    setup.mockInput.pressBackspace();
    f = await frame();
    expect(app.state.query).toBe("raine");
    expect(f).toContain("Inbox (1/4)");
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
    expect(f).toContain("Inbox (1/4)");
    expect(f).toContain("Q2 · Schedule (1/1)");
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
