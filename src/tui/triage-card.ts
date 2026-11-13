// Pure layout of the triage card (S12): which lines fit in the card's inner
// box, in priority order. app.ts styles them by kind.
import { fit, wrap } from "./layout.ts";

export const TRIAGE_HINTS = "1 Do · 2 Schedule · 3 Delegate · 4 Delete · s skip · e edit · d delete · Esc exit";

export type CardLineKind = "title" | "text" | "meta" | "hint" | "blank";

export interface CardLine {
  kind: CardLineKind;
  text: string;
}

export interface CardTask {
  title: string;
  description: string | null;
  tags: readonly string[];
  dueDate: string | null;
}

const MAX_TITLE_LINES = 3;

/** `text` cut to `width` columns, with an ellipsis when cut. */
function clip(text: string, width: number): string {
  return Bun.stringWidth(text) <= width ? text : fit(text, width).trimEnd();
}

/** The last line of a section that was cut short. */
function ellipsize(text: string, width: number): string {
  return fit(`${text}…`, width).trimEnd();
}

/** The hints wrapped between their items, so a key never leaves its label. */
function hintLines(width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const item of TRIAGE_HINTS.split(" · ")) {
    const next = line ? `${line} · ${item}` : item;
    if (Bun.stringWidth(next) <= width) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    line = clip(item, width);
  }
  if (line) out.push(line);
  return out;
}

/**
 * The card's lines for an inner box of `width` × `height`: never more lines
 * than `height`, never wider than `width`. When space is short the title's
 * first line goes first, then the key hints, tags and due date, the rest of
 * the title, and the description (cut with an ellipsis); blank lines last.
 * The hints sit at the bottom.
 */
export function cardLines(task: CardTask, width: number, height: number): CardLine[] {
  const w = Math.max(0, width);
  let room = Math.max(0, height);
  if (w === 0 || room === 0) return [];

  const title = wrap(task.title, w);
  if (title.length === 0) title.push("");
  const description = task.description?.trim() ? wrap(task.description.trim(), w) : [];
  const meta: string[] = [];
  if (task.tags.length > 0) meta.push(clip(task.tags.map((t) => `#${t}`).join(" "), w));
  if (task.dueDate) meta.push(clip(`Due ${task.dueDate}`, w));
  const hints = hintLines(w);

  const take = (want: number): number => {
    const n = Math.max(0, Math.min(want, room));
    room -= n;
    return n;
  };
  let nTitle = take(1);
  const nHints = take(hints.length);
  const nMeta = take(meta.length);
  nTitle += take(Math.min(title.length, MAX_TITLE_LINES) - 1);
  const nDesc = take(description.length);
  const gapAfterTitle = nDesc + nMeta > 0 ? take(1) : 0;
  const gapBeforeMeta = nDesc > 0 && nMeta > 0 ? take(1) : 0;

  const lines: CardLine[] = [];
  const section = (kind: CardLineKind, source: string[], n: number) => {
    source.slice(0, n).forEach((text, i) => {
      const cut = i === n - 1 && n < source.length;
      lines.push({ kind, text: cut ? ellipsize(text, w) : text });
    });
  };
  const blanks = (n: number) => {
    for (let i = 0; i < n; i++) lines.push({ kind: "blank", text: "" });
  };
  section("title", title, nTitle);
  blanks(gapAfterTitle);
  section("text", description, nDesc);
  blanks(gapBeforeMeta);
  section("meta", meta, nMeta);
  blanks(room); // pushes the hints to the bottom
  section("hint", hints, nHints);
  return lines;
}
