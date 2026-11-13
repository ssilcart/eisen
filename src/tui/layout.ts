// Pure layout helpers for the matrix: grid sizes, list windowing, text fitting.

export interface GridSizes {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const STATUS_HEIGHT = 1;

/**
 * Column widths and row heights of the 2×2 grid above the status bar and
 * the Inbox strip (`strip` rows, S24).
 */
export function gridSizes(width: number, height: number, strip = 0): GridSizes {
  const w = Math.max(0, width);
  const h = Math.max(0, height - STATUS_HEIGHT - strip);
  const left = Math.floor(w / 2);
  const top = Math.floor(h / 2);
  return { left, right: w - left, top, bottom: h - top };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest terminal the floating editor opens in (S22); below it the editor runs full screen. */
export const EDITOR_MIN_SCREEN = { width: 40, height: 12 } as const;

/** The floating editor box is never smaller than this while the screen allows it. */
const EDITOR_MIN_BOX = { width: 40, height: 10 } as const;

/** Share of the area above the status line the floating editor box takes. */
const EDITOR_SHARE = 0.7;

export function editorFits(width: number, height: number): boolean {
  return width >= EDITOR_MIN_SCREEN.width && height >= EDITOR_MIN_SCREEN.height;
}

/**
 * The floating editor box (S22), border included: about 70% x 70% of the
 * area above the status line, centred, at least 40 x 10 while that fits and
 * never past the area (a resize may shrink it below the minimum).
 */
export function editorBox(width: number, height: number): Rect {
  const areaW = Math.max(0, width);
  const areaH = Math.max(0, height - STATUS_HEIGHT);
  const w = Math.min(areaW, Math.max(EDITOR_MIN_BOX.width, Math.round(areaW * EDITOR_SHARE)));
  const h = Math.min(areaH, Math.max(EDITOR_MIN_BOX.height, Math.round(areaH * EDITOR_SHARE)));
  return { left: Math.floor((areaW - w) / 2), top: Math.floor((areaH - h) / 2), width: w, height: h };
}

/** Rows the grid keeps before the strip gives up its border: two pane rows of border + one task. */
export const GRID_MIN_ROWS = 6;

/** Bounds of the bordered Inbox strip, in rows (S24). */
export const STRIP_MIN = 3;
export const STRIP_MAX = 8;

/**
 * Rows of the Inbox strip under the grid (S24), border included: a quarter of
 * the rows above the status line, 3 to 8. When that would leave the grid
 * fewer than GRID_MIN_ROWS, it shrinks (never below 3); when even 3 do not
 * fit, it is a single title line and only then does the grid lose rows. Never
 * 2 (a border with nothing inside), 0 only when no row is left at all.
 */
export function stripHeight(height: number): number {
  const rows = Math.max(0, height - STATUS_HEIGHT);
  if (rows === 0) return 0;
  const wanted = Math.min(STRIP_MAX, Math.max(STRIP_MIN, Math.floor(rows / 4)));
  const spare = rows - GRID_MIN_ROWS;
  return spare >= STRIP_MIN ? Math.min(wanted, spare) : 1;
}

/** First row to show so `selected` is visible in `height` rows (roughly centred). */
export function windowStart(selected: number, count: number, height: number): number {
  if (height <= 0 || count <= height) return 0;
  const start = selected - Math.floor((height - 1) / 2);
  return Math.max(0, Math.min(start, count - height));
}

const ELLIPSIS = "…";

const graphemes = (text: string): string[] =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);

/**
 * Word-wraps `text` to `width` display columns. Explicit newlines start a new
 * line (blank lines are kept); a word wider than the line is hard-broken.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let used = 0;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const w = Bun.stringWidth(word);
      if (used > 0 && used + 1 + w <= width) {
        line += ` ${word}`;
        used += 1 + w;
        continue;
      }
      if (used > 0) out.push(line);
      line = "";
      used = 0;
      if (w <= width) {
        line = word;
        used = w;
        continue;
      }
      for (const g of graphemes(word)) {
        const gw = Bun.stringWidth(g);
        if (used + gw > width && used > 0) {
          out.push(line);
          line = "";
          used = 0;
        }
        if (gw > width) continue; // a wide character on a 1-column line
        line += g;
        used += gw;
      }
    }
    out.push(line);
  }
  return out;
}

/** Text padded or truncated (with an ellipsis) to exactly `width` display columns. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const full = Bun.stringWidth(text);
  if (full <= width) return text + " ".repeat(width - full);
  let out = "";
  let used = 0;
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  for (const { segment } of segments) {
    const w = Bun.stringWidth(segment);
    if (used + w > width - 1) break;
    out += segment;
    used += w;
  }
  return out + ELLIPSIS + " ".repeat(width - 1 - used);
}
