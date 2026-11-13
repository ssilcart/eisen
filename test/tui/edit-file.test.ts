import { describe, expect, test } from "bun:test";
import type { Task } from "../../src/domain/task.ts";
import {
  NEW_TASK_FILE,
  editChanges,
  editedTags,
  editorCommand,
  parseNewTask,
  parseTaskFile,
  serializeTask,
} from "../../src/tui/edit-file.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    title: "Pay rent",
    description: null,
    important: true,
    urgent: true,
    dueDate: null,
    tags: [],
    status: "open",
    position: 0,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function ok(text: string) {
  const result = parseTaskFile(text);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result.value;
}

function error(text: string): string {
  const result = parseTaskFile(text);
  if (result.ok) throw new Error(`expected an error, got: ${JSON.stringify(result.value)}`);
  return result.error;
}

describe("serializeTask (S11)", () => {
  test("title, due line, blank line, description", () => {
    const text = serializeTask(task({ dueDate: "2026-11-20", description: "Line one\n\nLine two" }));
    expect(text).toBe("# Pay rent\ndue: 2026-11-20\n\nLine one\n\nLine two\n");
  });

  test("no due line when the task has no due date; empty description", () => {
    expect(serializeTask(task())).toBe("# Pay rent\n\n");
  });
});

describe("parseTaskFile (S11)", () => {
  test("round trip: parse(serialize(task)) gives the task's fields back", () => {
    for (const t of [
      task({ dueDate: "2026-11-20", description: "send to #rainer\n> quoted\n\n- a list" }),
      task({ title: "Café ☕ #morning", description: null }),
      task({ description: "due: this is not a due line, it is the description" }),
    ]) {
      expect(ok(serializeTask(t))).toEqual({ title: t.title, dueDate: t.dueDate, description: t.description });
    }
  });

  test("no due line means no due date", () => {
    expect(ok("# Call the bank\n\nAsk about the card\n")).toEqual({
      title: "Call the bank",
      dueDate: null,
      description: "Ask about the card",
    });
  });

  test("an empty due line clears the due date", () => {
    expect(ok("# Call the bank\ndue:\n\n").dueDate).toBeNull();
    expect(ok("# Call the bank\ndue:   \n").dueDate).toBeNull();
  });

  test("an invalid due date is an error", () => {
    expect(error("# Call the bank\ndue: tomorrow\n\n")).toMatch(/due date.*YYYY-MM-DD/i);
    expect(error("# Call the bank\ndue: 2026-02-30\n")).toContain("2026-02-30");
  });

  test("a missing or empty title is an error", () => {
    expect(error("")).toMatch(/title/i);
    expect(error("\n\n")).toMatch(/title/i);
    expect(error("Pay rent\n\nno heading\n")).toMatch(/title/i);
    expect(error("#\n")).toMatch(/title/i);
    expect(error("#   \n")).toMatch(/title/i);
    expect(error("#tag not a heading\n")).toMatch(/title/i);
  });

  test("CRLF line endings", () => {
    expect(ok("# Pay rent\r\ndue: 2026-11-20\r\n\r\nFirst\r\nSecond\r\n")).toEqual({
      title: "Pay rent",
      dueDate: "2026-11-20",
      description: "First\nSecond",
    });
  });

  test("trailing whitespace and blank lines are trimmed", () => {
    expect(ok("\n# Pay rent   \ndue: 2026-11-20  \n\n  \nThe description  \n\n\n")).toEqual({
      title: "Pay rent",
      dueDate: "2026-11-20",
      description: "The description",
    });
    expect(ok("# Pay rent\n\n   \n\n").description).toBeNull();
  });

  test("a description with #tags keeps its text as written", () => {
    expect(ok("# Meta permissions\n\nsend to #rainer the #opt-in description\n").description).toBe(
      "send to #rainer the #opt-in description",
    );
  });
});

describe("editedTags", () => {
  test("keeps tags that did not come from the old text and adds the new text's tags", () => {
    const before = task({
      title: "provide permissions for #instagram",
      description: "send to #rainer",
      tags: ["todo", "instagram", "rainer"],
    });
    expect(editedTags(before, { title: "provide permissions for #messenger", description: "send to #rainer #Ops" })).toEqual([
      "todo",
      "messenger",
      "rainer",
      "ops",
    ]);
  });

  test("keeps the stored order when the set of tags does not change", () => {
    const before = task({ title: "A #b", description: null, tags: ["b", "todo"] });
    expect(editedTags(before, { title: "A #b changed", description: null })).toEqual(["b", "todo"]);
  });
});

describe("editChanges", () => {
  test("null when nothing changed", () => {
    const t = task({ dueDate: "2026-11-20", description: "x #a", tags: ["todo", "a"] });
    expect(editChanges(t, ok(serializeTask(t)))).toBeNull();
  });

  test("only the fields that changed", () => {
    const t = task({ dueDate: "2026-11-20", description: "x", tags: ["todo"] });
    expect(editChanges(t, { title: "Pay rent", dueDate: null, description: "x" })).toEqual({ dueDate: null });
    expect(editChanges(t, { title: "Pay rent #home", dueDate: "2026-11-20", description: "x" })).toEqual({
      title: "Pay rent #home",
      tags: ["todo", "home"],
    });
  });

  test("a description the file cannot hold verbatim is not a change by itself", () => {
    const t = task({ description: "  indented first line\n" });
    expect(editChanges(t, ok(serializeTask(t)))).toBeNull();
  });
});

describe("editorCommand", () => {
  test("$VISUAL, then $EDITOR, then vi; split on whitespace", () => {
    expect(editorCommand({ VISUAL: "code --wait", EDITOR: "nano" })).toEqual(["code", "--wait"]);
    expect(editorCommand({ EDITOR: "  nvim  -u NONE " })).toEqual(["nvim", "-u", "NONE"]);
    expect(editorCommand({ VISUAL: "  ", EDITOR: "" })).toEqual(["vi"]);
    expect(editorCommand({})).toEqual(["vi"]);
  });
});

describe("new task file (S22)", () => {
  test("starts with an empty title and an empty due line, in the edit file format", () => {
    expect(NEW_TASK_FILE).toBe("# \ndue: \n\n");
  });

  test("a title, due date, description and the #tags of both", () => {
    expect(parseNewTask("# Book flights #travel\ndue: 2026-12-01\n\nWindow seat #cheap #Travel\n")).toEqual({
      ok: true,
      value: { title: "Book flights #travel", dueDate: "2026-12-01", description: "Window seat #cheap #Travel", tags: ["travel", "cheap"] },
    });
    expect(parseNewTask("\n# Just a title\n")).toEqual({
      ok: true,
      value: { title: "Just a title", dueDate: null, description: null, tags: [] },
    });
  });

  test("the untouched template, a blank file or an empty title cancel", () => {
    for (const text of [NEW_TASK_FILE, "", "  \n\n", "#\n\nonly a description\n", "#   \ndue: 2026-12-01\n"]) {
      expect(parseNewTask(text)).toEqual({ ok: false, cancelled: true });
    }
  });

  // nvim's `i` on the template types before the `# ` marker (L23).
  test("a first line without the # marker is still the title", () => {
    const value = (title: string) => ({ ok: true as const, value: { title, dueDate: null, description: null, tags: [] } });
    expect(parseNewTask("Buy milk# \ndue: \n\n")).toEqual(value("Buy milk"));
    // Only the template's exact "# " leftover is removed; any other # is the user's.
    expect(parseNewTask("Buy milk#\ndue: \n\n")).toEqual(value("Buy milk#"));
    expect(parseNewTask("C#\n")).toEqual(value("C#"));
    expect(parseNewTask("Learn C #\n")).toEqual(value("Learn C #"));
    expect(parseNewTask("Buy milk\n")).toEqual(value("Buy milk"));
    expect(parseNewTask("Learn C## \n")).toEqual(value("Learn C#"));
    expect(parseNewTask("# Learn C#\n")).toEqual(value("Learn C#"));
    // A title that starts with a tag (typed with `i`, `cc` or `S`).
    expect(parseNewTask("#urgent fix# \ndue: \n\n")).toEqual({ ok: true, value: { title: "#urgent fix", dueDate: null, description: null, tags: ["urgent"] } });
    expect(parseNewTask("#urgent fix\n")).toEqual({ ok: true, value: { title: "#urgent fix", dueDate: null, description: null, tags: ["urgent"] } });
    // `o` on the template: the title goes on the line after an empty marker.
    expect(parseNewTask("# \nHello\ndue: \n\n")).toEqual(value("Hello"));
    expect(parseNewTask("# \nHello\ndue: 2026-12-01\n\nbody\n")).toEqual({ ok: true, value: { title: "Hello", dueDate: "2026-12-01", description: "body", tags: [] } });
    expect(parseNewTask("Call #bank# \ndue: 2026-12-01\n\nbefore noon\n")).toEqual({
      ok: true,
      value: { title: "Call #bank", dueDate: "2026-12-01", description: "before noon", tags: ["bank"] },
    });
  });

  test("any other file that does not parse is an error, not a cancel", () => {
    expect(parseNewTask("# Buy milk\ndue: soon\n")).toEqual({
      ok: false,
      cancelled: false,
      error: 'Invalid due date "soon": use YYYY-MM-DD',
    });
  });
});
