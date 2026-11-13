import { describe, expect, test } from "bun:test";
import {
  FORM_FIELDS,
  checkForm,
  editorCommandFor,
  formChanged,
  formValues,
  nextField,
  oneLine,
} from "../../src/tui/edit-form.ts";

describe("form fields (S32)", () => {
  test("Tab order is title, due, description and wraps both ways", () => {
    expect(FORM_FIELDS).toEqual(["title", "due", "description"]);
    expect(nextField("title", 1)).toBe("due");
    expect(nextField("due", 1)).toBe("description");
    expect(nextField("description", 1)).toBe("title");
    expect(nextField("title", -1)).toBe("description");
    expect(nextField("due", -1)).toBe("title");
  });

  test("the values of a task, empty ones as empty strings; a new task starts blank", () => {
    expect(formValues({ title: "Pay rent", dueDate: "2026-11-30", description: "Before the 5th" })).toEqual({
      title: "Pay rent",
      due: "2026-11-30",
      description: "Before the 5th",
    });
    expect(formValues({ title: "Pay rent", dueDate: null, description: null })).toEqual({ title: "Pay rent", due: "", description: "" });
    expect(formValues(null)).toEqual({ title: "", due: "", description: "" });
  });

  test("oneLine joins pasted lines with spaces", () => {
    expect(oneLine("a\nb\r\nc")).toBe("a b c");
    expect(oneLine("plain")).toBe("plain");
  });

  test("formChanged compares every field as typed", () => {
    const base = { title: "a", due: "", description: "" };
    expect(formChanged(base, { ...base })).toBe(false);
    expect(formChanged(base, { ...base, description: "x" })).toBe(true);
    expect(formChanged(base, { ...base, due: "2026-01-01" })).toBe(true);
  });
});

describe("checkForm (S32)", () => {
  test("a valid form gives the trimmed task with #tags from title and description", () => {
    const r = checkForm({ title: "  Book flights #travel ", due: " 2026-12-01 ", description: "\nWindow seat #cheap\n\n" }, true);
    expect(r).toEqual({
      ok: true,
      value: { title: "Book flights #travel", dueDate: "2026-12-01", description: "Window seat #cheap", tags: ["travel", "cheap"] },
    });
  });

  test("an empty due clears it; an empty description is null", () => {
    const r = checkForm({ title: "x", due: "  ", description: "  " }, false);
    expect(r).toEqual({ ok: true, value: { title: "x", dueDate: null, description: null, tags: [] } });
  });

  test("an invalid due is an error on the due field", () => {
    for (const due of ["2026-13-01", "tomorrow", "2026-02-30"]) {
      expect(checkForm({ title: "x", due, description: "" }, true)).toEqual({
        ok: false,
        cancelled: false,
        field: "due",
        error: `Invalid due date "${due}": use YYYY-MM-DD`,
      });
    }
  });

  test("an empty title cancels a new task and is an error on an edit", () => {
    expect(checkForm({ title: "  ", due: "", description: "something" }, true)).toEqual({ ok: false, cancelled: true });
    expect(checkForm({ title: "", due: "", description: "" }, false)).toEqual({
      ok: false,
      cancelled: false,
      field: "title",
      error: "Empty title: type a title",
    });
  });
});

describe("editorCommandFor (S32)", () => {
  test("auto is $VISUAL, $EDITOR, vi; command is the configured line split on whitespace", () => {
    const env = { VISUAL: "", EDITOR: "hx" };
    expect(editorCommandFor({ mode: "auto", command: "nano", display: "floating" }, env)).toEqual(["hx"]);
    expect(editorCommandFor({ mode: "auto", command: "nano", display: "floating" }, {})).toEqual(["vi"]);
    expect(editorCommandFor({ mode: "command", command: "nano", display: "floating" }, env)).toEqual(["nano"]);
    expect(editorCommandFor({ mode: "command", command: "  nvim -u  NONE ", display: "floating" }, env)).toEqual(["nvim", "-u", "NONE"]);
    // A blank command falls back to auto's choice.
    expect(editorCommandFor({ mode: "command", command: "  ", display: "floating" }, env)).toEqual(["hx"]);
  });
});
