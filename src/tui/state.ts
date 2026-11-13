// Pure view state of the matrix TUI: key → action mapping and the reducer for
// view-only changes. No @opentui and no bun:sqlite here; the controller in
// app.ts runs the repository effects and reloads the panes.
import { DEFAULT_PRESET, PRESET_IDS, type PresetId } from "../domain/presets.ts";
import type { Quadrant } from "../domain/task.ts";
import { DEFAULT_KEYMAP, actionFor, keysOf, type Keymap } from "./keymap.ts";

export type Mode = "normal" | "add" | "confirmDelete" | "help" | "triage" | "search" | "settings";

/**
 * A pane: a quadrant, the Inbox strip always shown under the grid (S24), or
 * the done panel in the sidebar (S27).
 */
export type Focus = Quadrant | "inbox" | "done";

/** The view toggles kept in the state (S27, S28); persisted by the controller (S29). */
export interface ViewToggles {
  /** The completed-tasks panel in the sidebar (S27). */
  donePanel: boolean;
  /** `•` at the start of open rows (S28). */
  bullets: boolean;
}

/** S29 defaults: done panel off, bullets on. */
export const DEFAULT_TOGGLES: Readonly<ViewToggles> = { donePanel: false, bullets: true };

export const DONE_ORDER_MESSAGE = "Done tasks are ordered by completion";

/**
 * A triage session (S12): the Inbox ids taken when it started, in order, and
 * where it is. Each task is visited at most once; tasks that reach the Inbox
 * later wait for the next session.
 */
export interface TriageSession {
  queue: readonly number[];
  index: number;
  sorted: number;
  skipped: number;
  deleted: number;
}

export interface Key {
  name: string;
  sequence: string;
  shift: boolean;
  ctrl: boolean;
  meta?: boolean;
}

export interface ViewState {
  focus: Focus;
  /** Selected row per pane; `inbox` is the Inbox strip's (S24), `done` the done panel's (S27). */
  selected: Record<Quadrant, number> & { inbox?: number; done?: number };
  /**
   * The bottom pane the Inbox strip was entered from with `j`: `k` at the
   * strip's top goes back there (S24). Q3 until the strip is entered from Q4.
   */
  aboveStrip: 3 | 4;
  /**
   * The pane the done panel was entered from with `l`: `h` goes back there,
   * and so does the focus when the panel goes away (S27). Q2 until entered from Q4.
   */
  besideDone: 2 | 4;
  mode: Mode;
  /** The done panel is on (S27); it shows only while the sidebar fits (S26). */
  donePanel: boolean;
  /** Bullets in the rows' mark column (S28). */
  bullets: boolean;
  /** Text typed in the add input. */
  input: string;
  /** One-off message for the status line, cleared by the next key. */
  status: string | null;
  quit: boolean;
  /** Set while triaging; `confirmDelete` and `help` return to it. */
  triage: TriageSession | null;
  /**
   * The search query (S19), edited live in `search` mode and kept after
   * Enter; "" means no filter.
   */
  query: string;
  /** The quadrant labels in use (S20). */
  preset: PresetId;
  /** The preset under the cursor in the settings screen (S21), an index in PRESET_IDS. */
  settingsCursor: number;
}

/**
 * What the panes show, in display order; only the ids matter here. The app
 * always passes `inbox`, the Inbox strip's list (S24); without it the strip
 * cannot be entered and its focus falls back to Q1. `done` is the done
 * panel's list, given only while the panel is on screen (S27); without it the
 * panel cannot be entered and its focus goes back to `besideDone`.
 */
export type PaneItems = Record<Quadrant, readonly { id: number }[]> & {
  inbox?: readonly { id: number }[];
  done?: readonly { id: number }[];
};

export type Direction = "left" | "right" | "up" | "down";

export type Action =
  | { type: "navigate"; dir: Direction }
  | { type: "moveTo"; quadrant: Quadrant }
  /** `a`: a new task in the floating editor (S22); the controller runs it. */
  | { type: "newTask" }
  /** `A`: the inline quick-add in the status line. */
  | { type: "startAdd" }
  | { type: "inputChar"; text: string }
  | { type: "inputBackspace" }
  | { type: "submitAdd" }
  | { type: "toggleDone" }
  | { type: "requestDelete" }
  | { type: "confirmDelete" }
  | { type: "reorder"; dir: -1 | 1 }
  /** `.`: the done panel on/off (S27); the controller saves it. */
  | { type: "toggleDonePanel" }
  /** Bullets on/off (S28, no default key); the controller saves it. */
  | { type: "toggleBullets" }
  | { type: "help" }
  | { type: "cancel" }
  | { type: "quit" }
  /** Opens the selected task in $EDITOR (S11); the controller runs it. */
  | { type: "edit" }
  /** Starts triaging the Inbox (S12). */
  | { type: "triage" }
  | { type: "skip" }
  | { type: "exitTriage" }
  /** Opens the search input, prefilled with the current query (S19). */
  | { type: "search" }
  | { type: "searchInput"; text: string }
  | { type: "searchBackspace" }
  /** Enter: keep the filter, back to normal navigation. */
  | { type: "submitSearch" }
  /** Esc: drop the filter and restore the full view. */
  | { type: "clearSearch" }
  /** `,` opens the settings (S21); j/k move its cursor; Enter applies (the controller saves). */
  | { type: "openSettings" }
  | { type: "settingsMove"; dir: -1 | 1 }
  | { type: "saveSettings" }
  | { type: "noop" };

export function initialState(preset: PresetId = DEFAULT_PRESET, toggles: Partial<ViewToggles> = {}): ViewState {
  return {
    focus: 1,
    selected: { 1: 0, 2: 0, 3: 0, 4: 0 },
    aboveStrip: 3,
    besideDone: 2,
    mode: "normal",
    donePanel: toggles.donePanel ?? DEFAULT_TOGGLES.donePanel,
    bullets: toggles.bullets ?? DEFAULT_TOGGLES.bullets,
    input: "",
    status: null,
    quit: false,
    triage: null,
    query: "",
    preset,
    settingsCursor: 0,
  };
}

/** True while the search input is open or a non-blank query filters the panes. */
export function searchActive(state: ViewState): boolean {
  return state.mode === "search" || state.query.trim() !== "";
}

const NOOP: Action = { type: "noop" };

/**
 * What each keymap action does in the matrix (S30). Actions whose feature
 * comes later (preview, `:`) are bound but do nothing yet.
 */
const NORMAL_ACTIONS: Readonly<Record<string, Action>> = {
  move_left: { type: "navigate", dir: "left" },
  move_down: { type: "navigate", dir: "down" },
  move_up: { type: "navigate", dir: "up" },
  move_right: { type: "navigate", dir: "right" },
  send_q1: { type: "moveTo", quadrant: 1 },
  send_q2: { type: "moveTo", quadrant: 2 },
  send_q3: { type: "moveTo", quadrant: 3 },
  send_q4: { type: "moveTo", quadrant: 4 },
  new_task: { type: "newTask" },
  quick_add: { type: "startAdd" },
  edit: { type: "edit" },
  toggle_done: { type: "toggleDone" },
  delete: { type: "requestDelete" },
  order_down: { type: "reorder", dir: 1 },
  order_up: { type: "reorder", dir: -1 },
  search: { type: "search" },
  triage: { type: "triage" },
  toggle_done_panel: { type: "toggleDonePanel" },
  toggle_preview: NOOP,
  toggle_bullets: { type: "toggleBullets" },
  preview_down: NOOP,
  preview_up: NOOP,
  command_line: NOOP,
  settings: { type: "openSettings" },
  help: { type: "help" },
  quit: { type: "quit" },
};

/** What each keymap action does on the triage card (S12). */
const TRIAGE_ACTIONS: Readonly<Record<string, Action>> = {
  send_q1: { type: "moveTo", quadrant: 1 },
  send_q2: { type: "moveTo", quadrant: 2 },
  send_q3: { type: "moveTo", quadrant: 3 },
  send_q4: { type: "moveTo", quadrant: 4 },
  skip: { type: "skip" },
  edit: { type: "edit" },
  delete: { type: "requestDelete" },
  help: { type: "help" },
  exit_triage: { type: "exitTriage" },
};

function mapped(table: Readonly<Record<string, Action>>, id: string | null): Action {
  return id !== null && Object.hasOwn(table, id) ? table[id]! : NOOP;
}

function isCtrlC(key: Key): boolean {
  return key.ctrl && key.name === "c";
}

/** Esc without ctrl/alt (those were never bound and stay inert). */
function isBareEscape(key: Key): boolean {
  return key.name === "escape" && !key.ctrl && !key.meta;
}

/** A key that types text: one printable character (or a printable sequence). */
function printable(key: Key): string | null {
  if (key.ctrl || key.meta) return null;
  if (key.sequence.length === 0 || /[\u0000-\u001f\u007f]/.test(key.sequence)) return null;
  return key.sequence;
}

/**
 * The action for `key` in the current mode. Normal and triage keys come from
 * `keymap` (S30); Esc, Enter, Backspace and Ctrl+C are fixed, and the
 * text-input modes keep their own keys.
 */
export function keyToAction(state: ViewState, key: Key, keymap: Keymap = DEFAULT_KEYMAP): Action {
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
    case "triage":
      return triageKey(key, keymap);
    case "search":
      return searchKey(key);
    case "settings":
      return settingsKey(key);
    case "normal":
      return normalKey(key, searchActive(state), keymap);
  }
}

/** Every printable key types into the query: no global key fires (S19). */
function searchKey(key: Key): Action {
  if (key.name === "escape") return { type: "clearSearch" };
  if (key.name === "return" || key.name === "enter") return { type: "submitSearch" };
  if (key.name === "backspace") return { type: "searchBackspace" };
  const text = printable(key);
  return text === null ? NOOP : { type: "searchInput", text };
}

/** Only the settings' own keys: nothing reaches the matrix (S21). */
function settingsKey(key: Key): Action {
  if (key.ctrl || key.meta) return NOOP;
  if (key.name === "escape") return { type: "cancel" };
  if (key.name === "return" || key.name === "enter") return { type: "saveSettings" };
  if (key.shift) return NOOP;
  if (key.name === "j" || key.name === "down") return { type: "settingsMove", dir: 1 };
  if (key.name === "k" || key.name === "up") return { type: "settingsMove", dir: -1 };
  return NOOP;
}

function triageKey(key: Key, keymap: Keymap): Action {
  if (isBareEscape(key)) return { type: "exitTriage" };
  return mapped(TRIAGE_ACTIONS, actionFor(keymap, "triage", key));
}

function addKey(key: Key): Action {
  if (key.name === "escape") return { type: "cancel" };
  if (key.name === "return" || key.name === "enter") return { type: "submitAdd" };
  if (key.name === "backspace") return { type: "inputBackspace" };
  const text = printable(key);
  return text === null ? NOOP : { type: "inputChar", text };
}

function normalKey(key: Key, searching: boolean, keymap: Keymap): Action {
  if (isBareEscape(key)) return searching ? { type: "clearSearch" } : { type: "cancel" };
  return mapped(NORMAL_ACTIONS, actionFor(keymap, "normal", key));
}

/**
 * View-only transitions. Repository effects are the controller's job.
 * `inbox` is the open Inbox in display order; only `triage` reads it.
 */
export function reduce(
  state: ViewState,
  action: Action,
  panes: PaneItems,
  inbox: readonly { id: number }[] = [],
): ViewState {
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
      if (currentId(s, panes) === null) return { ...s, status: "Nothing selected" };
      return { ...s, mode: "confirmDelete" };
    case "confirmDelete":
      return s.triage ? advance({ ...s, mode: "triage" }, "deleted") : { ...s, mode: "normal" };
    case "cancel":
      return { ...s, mode: s.triage ? "triage" : "normal", input: "" };
    case "toggleDonePanel":
      return { ...s, donePanel: !s.donePanel };
    case "toggleBullets":
      return { ...s, bullets: !s.bullets };
    case "help":
      return { ...s, mode: "help" };
    case "quit":
      return { ...s, quit: true };
    case "triage": {
      if (inbox.length === 0) return { ...s, status: "Inbox is empty: nothing to triage" };
      const queue = inbox.map((item) => item.id);
      return { ...s, mode: "triage", triage: { queue, index: 0, sorted: 0, skipped: 0, deleted: 0 } };
    }
    case "skip":
      return s.triage ? advance(s, "skipped") : s;
    case "exitTriage":
      return s.triage ? endTriage(s, s.triage) : s;
    case "search":
      return { ...s, mode: "search" };
    case "searchInput":
      return { ...s, query: s.query + action.text, selected: { 1: 0, 2: 0, 3: 0, 4: 0, inbox: 0 } };
    case "searchBackspace":
      return {
        ...s,
        query: Array.from(s.query).slice(0, -1).join(""),
        selected: { 1: 0, 2: 0, 3: 0, 4: 0, inbox: 0 },
      };
    case "submitSearch":
      return s.query.trim() === "" ? endSearch(s) : { ...s, mode: "normal" };
    case "clearSearch":
      return endSearch(s);
    case "openSettings":
      return { ...s, mode: "settings", settingsCursor: Math.max(0, PRESET_IDS.indexOf(s.preset)) };
    case "settingsMove": {
      const cursor = Math.max(0, Math.min(PRESET_IDS.length - 1, s.settingsCursor + action.dir));
      return { ...s, settingsCursor: cursor };
    }
    case "saveSettings":
      return { ...s, mode: "normal", preset: PRESET_IDS[s.settingsCursor] ?? s.preset };
    case "noop":
      return { ...s, status: state.status };
    case "moveTo":
      return s.triage ? advance(s, "sorted") : s;
    case "reorder":
      // S27: the panel's order is the completion order; the controller does not reorder there.
      return s.focus === "done" ? { ...s, status: DONE_ORDER_MESSAGE } : s;
    case "toggleDone":
    case "edit":
    case "newTask":
      return s;
  }
}

/** Back to the unfiltered matrix; the Inbox strip stays (S24), and so does its focus. */
function endSearch(s: ViewState): ViewState {
  return { ...s, mode: "normal", query: "" };
}

const RIGHT_OF: Partial<Record<Focus, Quadrant>> = { 1: 2, 3: 4 };
const LEFT_OF: Partial<Record<Focus, Quadrant>> = { 2: 1, 4: 3 };

/** The pane right of `focus`: Q2 and Q4 lead into the done panel while it is shown (S27). */
function rightOf(s: ViewState, panes: PaneItems): Focus | undefined {
  if ((s.focus === 2 || s.focus === 4) && panes.done) return "done";
  return RIGHT_OF[s.focus];
}

/** The pane left of `focus`: the done panel goes back to the pane it was entered from. */
function leftOf(s: ViewState): Focus | undefined {
  return s.focus === "done" ? s.besideDone : LEFT_OF[s.focus];
}

/** The pane above `focus`: the strip goes back to the pane it was entered from (S24). */
function above(s: ViewState): Quadrant | undefined {
  if (s.focus === 3) return 1;
  if (s.focus === 4) return 2;
  if (s.focus === "inbox") return s.aboveStrip;
  return undefined;
}

/** The pane below `focus`: the Inbox strip sits under Q3 and Q4 (S24). */
function below(focus: Focus, panes: PaneItems): Focus | undefined {
  if (focus === 1) return 3;
  if (focus === 2) return 4;
  if ((focus === 3 || focus === 4) && panes.inbox) return "inbox";
  return undefined;
}

function paneList(panes: PaneItems, focus: Focus): readonly { id: number }[] {
  return panes[focus] ?? [];
}

function selectedIn(state: ViewState, focus: Focus): number {
  return state.selected[focus] ?? 0;
}

function navigate(s: ViewState, dir: Direction, panes: PaneItems): ViewState {
  const count = paneList(panes, s.focus).length;
  const index = selectedIn(s, s.focus);
  switch (dir) {
    case "left":
    case "right": {
      const target = dir === "left" ? leftOf(s) : rightOf(s, panes);
      if (!target) return s;
      const next = { ...s, focus: target };
      return clamp(target === "done" && (s.focus === 2 || s.focus === 4) ? { ...next, besideDone: s.focus } : next, panes);
    }
    case "down": {
      if (index < count - 1) return { ...s, selected: { ...s.selected, [s.focus]: index + 1 } };
      if (s.focus === "done") return s;
      const target = below(s.focus, panes);
      if (!target) return s;
      const next = { ...s, focus: target, selected: { ...s.selected, [target]: 0 } };
      return target === "inbox" && (s.focus === 3 || s.focus === 4) ? { ...next, aboveStrip: s.focus } : next;
    }
    case "up": {
      if (index > 0 && count > 0) return { ...s, selected: { ...s.selected, [s.focus]: index - 1 } };
      if (s.focus === "done") return s;
      const target = above(s);
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
  if (panes.inbox) selected.inbox = Math.max(0, Math.min(selected.inbox ?? 0, panes.inbox.length - 1));
  if (panes.done) selected.done = Math.max(0, Math.min(selected.done ?? 0, panes.done.length - 1));
  // No strip list was given: its focus moves back to the grid. No done panel
  // on screen (toggled off, or the sidebar hidden): back to where it was entered from.
  let focus = state.focus;
  if (focus === "inbox" && !panes.inbox) focus = 1;
  if (focus === "done" && !panes.done) focus = state.besideDone;
  return { ...state, focus, selected };
}

/** Selects task `id` in the focused pane if it is there, otherwise clamps. */
export function follow(state: ViewState, panes: PaneItems, id: number): ViewState {
  const index = paneList(panes, state.focus).findIndex((item) => item.id === id);
  const next = index < 0 ? state : { ...state, selected: { ...state.selected, [state.focus]: index } };
  return clamp(next, panes);
}

export function selectedId(state: ViewState, panes: PaneItems): number | null {
  return paneList(panes, state.focus)[selectedIn(state, state.focus)]?.id ?? null;
}

const SEARCH_ORDER: readonly Focus[] = [1, 2, 3, 4, "inbox", "done"];

/**
 * While searching, an empty focused pane hands the focus to the first pane
 * with matches (Q1..Q4, the Inbox strip, then the done panel), so the keys act on a match.
 */
export function focusMatches(state: ViewState, panes: PaneItems): ViewState {
  if (paneList(panes, state.focus).length > 0) return state;
  const target = SEARCH_ORDER.find((f) => paneList(panes, f).length > 0);
  return target === undefined ? state : clamp({ ...state, focus: target }, panes);
}

/** The task the next action applies to: the triage card's, else the selected one. */
export function currentId(state: ViewState, panes: PaneItems): number | null {
  if (state.triage) return state.triage.queue[state.triage.index] ?? null;
  return selectedId(state, panes);
}

/** Counts the current card as `outcome` and shows the next, or ends the session. */
function advance(s: ViewState, outcome: "sorted" | "skipped" | "deleted"): ViewState {
  const t = s.triage!;
  const triage = { ...t, index: t.index + 1, [outcome]: t[outcome] + 1 };
  return triage.index >= triage.queue.length ? endTriage(s, triage) : { ...s, triage };
}

/** Back to the matrix with a summary of the session. */
function endTriage(s: ViewState, t: TriageSession): ViewState {
  const counts = `${t.sorted} sorted, ${t.skipped} skipped`;
  const left = t.queue.length - t.index;
  const status =
    left > 0
      ? `Triage stopped: ${counts}${t.deleted ? `, ${t.deleted} deleted` : ""}, ${left} left in the Inbox`
      : `Inbox triaged: ${counts}${t.deleted ? `, ${t.deleted} deleted` : ""}`;
  return { ...s, mode: "normal", triage: null, status };
}

/**
 * After a reload: skips queued tasks that are no longer in the Inbox (moved or
 * deleted elsewhere) and ends the session when none are left.
 */
export function syncTriage(state: ViewState, inbox: readonly { id: number }[]): ViewState {
  const t = state.triage;
  if (!t) return state;
  const present = new Set(inbox.map((item) => item.id));
  let index = t.index;
  while (index < t.queue.length && !present.has(t.queue[index]!)) index++;
  if (index === t.index) return state;
  const triage = { ...t, index };
  return index >= t.queue.length ? endTriage(state, triage) : { ...state, triage };
}

/** S12: on start, a non-empty Inbox is offered in the status line, not forced. */
export function offerTriage(state: ViewState, inboxCount: number, keymap: Keymap = DEFAULT_KEYMAP): ViewState {
  const key = keysOf(keymap, "normal", "triage")[0];
  return inboxCount > 0 && key !== undefined ? { ...state, status: `press ${key} to triage` } : state;
}
