import { describe, expect, test } from "bun:test";
import { TRIAGE_HINTS, cardLines, triageHints, type CardTask } from "../../src/tui/triage-card.ts";

const task: CardTask = {
  title: "provide new meta permissions integration description for sending messages #instagram and #messenger",
  description: "send to #rainer description for prototype record",
  tags: ["todo", "instagram", "messenger", "rainer"],
  dueDate: "2026-11-20",
};

const texts = (width: number, height: number, t: CardTask = task) => cardLines(t, width, height).map((l) => l.text);

describe("cardLines (S12)", () => {
  test("a roomy card shows the title, description, tags, due date and the key hints", () => {
    const lines = cardLines(task, 120, 20);
    const all = lines.map((l) => l.text).join("\n");
    expect(lines[0]).toEqual({ kind: "title", text: task.title });
    expect(all).toContain("send to #rainer description for prototype record");
    expect(all).toContain("#todo #instagram #messenger #rainer");
    expect(all).toContain("Due 2026-11-20");
    expect(all).toContain(TRIAGE_HINTS);
    // The hints sit on the last line, the card fills its height.
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toEqual({ kind: "hint", text: TRIAGE_HINTS });
  });

  test("the hints are the S12 keys, with the classic labels by default", () => {
    expect(TRIAGE_HINTS).toBe("1 ✅ Do · 2 📅 Schedule · 3 🤝 Delegate · 4 🧹 Delete · s skip · e edit · d delete · Esc exit");
    expect(triageHints("classic")).toBe(TRIAGE_HINTS);
  });

  test("the hints follow the active preset (S20) and the card uses the ones it is given", () => {
    const hints = triageHints("focus");
    expect(hints).toBe("1 🔥 Urgent · 2 ⭐ Important · 3 ⚡ Needs attention · 4 🧊 Someday · s skip · e edit · d delete · Esc exit");
    expect(cardLines(task, 120, 20, hints).at(-1)).toEqual({ kind: "hint", text: hints });
    // Wrapped between items, never wider than the card.
    const narrow = cardLines(task, 30, 20, triageHints("priority")).filter((l) => l.kind === "hint");
    expect(narrow.length).toBeGreaterThan(1);
    expect(narrow.map((l) => l.text)).toContain("1 🔴 Urgent & Important");
    for (const line of narrow) expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(30);
  });

  test("long titles and descriptions wrap to the width", () => {
    const lines = cardLines(task, 30, 20);
    expect(lines.filter((l) => l.kind === "title").length).toBeGreaterThan(1);
    for (const line of lines) expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(30);
  });

  test("a description too long for the room is truncated with an ellipsis", () => {
    const long = { ...task, description: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") };
    const lines = cardLines(long, 60, 12);
    expect(lines).toHaveLength(12);
    const desc = lines.filter((l) => l.kind === "text");
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.at(-1)!.text).toEndWith("…");
    expect(lines.map((l) => l.text).join("\n")).not.toContain("line 39");
    // Title, tags, due date and hints are kept.
    expect(lines[0]!.kind).toBe("title");
    expect(lines.some((l) => l.text.includes("#todo"))).toBe(true);
    expect(lines.some((l) => l.text.includes("Due 2026-11-20"))).toBe(true);
    expect(lines.at(-1)!.kind).toBe("hint");
  });

  test("a task with no description, tags or due date shows just the title and hints", () => {
    const lines = cardLines({ title: "Plain", description: null, tags: [], dueDate: null }, 100, 6);
    expect(lines[0]).toEqual({ kind: "title", text: "Plain" });
    expect(lines.filter((l) => l.kind === "meta" || l.kind === "text")).toEqual([]);
    expect(lines.at(-1)!.kind).toBe("hint");
  });

  test("never exceeds the box at small or degenerate sizes", () => {
    for (const [w, h] of [
      [26, 7],
      [10, 3],
      [5, 1],
      [1, 1],
      [0, 0],
      [-3, -1],
      [80, 0],
    ] as const) {
      const lines = texts(w, h);
      expect(lines.length).toBeLessThanOrEqual(Math.max(0, h));
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(Math.max(0, w));
    }
    // The title wins the first line even when there is room for one line only.
    expect(cardLines(task, 26, 1)[0]!.kind).toBe("title");
  });
});
