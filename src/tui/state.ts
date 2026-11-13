// Pure view state of the matrix TUI: key → action mapping and the reducer for
// view-only changes. No @opentui and no bun:sqlite here; the controller in
// app.ts runs the repository effects and reloads the panes.
import type { Quadrant } from "../domain/task.ts";

export type Mode = "normal" | "add" | "confirmDelete" | "help";

export interface Key {
  name: string;
  sequence: string;
  shift: boolean;
  ctrl: boolean;
  meta?: boolean;
}

export interface ViewState {
  focus: Quadrant;
  /** Selected row per pane. */
  selected: Record<Quadrant, number>;
  mode: Mode;
  showDone: boolean;
  /** Text typed in the add input. */
  input: string;
  /** One-off message for the status line, cleared by the next key. */
  status: string | null;
  quit: boolean;
}

/** What the panes show, in display order; only the ids matter here. */
export type PaneItems = Record<Quadrant, readonly { id: number }[]>;

export type Direction = "left" | "right" | "up" | "down";

export type Action =
  | { type: "navigate"; dir: Direction }
  | { type: "moveTo"; quadrant: Quadrant }
  | { type: "startAdd" }
  | { type: "inputChar"; text: string }
  | { type: "inputBackspace" }
  | { type: "submitAdd" }
  | { type: "toggleDone" }
  | { type: "requestDelete" }
  | { type: "confirmDelete" }
  | { type: "reorder"; dir: -1 | 1 }
  | { type: "toggleShowDone" }
  | { type: "help" }
  | { type: "cancel" }
  | { type: "quit" }
  // Hooks for later tasks: T7 (editor), T8 (triage), T11 (search).
  | { type: "edit" }
  | { type: "triage" }
  | { type: "search" }
  | { type: "noop" };

export function initialState(): ViewState {
  return {
    focus: 1,
    selected: { 1: 0, 2: 0, 3: 0, 4: 0 },
    mode: "normal",
    showDone: false,
    input: "",
    status: null,
    quit: false,
  };
}

const NOOP: Action = { type: "noop" };

const ARROWS: Record<string, Direction> = {
  h: "left",
  l: "right",
  j: "down",
  k: "up",
  left: "left",
  right: "right",
  down: "down",
  up: "up",
};

function isCtrlC(key: Key): boolean {
  return key.ctrl && key.name === "c";
}

function isShifted(key: Key, letter: string): boolean {
  return key.sequence === letter.toUpperCase() || (key.name === letter && key.shift);
}

/** A key that types text: one printable character (or a printable sequence). */
function printable(key: Key): string | null {
  if (key.ctrl || key.meta) return null;
  if (key.sequence.length === 0 || /[\u0000-\u001f\u007f]/.test(key.sequence)) return null;
  return key.sequence;
}

export function keyToAction(state: ViewState, key: Key): Action {
  if (isCtrlC(key)) return { type: "quit" };
  switch (state.mode) {
    case "add":
      return addKey(key);
    case "confirmDelete":
      if (key.name === "y" && !key.shift) return { type: "confirmDelete" };
      if ((key.name === "n" && !key.shift) || key.name === "escape") return { type: "cancel" };
      return NOOP;
    case "help":
      if (key.name === "escape" || key.name === "?" || (key.name === "q" && !key.shift)) return { type: "cancel" };
      return NOOP;
    case "normal":
      return normalKey(key);
  }
}

function addKey(key: Key): Action {
  if (key.name === "escape") return { type: "cancel" };
  if (key.name === "return" || key.name === "enter") return { type: "submitAdd" };
  if (key.name === "backspace") return { type: "inputBackspace" };
  const text = printable(key);
  return text === null ? NOOP : { type: "inputChar", text };
}

function normalKey(key: Key): Action {
  if (key.ctrl || key.meta) return NOOP;
  if (isShifted(key, "j")) return { type: "reorder", dir: 1 };
  if (isShifted(key, "k")) return { type: "reorder", dir: -1 };
  if (key.name === "escape") return { type: "cancel" };
  // Symbols arrive with name = the character.
  switch (key.name) {
    case "?":
      return { type: "help" };
    case ".":
      return { type: "toggleShowDone" };
    case "/":
      return { type: "search" };
    case "1":
    case "2":
    case "3":
    case "4":
      return { type: "moveTo", quadrant: Number(key.name) as Quadrant };
  }
  if (key.shift) return NOOP;
  const dir = ARROWS[key.name];
  if (dir) return { type: "navigate", dir };
  switch (key.name) {
    case "a":
      return { type: "startAdd" };
    case "x":
      return { type: "toggleDone" };
    case "d":
      return { type: "requestDelete" };
    case "e":
      return { type: "edit" };
    case "i":
      return { type: "triage" };
    case "q":
      return { type: "quit" };
  }
  return NOOP;
}

const COMING_SOON: Record<"edit" | "triage" | "search", string> = {
  edit: "Edit in $EDITOR: coming soon",
  triage: "Triage: coming soon",
  search: "Search: coming soon",
};

/** View-only transitions. Repository effects are the controller's job. */
export function reduce(state: ViewState, action: Action, panes: PaneItems): ViewState {
  const s: ViewState = { ...state, selected: { ...state.selected }, status: null };
  switch (action.type) {
    case "navigate":
      return navigate(s, action.dir, panes);
    case "startAdd":
      return { ...s, mode: "add", input: "" };
    case "inputChar":
      return { ...s, input: s.input + action.text };
    case "inputBackspace":
      return { ...s, input: Array.from(s.input).slice(0, -1).join("") };
    case "submitAdd":
      return { ...s, mode: "normal", input: "" };
    case "requestDelete":
      if (selectedId(s, panes) === null) return { ...s, status: "Nothing selected" };
      return { ...s, mode: "confirmDelete" };
    case "confirmDelete":
    case "cancel":
      return { ...s, mode: "normal", input: "" };
    case "toggleShowDone":
      return clamp({ ...s, showDone: !s.showDone }, panes);
    case "help":
      return { ...s, mode: "help" };
    case "quit":
      return { ...s, quit: true };
    case "edit":
    case "triage":
    case "search":
      return { ...s, status: COMING_SOON[action.type] };
    case "noop":
      return { ...s, status: state.status };
    case "moveTo":
    case "toggleDone":
    case "reorder":
      return s;
  }
}

const RIGHT_OF: Partial<Record<Quadrant, Quadrant>> = { 1: 2, 3: 4 };
const LEFT_OF: Partial<Record<Quadrant, Quadrant>> = { 2: 1, 4: 3 };
const BELOW: Partial<Record<Quadrant, Quadrant>> = { 1: 3, 2: 4 };
const ABOVE: Partial<Record<Quadrant, Quadrant>> = { 3: 1, 4: 2 };

function navigate(s: ViewState, dir: Direction, panes: PaneItems): ViewState {
  const count = panes[s.focus].length;
  const index = s.selected[s.focus];
  switch (dir) {
    case "left":
    case "right": {
      const target = (dir === "left" ? LEFT_OF : RIGHT_OF)[s.focus];
      return target ? clamp({ ...s, focus: target }, panes) : s;
    }
    case "down": {
      if (index < count - 1) return { ...s, selected: { ...s.selected, [s.focus]: index + 1 } };
      const target = BELOW[s.focus];
      return target ? { ...s, focus: target, selected: { ...s.selected, [target]: 0 } } : s;
    }
    case "up": {
      if (index > 0 && count > 0) return { ...s, selected: { ...s.selected, [s.focus]: index - 1 } };
      const target = ABOVE[s.focus];
      if (!target) return s;
      return { ...s, focus: target, selected: { ...s.selected, [target]: Math.max(0, panes[target].length - 1) } };
    }
  }
}

/** Keeps every pane's selection inside its list (after moves, deletes, filters). */
export function clamp(state: ViewState, panes: PaneItems): ViewState {
  const selected = { ...state.selected };
  for (const q of [1, 2, 3, 4] as const) {
    selected[q] = Math.max(0, Math.min(selected[q], panes[q].length - 1));
  }
  return { ...state, selected };
}

/** Selects task `id` in the focused pane if it is there, otherwise clamps. */
export function follow(state: ViewState, panes: PaneItems, id: number): ViewState {
  const index = panes[state.focus].findIndex((item) => item.id === id);
  const next = index < 0 ? state : { ...state, selected: { ...state.selected, [state.focus]: index } };
  return clamp(next, panes);
}

export function selectedId(state: ViewState, panes: PaneItems): number | null {
  return panes[state.focus][state.selected[state.focus]]?.id ?? null;
}
