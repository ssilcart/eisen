// Pure model of the settings screen (S33, after S21): three sections shown as
// tabs (General, Editor, Keys), the rows of each section, their lines for a
// box of a given size, and the key edits of the Keys section with their
// config patches. app.ts styles the lines by kind and runs the saves; the
// key → action mapping is state.ts's.
import type { EditorDisplay, EditorMode, EditorSettings, ViewSettings } from "../config.ts";
import { getPreset, PRESET_IDS, type PresetId } from "../domain/presets.ts";
import { fit, windowStart } from "./layout.ts";
import { ACTIONS, GUARDED_ACTIONS, checkKey, conflictFor, keysOf, type ActionDef, type Keymap } from "./keymap.ts";

export type SettingsSection = "general" | "editor" | "keys";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["general", "editor", "keys"];

const SECTION_LABEL: Record<SettingsSection, string> = { general: "General", editor: "Editor", keys: "Keys" };

/** The status line's hints per section. */
export const SETTINGS_HINTS: Readonly<Record<SettingsSection, string>> = {
  general: "Tab section · j/k move · Enter change · Esc close",
  editor: "Tab section · j/k move · Enter change · Esc close",
  keys: "Enter set · a add · Backspace remove · r reset · R reset all · Tab section · Esc close",
};

export type ViewField = keyof ViewSettings;

const VIEW_FIELDS: readonly ViewField[] = ["preview", "donePanel", "bullets"];
const VIEW_LABEL: Record<ViewField, string> = { preview: "Preview", donePanel: "Done panel", bullets: "Bullets" };

/** The commands offered for `command` mode (S32); anything else is `Custom…`. */
export const EDITOR_COMMANDS: readonly string[] = ["nvim", "vim", "nano", "hx"];
const MODES: readonly EditorMode[] = ["auto", "command", "form"];
const DISPLAYS: readonly EditorDisplay[] = ["floating", "fullscreen"];
const MODE_NOTE: Record<EditorMode, string> = {
  auto: "$VISUAL, $EDITOR or vi",
  command: "the command below",
  form: "a form inside eisen",
};
const DISPLAY_NOTE: Record<EditorDisplay, string> = { floating: "a box over the matrix", fullscreen: "the whole terminal" };

/** A row the cursor can be on. */
export type SettingsRow =
  | { kind: "preset"; preset: PresetId }
  | { kind: "view"; field: ViewField }
  | { kind: "mode"; mode: EditorMode }
  /** `command: null` is `Custom…`. */
  | { kind: "command"; command: string | null }
  | { kind: "display"; display: EditorDisplay }
  | { kind: "key"; action: ActionDef };

/** What the screen shows: the values in use. */
export interface SettingsValues {
  preset: PresetId;
  view: ViewSettings;
  editor: EditorSettings;
  keymap: Keymap;
}

export function isCustomCommand(command: string): boolean {
  return !EDITOR_COMMANDS.includes(command);
}

/**
 * The rows of a section, in order. Editor: Command only for `command` mode,
 * Display only for auto and command (S33). Keys: every action (matrix, then triage).
 */
export function settingsRows(section: SettingsSection, editor: Pick<EditorSettings, "mode">): readonly SettingsRow[] {
  switch (section) {
    case "general":
      return [
        ...PRESET_IDS.map((preset): SettingsRow => ({ kind: "preset", preset })),
        ...VIEW_FIELDS.map((field): SettingsRow => ({ kind: "view", field })),
      ];
    case "editor":
      return [
        ...MODES.map((mode): SettingsRow => ({ kind: "mode", mode })),
        ...(editor.mode === "command"
          ? [...EDITOR_COMMANDS, null].map((command): SettingsRow => ({ kind: "command", command }))
          : []),
        ...(editor.mode === "form" ? [] : DISPLAYS.map((display): SettingsRow => ({ kind: "display", display }))),
      ];
    case "keys":
      return ACTIONS.map((action): SettingsRow => ({ kind: "key", action }));
  }
}

// ── Lines ───────────────────────────────────────────────────────────────────

export type SettingsLineKind = "tabs" | "heading" | "row" | "preview" | "blank";

export interface SettingsLine {
  kind: SettingsLineKind;
  text: string;
  /** True on the lines of the row under the cursor. */
  selected: boolean;
  /** Keys rows: the action's keys differ from its defaults (`*`). */
  changed?: boolean;
  /** The tabs line's labels, for styling the active one. */
  tabs?: readonly { label: string; active: boolean }[];
}

const INDENT = "    ";
const GAP = "   ";
const TAB_GAP = "   ";

/** `text` cut to `width` columns (with an ellipsis when cut), no padding. */
function clip(text: string, width: number): string {
  return Bun.stringWidth(text) <= width ? text : fit(text, width).trimEnd();
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)));

/** The two preview lines of a preset: `1 a   2 b` over `3 c   4 d`, columns aligned. */
function presetPreview(id: PresetId): [string, string] {
  const { labels } = getPreset(id);
  const left = [`1 ${labels[1]}`, `3 ${labels[3]}`];
  const right = [`2 ${labels[2]}`, `4 ${labels[4]}`];
  const column = Math.max(...left.map((l) => Bun.stringWidth(l)));
  const line = (i: number) => `${INDENT}${pad(left[i]!, column)}${GAP}${right[i]}`;
  return [line(0), line(1)];
}

function tabsLine(section: SettingsSection): SettingsLine {
  const tabs = SETTINGS_SECTIONS.map((s) => ({ label: SECTION_LABEL[s], active: s === section }));
  return { kind: "tabs", text: tabs.map((t) => t.label).join(TAB_GAP), selected: false, tabs };
}

const blank = (): SettingsLine => ({ kind: "blank", text: "", selected: false });
const heading = (text: string): SettingsLine => ({ kind: "heading", text, selected: false });
const radio = (on: boolean) => (on ? "(*)" : "( )");
const cursorMark = (selected: boolean) => (selected ? "›" : " ");
const KEY_LABEL_WIDTH = Math.max(...ACTIONS.map((a) => Bun.stringWidth(a.label)));
const VIEW_LABEL_WIDTH = Math.max(...VIEW_FIELDS.map((f) => VIEW_LABEL[f].length)) + 3;
const NAME_WIDTH = 11;

/** True when the action's keys are not its defaults. */
export function keysChanged(keymap: Keymap, action: ActionDef): boolean {
  return keysOf(keymap, action.scope, action.id).join(" ") !== action.defaults.join(" ");
}

/** The body of a section at full size, and the line range of each row. */
function sectionBody(section: SettingsSection, values: SettingsValues, cursor: number): { lines: SettingsLine[]; spans: [number, number][] } {
  const lines: SettingsLine[] = [];
  const spans: [number, number][] = [];
  const rows = settingsRows(section, values.editor);
  let previous: SettingsRow["kind"] | null = null;
  let previousScope: string | null = null;
  rows.forEach((row, i) => {
    const selected = i === cursor;
    const mark = cursorMark(selected);
    // A heading before each group.
    if (row.kind !== previous || (row.kind === "key" && row.action.scope !== previousScope)) {
      if (lines.length > 0) lines.push(blank());
      lines.push(heading(groupHeading(row)));
    } else if (row.kind === "preset") lines.push(blank());
    previous = row.kind;
    previousScope = row.kind === "key" ? row.action.scope : null;
    const first = lines.length;
    switch (row.kind) {
      case "preset": {
        const name = `${mark} ${getPreset(row.preset).name}${row.preset === values.preset ? " · current" : ""}`;
        lines.push({ kind: "row", text: name, selected });
        for (const text of presetPreview(row.preset)) lines.push({ kind: "preview", text, selected });
        break;
      }
      case "view":
        lines.push({ kind: "row", text: `${mark} ${pad(VIEW_LABEL[row.field], VIEW_LABEL_WIDTH)}${values.view[row.field] ? "on" : "off"}`, selected });
        break;
      case "mode":
        lines.push({ kind: "row", text: `${mark} ${radio(values.editor.mode === row.mode)} ${pad(row.mode, NAME_WIDTH)}${MODE_NOTE[row.mode]}`, selected });
        break;
      case "command": {
        const custom = isCustomCommand(values.editor.command);
        const text =
          row.command === null
            ? `${mark} ${radio(custom)} Custom…${custom ? `${" ".repeat(Math.max(1, NAME_WIDTH - 7))}${values.editor.command}` : ""}`
            : `${mark} ${radio(values.editor.command === row.command)} ${row.command}`;
        lines.push({ kind: "row", text, selected });
        break;
      }
      case "display":
        lines.push({
          kind: "row",
          text: `${mark} ${radio(values.editor.display === row.display)} ${pad(row.display, NAME_WIDTH)}${DISPLAY_NOTE[row.display]}`,
          selected,
        });
        break;
      case "key": {
        const changed = keysChanged(values.keymap, row.action);
        const keys = keysOf(values.keymap, row.action.scope, row.action.id);
        const text = `${mark} ${pad(row.action.label, KEY_LABEL_WIDTH)}  ${changed ? "*" : " "} ${keys.length ? keys.join(" / ") : "—"}`;
        lines.push({ kind: "row", text, selected, changed });
        break;
      }
    }
    spans.push([first, lines.length - 1]);
  });
  return { lines, spans };
}

function groupHeading(row: SettingsRow): string {
  switch (row.kind) {
    case "preset":
      return "Quadrant names";
    case "view":
      return "Panels";
    case "mode":
      return "Mode";
    case "command":
      return "Command";
    case "display":
      return "Display";
    case "key":
      return row.action.scope === "normal" ? "Matrix" : "Triage";
  }
}

/** Lines of a section at full size: the tabs, a blank line, the body. */
export function settingsHeight(section: SettingsSection, values: SettingsValues): number {
  return 2 + sectionBody(section, values, -1).lines.length;
}

/** The widest line of any section at full size, so the box keeps its width across tabs. */
export function settingsWidth(values: SettingsValues): number {
  const widths = SETTINGS_SECTIONS.flatMap((section) => [
    tabsLine(section).text,
    // The cursor and `· current` change no width: measure with the cursor on row 0.
    ...sectionBody(section, values, 0).lines.map((l) => l.text),
  ]);
  return Math.max(...PRESET_IDS.map((id) => Bun.stringWidth(`› ${getPreset(id).name} · current`)), ...widths.map((t) => Bun.stringWidth(t)));
}

/**
 * The lines of `section` for an inner box of `width` × `height`: never
 * wider or taller. The tabs stay on the first line; when the rows run short
 * the body scrolls so the cursor's row (a preset with its preview) stays visible.
 */
export function settingsLines(section: SettingsSection, values: SettingsValues, cursor: number, width: number, height: number): SettingsLine[] {
  if (width <= 0 || height <= 0) return [];
  const clipLine = (l: SettingsLine): SettingsLine => ({ ...l, text: clip(l.text, width) });
  const tabs = tabsLine(section);
  const { lines, spans } = sectionBody(section, values, cursor);
  const span = spans[cursor] ?? [0, 0];
  if (lines.length + 2 <= height) return [tabs, blank(), ...lines].map(clipLine);
  if (height === 1) return [clipLine(lines[span[0]]!)];
  const room = height - 1;
  // Keep the cursor's row in view, its preview too when there is room.
  const target = span[0] + Math.min(span[1] - span[0], Math.floor((room - 1) / 2));
  const start = windowStart(target, lines.length, room);
  return [tabs, ...lines.slice(start, start + room)].map(clipLine);
}

// ── Key edits (S33, S30) ────────────────────────────────────────────────────

export type KeyEdit = { ok: true; keys: readonly string[]; message: string } | { ok: false; message: string };

const KEY_NAMES: Record<string, string> = { return: "Enter", enter: "Enter", backspace: "Backspace", escape: "Esc", esc: "Esc" };

function shown(key: string): string {
  return KEY_NAMES[key.toLowerCase()] ?? key;
}

function labelOf(scope: ActionDef["scope"], id: string): string {
  return ACTIONS.find((a) => a.scope === scope && a.id === id)?.label ?? id;
}

function keysMessage(action: ActionDef, keys: readonly string[], suffix = ""): string {
  return `${action.label}: ${keys.length ? keys.join(" / ") : "no key"}${suffix}`;
}

/**
 * The captured `key` (an `eventKey` string, null when no binding can match
 * it) replaces the action's keys, or is added to them with `add`. Refused:
 * a never-bindable key, one another action of the same scope holds, or (adding)
 * one the action already has.
 */
export function bindKey(keymap: Keymap, action: ActionDef, key: string | null, add: boolean): KeyEdit {
  if (key === null) return { ok: false, message: "That key can't be bound" };
  const check = checkKey(key);
  if (!check.ok) return { ok: false, message: `\`${shown(key)}\` ${check.reason}` };
  const owner = conflictFor(keymap, action.scope, check.key, action.id);
  if (owner !== null) return { ok: false, message: `\`${check.key}\` is already ${labelOf(action.scope, owner)}` };
  const current = keysOf(keymap, action.scope, action.id);
  if (add && current.includes(check.key)) return { ok: false, message: `${action.label} already has \`${check.key}\`` };
  const keys = add ? [...current, check.key] : [check.key];
  return { ok: true, keys, message: keysMessage(action, keys) };
}

/** Backspace: drops the action's last key; a guarded action keeps its last one (S30). */
export function removeLastKey(keymap: Keymap, action: ActionDef): KeyEdit {
  const current = keysOf(keymap, action.scope, action.id);
  if (current.length === 0) return { ok: false, message: `${action.label} has no key` };
  if (current.length === 1 && action.scope === "normal" && GUARDED_ACTIONS.has(action.id))
    return { ok: false, message: `${action.label} needs at least one key` };
  const keys = current.slice(0, -1);
  return { ok: true, keys, message: keysMessage(action, keys) };
}

/** `r`: back to the action's defaults, unless another action now holds one of them. */
export function resetKey(keymap: Keymap, action: ActionDef): KeyEdit {
  for (const key of action.defaults) {
    const owner = conflictFor(keymap, action.scope, key, action.id);
    if (owner !== null) return { ok: false, message: `\`${key}\` is already ${labelOf(action.scope, owner)}` };
  }
  return { ok: true, keys: action.defaults, message: keysMessage(action, action.defaults, " (default)") };
}

/** The `keys` patch for an action's new keys: `null` (no override) when they are its defaults. */
export function keysPatch(action: ActionDef, keys: readonly string[]): Record<string, string[] | null> {
  const same = keys.join(" ") === action.defaults.join(" ");
  return { [action.name]: same ? null : [...keys] };
}

/** `R`: every action's override removed. */
export function resetAllPatch(): Record<string, null> {
  return Object.fromEntries(ACTIONS.map((a) => [a.name, null]));
}
