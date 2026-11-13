// Pure view state of the matrix TUI: key → action mapping and the reducer for
// view-only changes. No @opentui and no bun:sqlite here; the controller in
// app.ts runs the repository effects and reloads the panes.
import type { Quadrant } from "../domain/task.ts";

export type Mode = "normal" | "add" | "confirmDelete" | "help" | "triage" | "search";

/** A pane: a quadrant, or the Inbox strip shown while a search is active (S19). */
export type Focus = Quadrant | "inbox";

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
  /** Selected row per pane; `inbox` only matters while the strip is shown. */
  selected: Record<Quadrant, number> & { inbox?: number };
  mode: Mode;
  showDone: boolean;
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
}

/**
 * What the panes show, in display order; only the ids matter here. `inbox`
 * is present only while the Inbox strip is shown (an active search).
 */
export type PaneItems = Record<Quadrant, readonly { id: number }[]> & { inbox?: readonly { id: number }[] };

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
    triage: null,
    query: "",
  };
}

/** True while the search input is open or a non-blank query filters the panes. */
export function searchActive(state: ViewState): boolean {
  return state.mode === "search" || state.query.trim() !== "";
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
    case "triage":
      return triageKey(key);
    case "search":
      return searchKey(key);
    case "normal":
      return normalKey(key, searchActive(state));
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

function triageKey(key: Key): Action {
  if (key.ctrl || key.meta) return NOOP;
  switch (key.name) {
    case "1":
    case "2":
    case "3":
    case "4":
      return { type: "moveTo", quadrant: Number(key.name) as Quadrant };
    case "?":
      return { type: "help" };
    case "escape":
      return { type: "exitTriage" };
  }
  if (key.shift) return NOOP;
  switch (key.name) {
    case "s":
      return { type: "skip" };
    case "e":
      return { type: "edit" };
    case "d":
      return { type: "requestDelete" };
    case "q":
      return { type: "exitTriage" };
  }
  return NOOP;
}

function addKey(key: Key): Action {
  if (key.name === "escape") return { type: "cancel" };
  if (key.name === "return" || key.name === "enter") return { type: "submitAdd" };
  if (key.name === "backspace") return { type: "inputBackspace" };
  const text = printable(key);
  return text === null ? NOOP : { type: "inputChar", text };
}

function normalKey(key: Key, searching: boolean): Action {
  if (key.ctrl || key.meta) return NOOP;
  if (isShifted(key, "j")) return { type: "reorder", dir: 1 };
  if (isShifted(key, "k")) return { type: "reorder", dir: -1 };
  if (key.name === "escape") return searching ? { type: "clearSearch" } : { type: "cancel" };
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
    case "toggleShowDone":
      return clamp({ ...s, showDone: !s.showDone }, panes);
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
    case "noop":
      return { ...s, status: state.status };
    case "moveTo":
      return s.triage ? advance(s, "sorted") : s;
    case "toggleDone":
    case "reorder":
    case "edit":
      return s;
  }
}

/** Back to the unfiltered matrix; the Inbox strip goes away, so does its focus. */
function endSearch(s: ViewState): ViewState {
  return { ...s, mode: "normal", query: "", focus: s.focus === "inbox" ? 1 : s.focus };
}

const RIGHT_OF: Partial<Record<Focus, Quadrant>> = { 1: 2, 3: 4 };
const LEFT_OF: Partial<Record<Focus, Quadrant>> = { 2: 1, 4: 3 };
const ABOVE: Partial<Record<Focus, Quadrant>> = { 3: 1, 4: 2, inbox: 3 };

/** The pane below `focus`: the Inbox strip sits under Q3 and Q4 while it is shown. */
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
      const target = (dir === "left" ? LEFT_OF : RIGHT_OF)[s.focus];
      return target ? clamp({ ...s, focus: target }, panes) : s;
    }
    case "down": {
      if (index < count - 1) return { ...s, selected: { ...s.selected, [s.focus]: index + 1 } };
      const target = below(s.focus, panes);
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
  if (panes.inbox) selected.inbox = Math.max(0, Math.min(selected.inbox ?? 0, panes.inbox.length - 1));
  // The strip is gone (no search): its focus moves back to the grid.
  const focus = state.focus === "inbox" && !panes.inbox ? 1 : state.focus;
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

const SEARCH_ORDER: readonly Focus[] = [1, 2, 3, 4, "inbox"];

/**
 * While searching, an empty focused pane hands the focus to the first pane
 * with matches (Q1..Q4, then the Inbox strip), so the keys act on a match.
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
export function offerTriage(state: ViewState, inboxCount: number): ViewState {
  return inboxCount > 0 ? { ...state, status: "press i to triage" } : state;
}
