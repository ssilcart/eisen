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

describe("stripHeight (S24)", () => {
  test("a quarter of the rows above the status line, 3 to 8 rows with its border", () => {
    expect(stripHeight(30)).toBe(7); // 120×30
    expect(stripHeight(16)).toBe(3); // 60×16
    expect(stripHeight(10)).toBe(3); // 30×10: the grid keeps 3 + 3 rows
    expect(stripHeight(17)).toBe(4);
    expect(stripHeight(41)).toBe(8);
    expect(stripHeight(100)).toBe(8);
    expect(stripHeight(10_000)).toBe(8);
  });

  test("on a tiny screen it shrinks to one line (title only) before the grid loses rows", () => {
    expect(stripHeight(9)).toBe(1); // 3 rows would leave the grid 5
    expect(stripHeight(8)).toBe(1);
    expect(stripHeight(3)).toBe(1);
    expect(stripHeight(2)).toBe(1);
    expect(stripHeight(1)).toBe(0); // only the status line
    expect(stripHeight(0)).toBe(0);
    expect(stripHeight(-5)).toBe(0);
  });

  test("at every height: never 2 rows, the grid keeps 6 rows while the strip has a border", () => {
    for (let h = 0; h <= 300; h++) {
      const strip = stripHeight(h);
      const rows = Math.max(0, h - 1);
      expect(strip).toBeGreaterThanOrEqual(0);
      expect(strip).toBeLessThanOrEqual(8);
      expect(strip).not.toBe(2);
      expect(strip).toBeLessThanOrEqual(rows);
      if (rows >= 1) expect(strip).toBeGreaterThanOrEqual(1); // always visible
      if (strip >= 3) expect(rows - strip).toBeGreaterThanOrEqual(6);
      const g = gridSizes(300, h, strip);
      expect(g.top + g.bottom + strip).toBe(rows);
    }
  });
});
