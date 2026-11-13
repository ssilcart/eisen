import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PRESET,
  INBOX_LABEL,
  PRESETS,
  PRESET_IDS,
  getPreset,
  headingFor,
  isPresetId,
  labelFor,
} from "../../src/domain/presets.ts";
import { QUADRANTS } from "../../src/domain/task.ts";

// S20: presets change only the labels and emoji, never the stored flags.
describe("quadrant presets (S20)", () => {
  test("classic is the default and the order is classic, priority, focus", () => {
    expect(DEFAULT_PRESET).toBe("classic");
    expect(PRESET_IDS).toEqual(["classic", "priority", "focus"]);
    expect(PRESETS.map((p) => p.id)).toEqual(["classic", "priority", "focus"]);
  });

  test("classic labels", () => {
    expect(QUADRANTS.map((q) => labelFor("classic", q))).toEqual(["✅ Do", "📅 Schedule", "🤝 Delegate", "🧹 Delete"]);
  });

  test("priority labels (the user's reference image)", () => {
    expect(QUADRANTS.map((q) => labelFor("priority", q))).toEqual([
      "🔴 Urgent & Important",
      "🟠 Not Urgent & Important",
      "🔵 Urgent & Unimportant",
      "🟢 Not Urgent & Unimportant",
    ]);
  });

  test("focus labels (hybrid, English)", () => {
    expect(QUADRANTS.map((q) => labelFor("focus", q))).toEqual(["🔥 Urgent", "⭐ Important", "⚡ Needs attention", "🧊 Someday"]);
  });

  test("the Inbox is 📥 Inbox in every preset", () => {
    expect(INBOX_LABEL).toBe("📥 Inbox");
    for (const id of PRESET_IDS) expect(labelFor(id, "inbox")).toBe("📥 Inbox");
  });

  test("headings carry the quadrant number, which the importer reads", () => {
    expect(headingFor("classic", 1)).toBe("Q1 · ✅ Do");
    expect(headingFor("priority", 2)).toBe("Q2 · 🟠 Not Urgent & Important");
    expect(headingFor("focus", 4)).toBe("Q4 · 🧊 Someday");
    expect(headingFor("focus", "inbox")).toBe("📥 Inbox");
  });

  test("every emoji is one default-emoji code point of display width 2 (no VS16)", () => {
    for (const id of PRESET_IDS) {
      for (const bucket of [...QUADRANTS, "inbox"] as const) {
        const label = labelFor(id, bucket);
        const [emoji, ...rest] = label.split(" ");
        expect(Array.from(emoji!)).toHaveLength(1);
        expect(emoji).not.toContain("\uFE0F");
        expect(/\p{Emoji_Presentation}/u.test(emoji!)).toBe(true);
        expect(Bun.stringWidth(emoji!)).toBe(2);
        // The label is as wide as its text plus 2 for the emoji.
        expect(Bun.stringWidth(label)).toBe(2 + 1 + rest.join(" ").length);
      }
    }
  });

  test("isPresetId and getPreset", () => {
    expect(isPresetId("focus")).toBe(true);
    expect(isPresetId("Focus")).toBe(false);
    expect(isPresetId(undefined)).toBe(false);
    expect(getPreset("priority").name).toBe("Priority");
  });
});
