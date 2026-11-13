import { describe, expect, test } from "bun:test";
import { labelFor, PRESET_IDS } from "../../src/domain/presets.ts";
import { QUADRANTS } from "../../src/domain/task.ts";
import { SETTINGS_HINTS, settingsLines } from "../../src/tui/settings.ts";

const texts = (...args: Parameters<typeof settingsLines>) => settingsLines(...args).map((l) => l.text);

describe("settingsLines (S21)", () => {
  test("lists every preset with a preview of its four labels, emoji included", () => {
    const all = texts("classic", 0, 80, 30).join("\n");
    for (const id of PRESET_IDS) for (const q of QUADRANTS) expect(all).toContain(`${q} ${labelFor(id, q)}`);
    expect(all).toContain("Classic");
    expect(all).toContain("Priority");
    expect(all).toContain("Focus");
  });

  test("marks the current preset and the cursor", () => {
    const lines = settingsLines("priority", 2, 80, 30);
    const names = lines.filter((l) => l.kind === "name");
    expect(names.map((l) => l.text.trimEnd())).toEqual(["  Classic", "  Priority · current", "› Focus"]);
    expect(names.map((l) => l.selected)).toEqual([false, false, true]);
  });

  test("the preview mirrors the grid: 1 and 2 on a line, 3 and 4 on the next", () => {
    const lines = texts("classic", 0, 80, 30);
    const one = lines.find((l) => l.includes("1 ✅ Do"))!;
    expect(one).toContain("2 📅 Schedule");
    const three = lines.find((l) => l.includes("3 🤝 Delegate"))!;
    expect(three).toContain("4 🧹 Delete");
    // The second column starts at the same display column on both lines.
    const col = (line: string, text: string) => Bun.stringWidth(line.slice(0, line.indexOf(text)));
    expect(col(one, "2 📅")).toBe(col(three, "4 🧹"));
  });

  test("the key hints are on the last line", () => {
    const lines = settingsLines("classic", 0, 80, 30);
    expect(lines.at(-1)).toMatchObject({ kind: "hint", text: SETTINGS_HINTS });
    expect(SETTINGS_HINTS).toBe("j/k choose · Enter save · Esc cancel");
  });

  test("never wider than the width nor taller than the height", () => {
    for (const [w, h] of [
      [80, 30],
      [40, 10],
      [20, 5],
      [8, 3],
    ] as const) {
      const lines = settingsLines("focus", 1, w, h);
      expect(lines.length).toBeLessThanOrEqual(h);
      for (const line of lines) expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(w);
    }
  });

  test("when short of rows the cursor's preset stays visible", () => {
    const all = texts("classic", 2, 60, 5).join("\n");
    expect(all).toContain("› Focus");
    expect(all).toContain("🔥 Urgent");
    expect(all).not.toContain("Classic");
  });

  test("nothing for an empty box", () => {
    expect(settingsLines("classic", 0, 0, 10)).toEqual([]);
    expect(settingsLines("classic", 0, 10, 0)).toEqual([]);
  });
});
