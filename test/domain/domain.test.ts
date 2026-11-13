import { describe, expect, test } from "bun:test";
import { bucketOf, flagsFor, quadrantOf, type Task } from "../../src/domain/task.ts";
import { displayBucket, isEscalated } from "../../src/domain/escalation.ts";
import { parseTags, slug } from "../../src/domain/tags.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "t",
    description: null,
    important: true,
    urgent: false,
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

describe("quadrant derivation (S6)", () => {
  test.each([
    [true, true, 1],
    [true, false, 2],
    [false, true, 3],
    [false, false, 4],
    [null, true, "inbox"],
    [true, null, "inbox"],
    [null, null, "inbox"],
    [false, null, "inbox"],
  ] as const)("important=%p urgent=%p -> %p", (important, urgent, expected) => {
    expect(quadrantOf(important, urgent)).toBe(expected);
  });

  test("flagsFor is the inverse of quadrantOf", () => {
    for (const q of [1, 2, 3, 4] as const) {
      const { important, urgent } = flagsFor(q);
      expect(quadrantOf(important, urgent)).toBe(q);
    }
  });

  test("bucketOf reads the task flags", () => {
    expect(bucketOf(task({ important: false, urgent: true }))).toBe(3);
  });
});

describe("due-date escalation (S7)", () => {
  const today = "2026-11-12";
  test.each([
    ["2026-11-12", true],
    ["2026-11-13", true],
    ["2026-11-14", true],
    ["2026-11-15", false],
    ["2026-11-01", true],
  ])("due %s escalates: %p", (dueDate, expected) => {
    expect(isEscalated(task({ dueDate }), today)).toBe(expected);
  });

  test("Q2 task due tomorrow is shown in Q1, stored flag unchanged", () => {
    const t = task({ important: true, urgent: false, dueDate: "2026-11-13" });
    expect(displayBucket(t, today)).toBe(1);
    expect(t.urgent).toBe(false);
  });

  test("Q4 task overdue is shown in Q3", () => {
    expect(displayBucket(task({ important: false, urgent: false, dueDate: "2026-11-01" }), today)).toBe(3);
  });

  test("Inbox task is not escalated out of the Inbox", () => {
    const t = task({ important: null, urgent: null, dueDate: "2026-11-12" });
    expect(isEscalated(t, today)).toBe(false);
    expect(displayBucket(t, today)).toBe("inbox");
  });

  test("already urgent or done tasks are not marked as escalated", () => {
    expect(isEscalated(task({ urgent: true, dueDate: today }), today)).toBe(false);
    expect(isEscalated(task({ status: "done", dueDate: today }), today)).toBe(false);
  });

  test("window is configurable", () => {
    expect(isEscalated(task({ dueDate: "2026-11-15" }), today, 3)).toBe(true);
    expect(isEscalated(task({ dueDate: "2026-11-13" }), today, 0)).toBe(false);
  });
});

describe("tags", () => {
  test("parses #words, lowercased, unique, in order", () => {
    expect(parseTags("provide #Instagram and #messenger #instagram")).toEqual(["instagram", "messenger"]);
  });
  test("#opt-in is one tag and unicode letters count", () => {
    expect(parseTags("Add #opt-in attribute in #webhook #vacación")).toEqual(["opt-in", "webhook", "vacación"]);
  });
  test("slug drops emoji and punctuation", () => {
    expect(slug("🔥 TO-DO")).toBe("todo");
    expect(slug("🗄️ STASH")).toBe("stash");
  });
});
