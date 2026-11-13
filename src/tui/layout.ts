// Pure layout helpers for the matrix: grid sizes, list windowing, text fitting.

export interface GridSizes {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const STATUS_HEIGHT = 1;

/**
 * Column widths and row heights of the 2×2 grid above the status bar and,
 * while a search is active, the Inbox strip (`strip` rows, S19).
 */
export function gridSizes(width: number, height: number, strip = 0): GridSizes {
  const w = Math.max(0, width);
  const h = Math.max(0, height - STATUS_HEIGHT - strip);
  const left = Math.floor(w / 2);
  const top = Math.floor(h / 2);
  return { left, right: w - left, top, bottom: h - top };
}

/**
 * Rows of the Inbox strip shown under the grid while searching (S19), border
 * included: a quarter of the rows above the status line, 3 to 6, and never
 * more than a third of them.
 */
export function stripHeight(height: number): number {
  const rows = Math.max(0, height - STATUS_HEIGHT);
  const wanted = Math.min(6, Math.max(3, Math.floor(rows / 4)));
  return Math.min(wanted, Math.floor(rows / 3));
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
