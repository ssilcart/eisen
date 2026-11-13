// Pure layout of the settings screen (S21): the presets with a preview of
// their four labels laid out like the grid. app.ts styles the lines by kind.
import { getPreset, PRESET_IDS, type PresetId } from "../domain/presets.ts";
import { fit, windowStart } from "./layout.ts";

export const SETTINGS_HINTS = "j/k choose · Enter save · Esc cancel";

export type SettingsLineKind = "name" | "preview" | "hint" | "blank";

export interface SettingsLine {
  kind: SettingsLineKind;
  text: string;
  /** True on the lines of the preset under the cursor. */
  selected: boolean;
}

const INDENT = "    ";
const GAP = "   ";

/** `text` cut to `width` columns (with an ellipsis when cut), no padding. */
function clip(text: string, width: number): string {
  return Bun.stringWidth(text) <= width ? text : fit(text, width).trimEnd();
}

/** The two preview lines of a preset: `1 a   2 b` over `3 c   4 d`, columns aligned. */
function preview(id: PresetId): [string, string] {
  const { labels } = getPreset(id);
  const left = [`1 ${labels[1]}`, `3 ${labels[3]}`];
  const right = [`2 ${labels[2]}`, `4 ${labels[4]}`];
  const column = Math.max(...left.map((l) => Bun.stringWidth(l)));
  const line = (i: number) => `${INDENT}${left[i]}${" ".repeat(column - Bun.stringWidth(left[i]!))}${GAP}${right[i]}`;
  return [line(0), line(1)];
}

/** The widest line at full size, so the box can be sized to fit it. */
export function settingsWidth(): number {
  const widths = PRESET_IDS.flatMap((id) => [...preview(id), `› ${getPreset(id).name} · current`]);
  return Math.max(Bun.stringWidth(SETTINGS_HINTS), ...widths.map((l) => Bun.stringWidth(l)));
}

/** Lines at full size: per preset a name and two preview lines, a blank between presets. */
export function settingsHeight(): number {
  return PRESET_IDS.length * 3 + (PRESET_IDS.length - 1) + 2;
}

/**
 * The settings lines for an inner box of `width` × `height`: never wider or
 * taller. `current` is marked, `cursor` (an index in PRESET_IDS) gets a `›`
 * and stays visible when the rows run short. The key hints sit at the bottom.
 */
export function settingsLines(current: PresetId, cursor: number, width: number, height: number): SettingsLine[] {
  if (width <= 0 || height <= 0) return [];
  const body: SettingsLine[] = [];
  let cursorRow = 0;
  PRESET_IDS.forEach((id, i) => {
    const selected = i === cursor;
    if (i > 0) body.push({ kind: "blank", text: "", selected: false });
    if (selected) cursorRow = body.length;
    const name = `${selected ? "›" : " "} ${getPreset(id).name}${id === current ? " · current" : ""}`;
    body.push({ kind: "name", text: clip(name, width), selected });
    for (const line of preview(id)) body.push({ kind: "preview", text: clip(line, width), selected });
  });
  const hint: SettingsLine = { kind: "hint", text: clip(SETTINGS_HINTS, width), selected: false };
  // A blank line above the hints when there is room for everything.
  if (body.length + 2 <= height) return [...body, { kind: "blank", text: "", selected: false }, hint];
  if (height === 1) return [body[cursorRow]!];
  const room = height - 1;
  // Keep the cursor's name and its preview (3 lines) in view.
  const start = windowStart(cursorRow + Math.min(1, room - 1), body.length, room);
  return [...body.slice(start, start + room), hint];
}
