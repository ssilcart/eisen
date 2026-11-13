import { describe, expect, test } from "bun:test";
import { fit, gridSizes, stripHeight, windowStart, wrap } from "../../src/tui/layout.ts";

describe("wrap", () => {
  test("breaks on spaces to fit the width", () => {
    expect(wrap("poder organizar los subitems", 12)).toEqual(["poder", "organizar", "los subitems"]);
    expect(wrap("short", 20)).toEqual(["short"]);
  });

  test("keeps explicit newlines and blank lines", () => {
    expect(wrap("one\n\ntwo three", 5)).toEqual(["one", "", "two", "three"]);
  });

  test("hard-breaks words longer than the width, by display width", () => {
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    for (const line of wrap("🔥🔥🔥 compañía", 4)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(4);
  });

  test("a zero or negative width gives no lines", () => {
    expect(wrap("anything", 0)).toEqual([]);
  });
});

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

  test("leaves room for the Inbox strip under the grid (S19)", () => {
    expect(gridSizes(100, 31, 6)).toEqual({ left: 50, right: 50, top: 12, bottom: 12 });
    const g = gridSizes(10, 3, 6);
    for (const v of Object.values(g)) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("stripHeight (S19)", () => {
  test("a quarter of the rows above the status line, 3 to 6 rows with its border", () => {
    expect(stripHeight(30)).toBe(6);
    expect(stripHeight(100)).toBe(6);
    expect(stripHeight(17)).toBe(4);
    expect(stripHeight(10)).toBe(3);
  });

  test("never more than a third of the screen above the status line", () => {
    expect(stripHeight(7)).toBe(2);
    expect(stripHeight(2)).toBe(0);
    expect(stripHeight(0)).toBe(0);
  });
});
