// The TUI's only colour table. S23: one colour per quadrant (from the user's
// reference image) and grey for the Inbox, the same in every preset.
import type { Bucket } from "../domain/task.ts";

export const COLOR = {
  border: "#4b5263",
  focus: "#7aa2f7",
  title: "#a9b1d6",
  text: "#c0caf5",
  muted: "#7f849c",
  done: "#5c6370",
  escalated: "#f7768e",
  due: "#e0af68",
  ok: "#9ece6a",
  selectBg: "#3b4261",
  statusBg: "#1f2335",
  panel: "#16161e",
  /**
   * The rule between the matrix and the sidebar: the focus blue at 65% over
   * the panel (blend(focus, panel, 0.65)). Bluer and brighter than the grey
   * pane borders, dimmer than a focused pane's full colour.
   */
  divider: "#5771ab",
} as const;

export const BUCKET_COLOR: Readonly<Record<Bucket, string>> = {
  1: "#E5534B",
  2: "#F2A93B",
  3: "#4C6EF5",
  4: "#3FB97F",
  inbox: "#8B949E",
};

/** The done panel's own colour (S27): its border and title while focused. */
export const DONE_COLOR = COLOR.ok;

/** How much of its colour the sidebar rule keeps over the panel. */
const DIVIDER_TINT = 0.65;

/** The sidebar rule's colour: the done panel's, dimmed, while the sidebar has focus. */
export function dividerColor(sidebarFocused: boolean): string {
  return sidebarFocused ? blend(DONE_COLOR, COLOR.panel, DIVIDER_TINT) : COLOR.divider;
}

/** How much of the pane's colour tints the selected row's background. */
const SELECT_TINT = 0.35;

export interface PaneStyle {
  border: string;
  title: string;
  /** The focused pane's title is bold. */
  bold: boolean;
  /** Background of the selected row (only the focused pane shows one). */
  selectBg: string;
}

/**
 * S23: the focused pane draws its border and title in its colour, bold, and
 * its selected row on a tint of it; the others keep a dim border with the
 * title in their colour.
 */
export function paneStyle(bucket: Bucket | "done", focused: boolean): PaneStyle {
  const color = bucket === "done" ? DONE_COLOR : BUCKET_COLOR[bucket];
  return {
    border: focused ? color : COLOR.border,
    title: color,
    bold: focused,
    selectBg: blend(color, COLOR.panel, SELECT_TINT),
  };
}

/** `over` mixed with `under`: `amount` 1 is all `over`, 0 all `under` (lowercase hex). */
export function blend(over: string, under: string, amount: number): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const a = rgb(over);
  const b = rgb(under);
  return `#${a
    .map((v, i) => Math.round(v * amount + b[i]! * (1 - amount)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}
