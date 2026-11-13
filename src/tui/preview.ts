// Pure line model of the preview panel (S25): what the selected task's
// panel shows in its inner box, and how far its description is scrolled.
// app.ts styles the lines by kind; Markdown is shown as plain text.
import { DEFAULT_URGENT_WITHIN_DAYS, displayBucket, isEscalated } from "../domain/escalation.ts";
import { headingFor, labelFor, type PresetId } from "../domain/presets.ts";
import type { Bucket, Task } from "../domain/task.ts";
import { fit, wrap } from "./layout.ts";

/** How the selected task is labelled: its displayed bucket, or done (S25). */
export interface PreviewInfo {
  /** `Q1 · ✅ Do`, `📥 Inbox` or `✓ Done · 2026-11-12`. */
  label: string;
  /** Which colour the label takes. */
  bucket: Bucket | "done";
  /** The due date escalated the task (S7): `due:` gets a `!`. */
  escalated: boolean;
}

export type PreviewLineKind = "title" | "label" | "due" | "tags" | "blank" | "text" | "footer" | "empty";

export interface PreviewLine {
  kind: PreviewLineKind;
  text: string;
}

export interface PreviewModel {
  /** Never more than the height, never wider than the width. */
  lines: PreviewLine[];
  /** The description's first shown line, clamped to 0..maxScroll. */
  scroll: number;
  maxScroll: number;
  /** Rows the description gets. */
  bodyRows: number;
  /** The description's wrapped lines. */
  total: number;
}

export type PreviewTask = Pick<
  Task,
  "title" | "description" | "tags" | "dueDate" | "status" | "createdAt" | "updatedAt" | "completedAt"
>;

/** YYYY-MM-DD of an ISO timestamp in local time; the input itself when it is not a date. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The bucket label of `task` (S25) with `preset`'s names, escalated as on screen (S7). */
export function previewInfo(
  task: Task,
  preset: PresetId,
  today: string,
  withinDays = DEFAULT_URGENT_WITHIN_DAYS,
): PreviewInfo {
  if (task.status === "done") {
    const day = task.completedAt ? ` · ${localDate(task.completedAt)}` : "";
    return { label: `✓ Done${day}`, bucket: "done", escalated: false };
  }
  const bucket = displayBucket(task, today, withinDays);
  const label = bucket === "inbox" ? labelFor(preset, "inbox") : headingFor(preset, bucket);
  return { label, bucket, escalated: isEscalated(task, today, withinDays) };
}

/** `text` cut to `width` columns, with an ellipsis when cut. */
function clip(text: string, width: number): string {
  return Bun.stringWidth(text) <= width ? text : fit(text, width).trimEnd();
}

const NO_TASK = "No task selected";

/** `created YYYY-MM-DD · updated YYYY-MM-DD`, with `MM-DD` dates when that does not fit, then cut. */
function footerText(task: PreviewTask, width: number): string {
  const created = localDate(task.createdAt);
  const updated = localDate(task.updatedAt);
  const full = `created ${created} · updated ${updated}`;
  if (Bun.stringWidth(full) <= width) return full;
  const short = (day: string) => (/^\d{4}-/.test(day) ? day.slice(5) : day);
  return clip(`created ${short(created)} · updated ${short(updated)}`, width);
}

/**
 * The panel's lines for an inner box of `width` x `height` (S25): the title
 * wrapped, the bucket label, `due:` (with `!` when escalated), `#tags`, a
 * blank line, the description from line `scroll` on, and the footer
 * `created … · updated …` on the last row. When rows are short the first
 * title line goes first, then the label, the footer, due, tags, the rest of
 * the title, and the description last. `null` (nothing selected) is
 * `No task selected`.
 */
export function previewLines(
  task: PreviewTask | null,
  width: number,
  height: number,
  scroll: number,
  info: PreviewInfo | null,
): PreviewModel {
  const w = Math.max(0, width);
  let room = Math.max(0, height);
  const none: PreviewModel = { lines: [], scroll: 0, maxScroll: 0, bodyRows: 0, total: 0 };
  if (w === 0 || room === 0) return none;
  if (!task || !info) return { ...none, lines: [{ kind: "empty", text: clip(NO_TASK, w) }] };

  const title = wrap(task.title, w);
  if (title.length === 0) title.push("");
  const label = clip(info.label, w);
  const due = task.dueDate ? clip(`due: ${task.dueDate}${info.escalated ? " !" : ""}`, w) : null;
  const tags = task.tags.length > 0 ? clip(task.tags.map((t) => `#${t}`).join(" "), w) : null;
  const footer = footerText(task, w);
  const description = task.description?.trim() ? wrap(task.description.trim(), w) : [];

  const take = (want: number): number => {
    const n = Math.max(0, Math.min(want, room));
    room -= n;
    return n;
  };
  let nTitle = take(1);
  const nLabel = take(1);
  const nFooter = take(1);
  const nDue = due ? take(1) : 0;
  const nTags = tags ? take(1) : 0;
  nTitle += take(title.length - 1);
  // The blank line before the description only when a description row fits after it.
  const gap = description.length > 0 && room >= 2 ? take(1) : 0;
  const bodyRows = gap ? take(room) : 0;
  const maxScroll = Math.max(0, description.length - bodyRows);
  const start = Math.max(0, Math.min(Math.trunc(scroll) || 0, maxScroll));

  const lines: PreviewLine[] = [];
  for (const text of title.slice(0, nTitle)) lines.push({ kind: "title", text });
  if (nLabel) lines.push({ kind: "label", text: label });
  if (nDue) lines.push({ kind: "due", text: due! });
  if (nTags) lines.push({ kind: "tags", text: tags! });
  if (gap) lines.push({ kind: "blank", text: "" });
  for (const text of description.slice(start, start + bodyRows)) lines.push({ kind: "text", text });
  // Pad so the footer sits on the last row.
  const filled = Math.max(0, height) - nFooter;
  while (lines.length < filled) lines.push({ kind: "blank", text: "" });
  if (nFooter) lines.push({ kind: "footer", text: footer });
  return { lines, scroll: start, maxScroll, bodyRows, total: description.length };
}
