import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_MIN_COLUMNS,
  editorBox,
  editorFits,
  fit,
  gridSizes,
  sidebarLayout,
  stripHeight,
  windowStart,
  wrap,
} from "../../src/tui/layout.ts";

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

describe("floating editor box (S22)", () => {
  test("about 70% x 70% of the area above the status line, centred", () => {
    expect(editorBox(100, 30)).toEqual({ left: 15, top: 4, width: 70, height: 20 });
    expect(editorBox(200, 60)).toEqual({ left: 30, top: 9, width: 140, height: 41 });
  });

  test("never smaller than 40 x 10 while that fits, never over the status line", () => {
    expect(editorBox(50, 14)).toEqual({ left: 5, top: 1, width: 40, height: 10 });
    expect(editorBox(40, 12)).toEqual({ left: 0, top: 0, width: 40, height: 10 });
    expect(editorBox(30, 6)).toEqual({ left: 0, top: 0, width: 30, height: 5 });
  });

  test("terminals under 40 x 12 are too small for the floating editor", () => {
    expect(editorFits(40, 12)).toBe(true);
    expect(editorFits(120, 40)).toBe(true);
    expect(editorFits(39, 40)).toBe(false);
    expect(editorFits(120, 11)).toBe(false);
  });
});

describe("sidebarLayout (S26)", () => {
  const both = { preview: true, done: true };
  const previewOnly = { preview: true, done: false };
  const doneOnly = { preview: false, done: true };
  const none = { preview: false, done: false };

  test("width: round(35%) of the terminal, clamped to 32-60 columns", () => {
    expect(sidebarLayout(160, 40, both)?.width).toBe(56);
    expect(sidebarLayout(120, 40, both)?.width).toBe(42);
    expect(sidebarLayout(100, 40, both)?.width).toBe(35);
    expect(sidebarLayout(200, 40, both)?.width).toBe(60);
    expect(sidebarLayout(400, 40, doneOnly)?.width).toBe(60);
  });

  test("hidden under 100 columns, whatever is on", () => {
    expect(SIDEBAR_MIN_COLUMNS).toBe(100);
    for (const panels of [both, previewOnly, doneOnly, none]) expect(sidebarLayout(99, 40, panels)).toBeNull();
    expect(sidebarLayout(60, 16, both)).toBeNull();
  });

  test("hidden when no panel is on", () => {
    for (const w of [160, 120, 100, 99]) expect(sidebarLayout(w, 40, none)).toBeNull();
  });

  test("both: preview on top ~60%, done panel below, full height above the status line", () => {
    for (const w of [160, 120, 100]) {
      expect(sidebarLayout(w, 40, both)).toMatchObject({ preview: 23, done: 16 });
    }
    expect(sidebarLayout(120, 30, both)).toMatchObject({ preview: 17, done: 12 });
  });

  test("one panel takes the whole height", () => {
    for (const w of [160, 120, 100]) {
      expect(sidebarLayout(w, 40, previewOnly)).toMatchObject({ preview: 39, done: 0 });
      expect(sidebarLayout(w, 40, doneOnly)).toMatchObject({ preview: 0, done: 39 });
    }
  });

  test("both but either under 5 rows: the done panel collapses to its title line", () => {
    expect(sidebarLayout(120, 13, both)).toMatchObject({ preview: 7, done: 5 });
    expect(sidebarLayout(120, 12, both)).toMatchObject({ preview: 10, done: 1 });
    expect(sidebarLayout(120, 10, both)).toMatchObject({ preview: 8, done: 1 });
  });

  test("at every size the rows add up to the area above the status line", () => {
    for (let h = 2; h <= 80; h++) {
      const s = sidebarLayout(120, h, both)!;
      expect(s.preview + s.done).toBe(h - 1);
      expect(s.done === 1 || (s.done >= 5 && s.preview >= 5)).toBe(true);
    }
  });
});
