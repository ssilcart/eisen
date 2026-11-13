// Pure layout helpers for the matrix: grid sizes, list windowing, text fitting.

export interface GridSizes {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const STATUS_HEIGHT = 1;

/** Column widths and row heights of the 2×2 grid above the status bar. */
export function gridSizes(width: number, height: number): GridSizes {
  const w = Math.max(0, width);
  const h = Math.max(0, height - STATUS_HEIGHT);
  const left = Math.floor(w / 2);
  const top = Math.floor(h / 2);
  return { left, right: w - left, top, bottom: h - top };
}

/** First row to show so `selected` is visible in `height` rows (roughly centred). */
export function windowStart(selected: number, count: number, height: number): number {
  if (height <= 0 || count <= height) return 0;
  const start = selected - Math.floor((height - 1) / 2);
  return Math.max(0, Math.min(start, count - height));
}

const ELLIPSIS = "…";

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
