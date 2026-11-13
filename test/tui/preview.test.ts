import { describe, expect, test } from "bun:test";
import type { Task } from "../../src/domain/task.ts";
import { localDate, previewInfo, previewLines, type PreviewInfo } from "../../src/tui/preview.ts";

const TODAY = "2026-11-12";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Pay rent",
    description: null,
    important: true,
    urgent: true,
    dueDate: null,
    tags: [],
    status: "open",
    position: 0,
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-11T09:00:00.000Z",
    completedAt: null,
    ...over,
  };
}

const info = (t: Task): PreviewInfo => previewInfo(t, "classic", TODAY);
const texts = (t: Task | null, width: number, height: number, scroll = 0) =>
  previewLines(t, width, height, scroll, t ? info(t) : null).lines.map((l) => l.text);

describe("previewInfo (S25)", () => {
  test("the bucket label: the quadrant heading, the Inbox, or ✓ Done with its completion date", () => {
    expect(info(task())).toMatchObject({ label: "Q1 · ✅ Do", bucket: 1, escalated: false });
    expect(info(task({ important: null, urgent: null }))).toMatchObject({ label: "📥 Inbox", bucket: "inbox" });
    const done = task({ status: "done", completedAt: "2026-11-12T10:00:00.000Z" });
    expect(info(done)).toMatchObject({ label: `✓ Done · ${localDate(done.completedAt!)}`, bucket: "done" });
  });

  test("an escalated task (S7) is labelled with its displayed quadrant and marked", () => {
    const t = task({ important: true, urgent: false, dueDate: "2026-11-13" });
    expect(info(t)).toMatchObject({ label: "Q1 · ✅ Do", bucket: 1, escalated: true });
    expect(previewInfo(t, "focus", TODAY).label).toBe("Q1 · 🔥 Urgent");
  });
});

describe("previewLines (S25)", () => {
  test("nothing selected: `No task selected`", () => {
    const model = previewLines(null, 30, 10, 0, null);
    expect(model.lines).toEqual([{ kind: "empty", text: "No task selected" }]);
  });

  test("title, label, due, tags, blank, description, and the footer on the last line", () => {
    const t = task({
      title: "Renew passport",
      dueDate: "2026-11-20",
      tags: ["admin", "travel"],
      description: "Book the appointment\n\nBring two photos",
    });
    const lines = previewLines(t, 40, 12, 0, info(t)).lines;
    expect(lines).toHaveLength(12);
    expect(lines.slice(0, 9)).toEqual([
      { kind: "title", text: "Renew passport" },
      { kind: "label", text: "Q1 · ✅ Do" },
      { kind: "due", text: "due: 2026-11-20" },
      { kind: "tags", text: "#admin #travel" },
      { kind: "blank", text: "" },
      { kind: "text", text: "Book the appointment" },
      { kind: "text", text: "" },
      { kind: "text", text: "Bring two photos" },
      { kind: "blank", text: "" },
    ]);
    expect(lines.at(-1)).toEqual({
      kind: "footer",
      text: `created ${localDate(t.createdAt)} · updated ${localDate(t.updatedAt)}`,
    });
  });

  test("due gets ! when escalated; no due or tags line when there are none", () => {
    const t = task({ important: true, urgent: false, dueDate: "2026-11-13" });
    const all = texts(t, 40, 8);
    expect(all).toContain("due: 2026-11-13 !");
    expect(texts(task(), 40, 8).filter((s) => s.startsWith("due:") || s.startsWith("#"))).toEqual([]);
  });

  test("the title wraps; no line is wider than the panel", () => {
    const t = task({
      title: "provide new meta permissions integration description for sending messages",
      description: "x ".repeat(80),
      tags: ["instagram", "messenger", "rainer", "todo"],
    });
    const lines = previewLines(t, 20, 15, 0, info(t)).lines;
    expect(lines.filter((l) => l.kind === "title").length).toBeGreaterThan(1);
    for (const l of lines) expect(Bun.stringWidth(l.text)).toBeLessThanOrEqual(20);
    expect(lines).toHaveLength(15);
  });

  test("a 40-line description scrolls: scroll is clamped, the header and footer stay", () => {
    const description = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const t = task({ description });
    const top = previewLines(t, 30, 12, 0, info(t));
    // title, label, blank, 8 description rows, footer
    expect(top.bodyRows).toBe(8);
    expect(top.total).toBe(40);
    expect(top.maxScroll).toBe(32);
    expect(top.lines.filter((l) => l.kind === "text").map((l) => l.text)).toEqual(
      Array.from({ length: 8 }, (_, i) => `line ${i + 1}`),
    );
    const down = previewLines(t, 30, 12, 10, info(t));
    expect(down.scroll).toBe(10);
    expect(down.lines[0]).toEqual({ kind: "title", text: "Pay rent" });
    expect(down.lines.find((l) => l.kind === "text")!.text).toBe("line 11");
    expect(down.lines.at(-1)!.kind).toBe("footer");
    const past = previewLines(t, 30, 12, 999, info(t));
    expect(past.scroll).toBe(32);
    expect(past.lines.filter((l) => l.kind === "text").at(-1)!.text).toBe("line 40");
    expect(previewLines(t, 30, 12, -5, info(t)).scroll).toBe(0);
  });

  test("a narrow panel shortens the footer's dates to MM-DD before cutting it", () => {
    const t = task();
    const full = `created ${localDate(t.createdAt)} · updated ${localDate(t.updatedAt)}`;
    const short = `created ${localDate(t.createdAt).slice(5)} · updated ${localDate(t.updatedAt).slice(5)}`;
    expect(previewLines(t, 39, 6, 0, info(t)).lines.at(-1)!.text).toBe(full);
    expect(previewLines(t, 30, 6, 0, info(t)).lines.at(-1)!.text).toBe(short);
    expect(Bun.stringWidth(previewLines(t, 20, 6, 0, info(t)).lines.at(-1)!.text)).toBeLessThanOrEqual(20);
  });

  test("a short panel keeps the first title line, the label and the footer before the description", () => {
    const t = task({ description: "one\ntwo", dueDate: "2026-11-20", tags: ["a"] });
    expect(previewLines(t, 30, 3, 0, info(t)).lines.map((l) => l.kind)).toEqual(["title", "label", "footer"]);
    expect(previewLines(t, 30, 1, 0, info(t)).lines.map((l) => l.kind)).toEqual(["title"]);
    expect(previewLines(t, 0, 10, 0, info(t)).lines).toEqual([]);
    expect(previewLines(t, 30, 0, 0, info(t)).lines).toEqual([]);
  });
});
