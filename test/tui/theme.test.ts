import { describe, expect, test } from "bun:test";
import { BUCKET_COLOR, COLOR, blend, paneStyle } from "../../src/tui/theme.ts";

// S23: one colour per quadrant, the same in every preset.
describe("theme (S23)", () => {
  test("the quadrant colours", () => {
    expect(BUCKET_COLOR).toEqual({ 1: "#E5534B", 2: "#F2A93B", 3: "#4C6EF5", 4: "#3FB97F", inbox: "#8B949E" });
  });

  test("a focused pane draws its border and title in its colour, bold", () => {
    expect(paneStyle(2, true)).toMatchObject({ border: "#F2A93B", title: "#F2A93B", bold: true });
  });

  test("an unfocused pane keeps a dim border and its title tinted", () => {
    expect(paneStyle(3, false)).toMatchObject({ border: COLOR.border, title: "#4C6EF5", bold: false });
  });

  test("the selected row is highlighted with the pane's colour over the background", () => {
    expect(paneStyle(1, true).selectBg).toBe(blend("#E5534B", COLOR.panel, 0.35));
    expect(paneStyle("inbox", true).selectBg).toBe(blend("#8B949E", COLOR.panel, 0.35));
    expect(new Set([1, 2, 3, 4, "inbox"].map((b) => paneStyle(b as 1, true).selectBg)).size).toBe(5);
  });

  test("blend mixes two hex colours", () => {
    expect(blend("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(blend("#E5534B", "#000000", 1)).toBe("#e5534b");
    expect(blend("#E5534B", "#16161e", 0)).toBe("#16161e");
  });
});
