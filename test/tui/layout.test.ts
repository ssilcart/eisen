import { describe, expect, test } from "bun:test";
import { fit, gridSizes, windowStart } from "../../src/tui/layout.ts";

describe("windowStart", () => {
  test("everything fits: start at 0", () => {
    expect(windowStart(0, 3, 10)).toBe(0);
    expect(windowStart(2, 3, 3)).toBe(0);
  });

  test("the selection stays visible, roughly centred, never past the end", () => {
    for (let selected = 0; selected < 20; selected++) {
      const start = windowStart(selected, 20, 5);
      expect(selected).toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(start + 5);
      expect(start + 5).toBeLessThanOrEqual(20);
    }
    expect(windowStart(10, 20, 5)).toBe(8);
    expect(windowStart(19, 20, 5)).toBe(15);
  });

  test("no rows to show: start at 0", () => {
    expect(windowStart(3, 10, 0)).toBe(0);
  });
});

describe("fit", () => {
  test("pads short text to the width", () => {
    expect(fit("abc", 5)).toBe("abc  ");
  });

  test("truncates long text with an ellipsis", () => {
    expect(fit("abcdefgh", 5)).toBe("abcd…");
  });

  test("counts display width, not code units", () => {
    expect(fit("🔥 fire", 4)).toBe("🔥 …");
    expect(Bun.stringWidth(fit("compañía", 6))).toBe(6);
  });

  test("width 0 or less gives an empty string", () => {
    expect(fit("abc", 0)).toBe("");
  });
});

describe("gridSizes", () => {
  test("splits the screen into a 2×2 grid above a 1-line status bar", () => {
    expect(gridSizes(100, 31)).toEqual({ left: 50, right: 50, top: 15, bottom: 15 });
    expect(gridSizes(81, 24)).toEqual({ left: 40, right: 41, top: 11, bottom: 12 });
  });

  test("never negative on a tiny screen", () => {
    const g = gridSizes(1, 1);
    for (const v of Object.values(g)) expect(v).toBeGreaterThanOrEqual(0);
  });
});
