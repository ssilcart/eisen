// The matrix TUI (S9, S10): OpenTUI view + controller. View state and key
// mapping live in state.ts; every change to tasks goes through TaskRepository,
// and the panes are reloaded from it after each effect. `a` (new task) and
// `e` (edit) run $EDITOR in a floating box over the matrix, on a PTY (S22,
// editor-pty.ts); when that cannot start, the screen is too small or
// EISEN_EDITOR_MODE=fullscreen, the editor takes the whole terminal (S11).
// The edit file format lives in edit-file.ts; `A` is the inline quick-add. `i` triages
// the Inbox one card at a time (S12); the card's layout is in triage-card.ts.
// `/` filters every pane live with the domain's search (S19), the Inbox
// strip included. The strip is always under the grid (S24): a fifth pane,
// entered with `j` from Q3/Q4, where every matrix action works on its
// selected task. Pane titles and messages use the active quadrant preset
// (S20), which `,` changes and saves (S21); each pane has its colour (S23,
// theme.ts). A right sidebar (S26, layout.ts) holds the done panel (S27): a
// sixth pane entered with `l` from Q2/Q4, toggled with `.`; done tasks never
// show in the quadrants or the strip, except in a search while the panel is
// off screen (S19). Above it the preview panel (S25, preview.ts) shows the
// selected task, toggled with `p` and scrolled with ctrl+d / ctrl+u; it is
// never focused. Rows start with a bullet in the pane's colour (S28).
// The view toggles are saved through `saveView` (S29).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoxRenderable,
  EmbeddedTerminalRenderable,
  RGBA,
  StyledText,
  TextAttributes,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  dim,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import { displayBucket, isEscalated, localToday, DEFAULT_URGENT_WITHIN_DAYS } from "../domain/escalation.ts";
import { prepareSearch, search, type SearchIndex } from "../domain/search.ts";
import { parseTags } from "../domain/tags.ts";
import { loadConfig, loadSettings, saveConfig, saveSettings, type ViewSettings } from "../config.ts";
import { getPreset, headingFor, labelFor, type PresetId } from "../domain/presets.ts";
import { QUADRANTS, bucketOf, type Bucket, type Quadrant, type Task } from "../domain/task.ts";
import type { TaskRepository } from "../store/repository.ts";
import { NEW_TASK_FILE, editChanges, editorCommand, parseNewTask, parseTaskFile, serializeTask } from "./edit-file.ts";
import { spawnEditorPty, type EditorPty, type LaunchEditorPty } from "./editor-pty.ts";
import {
  SIDEBAR_MIN_COLUMNS,
  editorBox,
  editorFits,
  fit,
  gridSizes,
  sidebarLayout,
  stripHeight,
  windowStart,
  type Sidebar,
} from "./layout.ts";
import {
  clamp,
  currentId,
  focusMatches,
  follow,
  initialState,
  keyToAction,
  offerTriage,
  reduce,
  syncTriage,
  type Action,
  type Focus,
  type PaneItems,
  type ViewState,
} from "./state.ts";
import { parseCommand, type ViewToggle } from "./commands.ts";
import { buildKeymap, keysOf, type Keymap } from "./keymap.ts";
import { previewInfo, previewLines, type PreviewInfo, type PreviewLineKind } from "./preview.ts";
import { settingsHeight, settingsLines, settingsWidth, type SettingsLine } from "./settings.ts";
import { BUCKET_COLOR, COLOR, DONE_COLOR, paneStyle } from "./theme.ts";
import { cardLines, triageHints, type CardLineKind } from "./triage-card.ts";

export type { EditorPty, LaunchEditorPty } from "./editor-pty.ts";

export interface AppOptions {
  /** Today as YYYY-MM-DD, for due-date escalation (S7). Default: local date. */
  today?: () => string;
  urgentWithinDays?: number;
  /**
   * The full-screen editor (S11, the S22 fallback): runs the editor on `path`
   * with the terminal and resolves with its exit code. Default: `spawnEditor`
   * ($VISUAL, $EDITOR or vi).
   */
  runEditor?: (path: string) => Promise<number>;
  /**
   * Starts the editor command on `path` in a `cols` x `rows` PTY for the
   * floating editor (S22); throwing falls back to `runEditor`. Default:
   * `spawnEditorPty` (Bun's PTY).
   */
  launchEditorPty?: LaunchEditorPty;
  /**
   * Where $VISUAL/$EDITOR and EISEN_EDITOR_MODE (`fullscreen` skips the
   * floating editor) are read, and the editor's environment. Default: process.env.
   */
  env?: Record<string, string | undefined>;
  /** The quadrant labels to start with (S20). Default: classic. */
  preset?: PresetId;
  /** Shown in the status line at start, e.g. a config file that could not be used (S21). */
  warning?: string;
  /** More start-up warnings, after `warning` (e.g. a bad `keys` section, S29). */
  warnings?: readonly string[];
  /**
   * Key overrides by action name (the config's `keys`, S30): each list
   * replaces that action's keys. Bad ones are ignored with a warning.
   */
  keys?: Readonly<Record<string, unknown>>;
  /**
   * Persists the preset picked in the settings (S21); throwing keeps the
   * previous preset and shows the error. Default: applied for this session only.
   */
  savePreset?: (preset: PresetId) => void;
  /**
   * The view toggles to start with (S29). A missing field is off here (so
   * embedders and tests opt in); `startTui` passes the saved settings, whose
   * defaults are preview on, done panel off and bullets on.
   */
  view?: Partial<ViewSettings>;
  /**
   * Persists a toggled view setting (S29): the patch holds only the field that
   * changed. Throwing shows the error; the session keeps the new value.
   * Default: applied for this session only.
   */
  saveView?: (patch: Partial<ViewSettings>) => void;
}

const SIDEBAR_HIDDEN = `Sidebar hidden: needs ${SIDEBAR_MIN_COLUMNS} columns`;

export interface MatrixApp {
  /** Resolves when the user quits. */
  readonly done: Promise<void>;
  readonly state: ViewState;
  /** Resolves once no editor session (S11) is running. */
  idle(): Promise<void>;
  /** Reload tasks from the repository and redraw. */
  refresh(): void;
  /** Detach listeners and remove the view from the renderer. */
  destroy(): void;
}

/** The first key of a matrix (or triage) action, "" when it has none (S30). */
function firstKey(keymap: Keymap, id: string, scope: "normal" | "triage" = "normal"): string {
  return keysOf(keymap, scope, id)[0] ?? "";
}

const MOVES = ["move_left", "move_down", "move_up", "move_right"] as const;

/** `1-4` when the four send keys are 1..4, else their first keys joined by `sep`. */
function sendKeys(keymap: Keymap, scope: "normal" | "triage", sep: string): string {
  const keys = QUADRANTS.map((q) => firstKey(keymap, `send_q${q}`, scope));
  return keys.join("") === "1234" ? "1-4" : keys.filter(Boolean).join(sep);
}

/** The status line's key hints, from the keymap (S30); unbound actions are left out. */
function statusHints(keymap: Keymap): string {
  const item = (keys: string, label: string) => (keys ? [`${keys} ${label}`] : []);
  const one = (id: string, label: string) => item(firstKey(keymap, id), label);
  return [
    ...item(MOVES.map((id) => firstKey(keymap, id)).filter(Boolean).join("/"), "move"),
    ...item(sendKeys(keymap, "normal", "/"), "send"),
    ...one("new_task", "new"),
    ...one("quick_add", "quick add"),
    ...one("edit", "edit"),
    ...one("toggle_done", "done"),
    ...one("delete", "delete"),
    ...one("search", "search"),
    ...item([firstKey(keymap, "order_down"), firstKey(keymap, "order_up")].filter(Boolean).join("/"), "order"),
    ...one("toggle_done_panel", "done panel"),
    ...one("toggle_preview", "preview"),
    ...one("settings", "settings"),
    ...one("help", "help"),
    ...one("quit", "quit"),
  ].join(" · ");
}

/** `h j k l / arrows`: the first key of each move, then the others. */
function moveKeys(keymap: Keymap): string {
  const lists = MOVES.map((id) => keysOf(keymap, "normal", id));
  const first = lists.map((keys) => keys[0]).filter((k) => k !== undefined);
  const rest = lists.flatMap((keys) => keys.slice(1));
  const others = rest.join(" ") === "left down up right" ? "arrows" : rest.join(" ");
  return [first.join(" "), others].filter(Boolean).join(" / ");
}

/**
 * The help's rows with the keys from the keymap (S30); `1`–`4` name the
 * quadrants with the active preset (S20). Actions without a key are left out.
 */
function helpRows(preset: PresetId, keymap: Keymap): [string, string][] {
  const all = (id: string) => keysOf(keymap, "normal", id).join(" / ");
  const triageSkip = firstKey(keymap, "skip", "triage");
  const triageSend = sendKeys(keymap, "triage", "/");
  const triage = [triageSend && `${triageSend} sort`, triageSkip && `${triageSkip} skip`, "Esc exit"].filter(Boolean).join(", ");
  const rows: [string, string][] = [
    [moveKeys(keymap), "Move between quadrants, the Inbox strip and tasks"],
    ...QUADRANTS.map((q): [string, string] => [all(`send_q${q}`), `Send to ${labelFor(preset, q)}`]),
    [all("new_task"), "New task in $EDITOR, here or in the Inbox from its strip"],
    [all("quick_add"), "Quick add: type a title here (#tags work)"],
    [all("toggle_done"), "Toggle done"],
    [all("delete"), "Delete (y/n)"],
    [[all("order_down"), all("order_up")].filter(Boolean).join(" / "), "Reorder inside the quadrant or the Inbox"],
    [all("toggle_done_panel"), "Show / hide the done panel (l from Q2/Q4 enters it)"],
    [all("toggle_preview"), "Show / hide the preview of the selected task"],
    [[all("preview_down"), all("preview_up")].filter(Boolean).join(" / "), "Scroll the preview down / up"],
    [all("toggle_bullets"), "Show / hide the bullets"],
    [all("edit"), "Edit in $EDITOR (a floating box; quit it to save)"],
    [all("triage"), `Triage the Inbox: ${triage}`],
    [all("search"), "Search every task: type to filter, Enter keep, Esc clear"],
    [all("command_line"), "Command line: preview/done/bullets [on|off], add, search, triage, q (Tab completes)"],
    [all("settings"), "Settings: quadrant names"],
    [all("help"), "Help"],
    [all("quit"), "Quit"],
  ];
  return rows.filter(([keys]) => keys !== "");
}

/** What a `:` toggle command dispatches, and how its messages name it (S31). */
const TOGGLE_ACTION: Record<ViewToggle, Action> = {
  preview: { type: "togglePreview" },
  donePanel: { type: "toggleDonePanel" },
  bullets: { type: "toggleBullets" },
};
const TOGGLE_LABEL: Record<ViewToggle, string> = { preview: "Preview", donePanel: "Done panel", bullets: "Bullets" };

/** The first start-up warning, plus `(+N more)` when there are several. */
function startWarning(warnings: readonly string[]): string | null {
  if (warnings.length === 0) return null;
  return warnings.length === 1 ? warnings[0]! : `${warnings[0]} (+${warnings.length - 1} more)`;
}

const plain = (text: string): TextChunk => ({ __isChunk: true, text });

/**
 * `Q1 · ✅ Do (n)` in the preset's labels, or `Q1 (n)` when the pane is too
 * narrow for the label (display width, so the emoji count as 2); `count` is
 * the open count, or `matches/total` while searching (S19).
 */
function paneTitle(preset: PresetId, q: Quadrant, count: string, paneWidth = Infinity): string {
  const full = ` ${headingFor(preset, q)} (${count}) `;
  return Bun.stringWidth(full) + 4 <= paneWidth ? full : ` Q${q} (${count}) `;
}

/**
 * `📥 Inbox (n)` (S24), `📥 Inbox (matches/total)` while searching; ` Inbox (n) `
 * without the emoji, then ` (n) `, as the screen narrows.
 */
function stripTitle(preset: PresetId, count: string, width: number): string {
  for (const title of [` ${labelFor(preset, "inbox")} (${count}) `, ` Inbox (${count}) `]) {
    if (Bun.stringWidth(title) + 4 <= width) return title;
  }
  return ` (${count}) `;
}

/**
 * ` ✓ Done (n) ` (S27), `matches/total` while searching; ` Done (n) `, then
 * ` (n) `, as the panel narrows.
 */
function doneTitle(count: string, width: number): string {
  for (const title of [` ✓ Done (${count}) `, ` Done (${count}) `]) {
    if (Bun.stringWidth(title) + 4 <= width) return title;
  }
  return ` (${count}) `;
}

/** `Q1 · ✅ Do`, `📥 Inbox` or `✓ Done`, for messages. */
function focusLabel(preset: PresetId, focus: Focus): string {
  return focus === "done" ? "✓ Done" : headingFor(preset, focus);
}

/** Where `a`/`A` add a task: the focused pane, or beside the done panel when it is focused (S27). */
function addTarget(state: ViewState): Bucket {
  return state.focus === "done" ? state.besideDone : state.focus;
}

/** `MM-DD` of an ISO timestamp, in local time. */
function monthDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Most recently completed first (S27); ties by id, newest first. */
function byCompletion(a: Task, b: Task): number {
  const ca = a.completedAt ?? "";
  const cb = b.completedAt ?? "";
  if (ca !== cb) return ca < cb ? 1 : -1;
  return b.id - a.id;
}

interface Pane {
  box: BoxRenderable;
  text: TextRenderable;
}

/** The floating editor box (S22) and the editor running in it. */
interface FloatingEditor {
  box: BoxRenderable;
  term: EmbeddedTerminalRenderable;
  pty: EditorPty;
  /** `New task · ✅ Do` or `Edit · {title}`, before fitting it to the box. */
  title: string;
  /** The target quadrant's colour (S23). */
  color: string;
  /** The editor's name, for the status line. */
  name: string;
  /** The PTY's size as last set. */
  cols: number;
  rows: number;
}

/** What the editor is opened for: a new task in a quadrant or the Inbox, or an existing task. */
type EditTarget = { kind: "new"; focus: Bucket } | { kind: "edit"; id: number };

/** ` {title} ` fitted between the box's corners, or nothing when it is too narrow. */
function editorTitle(title: string, boxWidth: number): string | undefined {
  const room = boxWidth - 4;
  if (room < 3) return undefined;
  return Bun.stringWidth(title) + 2 <= room ? ` ${title} ` : ` ${fit(title, room - 2)} `;
}

/** Builds the matrix on `renderer` (a real one or `createTestRenderer`'s). */
export function createMatrixApp(renderer: CliRenderer, repo: TaskRepository, options: AppOptions = {}): MatrixApp {
  const today = options.today ?? (() => localToday());
  const within = options.urgentWithinDays ?? DEFAULT_URGENT_WITHIN_DAYS;
  const env = options.env ?? process.env;
  const runEditor = options.runEditor ?? ((path: string) => spawnEditor(path, env));
  const launchEditorPty: LaunchEditorPty =
    options.launchEditorPty ?? ((cmd, path, cols, rows) => spawnEditorPty(cmd, path, cols, rows, env));
  const savePreset = options.savePreset ?? (() => {});
  const saveView = options.saveView ?? (() => {});
  /** The running editor session; keys are ignored while it is set. */
  let editing: Promise<void> | null = null;
  /** The floating editor while it is open (S22): every key goes to it. */
  let floating: FloatingEditor | null = null;
  let destroyed = false;

  let state = initialState(options.preset, {
    preview: options.view?.preview ?? false,
    donePanel: options.view?.donePanel ?? false,
    bullets: options.view?.bullets ?? false,
  });
  // S30: the keys of the matrix and triage actions; bad overrides are warned at start.
  const { keymap, warnings: keyWarnings } = buildKeymap(options.keys);
  const hints = statusHints(keymap);
  /** Every task, open and done, as last read from the repository. */
  let all: Task[] = [];
  /** Folded fields of `all` for search (S19), built on the first query after a read. */
  let searchIndex: SearchIndex<Task> | null = null;
  let tasks: Record<Quadrant, Task[]> = { 1: [], 2: [], 3: [], 4: [] };
  let openCounts: Record<Quadrant, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let inboxCount = 0;
  /** Open Inbox tasks in display order: the triage queue's source (S12). */
  let inbox: Task[] = [];
  /** What the Inbox strip lists (S24): the open Inbox, or the Inbox matches (S19). */
  let strip: Task[] = [];
  /** What the done panel lists (S27): done tasks (or done matches), most recently completed first. */
  let doneList: Task[] = [];
  /** Every done task, for the panel's title. */
  let doneCount = 0;
  /** The sidebar as last sized; null while it is hidden (S26). */
  let sidebar: Sidebar | null = null;
  /**
   * The preview (S25): the task it shows, how far its description is
   * scrolled (back to 0 when the task changes) and the rows it got.
   */
  let preview = { id: null as number | null, scroll: 0, bodyRows: 0, maxScroll: 0 };
  /** Set while a non-blank query filters: matches and totals per pane. */
  let filter: { matches: number; total: Record<Focus, number> } | null = null;
  let currentDay = today();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  // ── View tree ────────────────────────────────────────────────────────────
  const container = new BoxRenderable(renderer, { id: "eisen", flexDirection: "column", width: "100%", height: "100%" });
  // S26: the grid and the Inbox strip on the left, the sidebar on the right.
  const main = new BoxRenderable(renderer, { id: "eisen-main", flexDirection: "row", flexShrink: 0 });
  const left = new BoxRenderable(renderer, { id: "eisen-left", flexDirection: "column", flexShrink: 0 });
  const side = new BoxRenderable(renderer, { id: "eisen-sidebar", flexDirection: "column", flexShrink: 0, visible: false });
  const rows = [0, 1].map(
    (i) => new BoxRenderable(renderer, { id: `eisen-row-${i}`, flexDirection: "row", flexShrink: 0 }),
  );
  /**
   * S23: the focused pane's title, redrawn bold over the one the box draws
   * (OpenTUI 0.8.4 boxes take a title colour but no attributes).
   */
  const boldTitles = new Map<BoxRenderable, { text: string; color: RGBA }>();
  function withBoldTitle(box: BoxRenderable): BoxRenderable {
    box.renderAfter = function (buffer) {
      const title = boldTitles.get(box);
      if (!title || box.title !== title.text || Bun.stringWidth(title.text) + 4 > this.width) return;
      // Left-aligned titles start 2 cells in, after the corner and one border cell.
      buffer.drawText(title.text, this.x + 2, this.y, title.color, undefined, TextAttributes.BOLD);
    };
    return box;
  }
  const panes = {} as Record<Quadrant, Pane>;
  for (const q of QUADRANTS) {
    const box = withBoldTitle(
      new BoxRenderable(renderer, {
        id: `eisen-q${q}`,
        border: true,
        borderStyle: "rounded",
        borderColor: COLOR.border,
        titleColor: COLOR.title,
        title: paneTitle(state.preset, q, "0"),
        flexShrink: 0,
        overflow: "hidden",
      }),
    );
    const text = new TextRenderable(renderer, { id: `eisen-q${q}-list`, content: "", wrapMode: "none", fg: COLOR.text });
    box.add(text);
    rows[q <= 2 ? 0 : 1]!.add(box);
    panes[q] = { box, text };
  }
  const stripBox = withBoldTitle(
    new BoxRenderable(renderer, {
      id: "eisen-inbox",
      border: true,
      borderStyle: "rounded",
      borderColor: COLOR.border,
      titleColor: COLOR.title,
      flexShrink: 0,
      overflow: "hidden",
      visible: false,
    }),
  );
  const stripText = new TextRenderable(renderer, { id: "eisen-inbox-list", content: "", wrapMode: "none", fg: COLOR.text });
  stripBox.add(stripText);
  // S27: the done panel, in the sidebar (the preview panel, S25, goes above it).
  const doneBox = withBoldTitle(
    new BoxRenderable(renderer, {
      id: "eisen-done",
      border: true,
      borderStyle: "rounded",
      borderColor: COLOR.border,
      titleColor: DONE_COLOR,
      flexShrink: 0,
      overflow: "hidden",
      visible: false,
    }),
  );
  const doneText = new TextRenderable(renderer, { id: "eisen-done-list", content: "", wrapMode: "none", fg: COLOR.text });
  doneBox.add(doneText);
  // S25: the preview panel, above the done panel; never focused.
  const previewBox = new BoxRenderable(renderer, {
    id: "eisen-preview",
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.border,
    titleColor: COLOR.title,
    flexShrink: 0,
    overflow: "hidden",
    visible: false,
  });
  const previewText = new TextRenderable(renderer, { id: "eisen-preview-text", content: "", wrapMode: "none", fg: COLOR.text });
  previewBox.add(previewText);
  side.add(previewBox);
  side.add(doneBox);
  const status = new TextRenderable(renderer, {
    id: "eisen-status",
    content: "",
    wrapMode: "none",
    height: 1,
    flexShrink: 0,
    fg: COLOR.text,
    bg: COLOR.statusBg,
  });
  const help = new BoxRenderable(renderer, {
    id: "eisen-help",
    position: "absolute",
    zIndex: 10,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.focus,
    title: " Help ",
    titleColor: COLOR.focus,
    backgroundColor: COLOR.panel,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const helpText = new TextRenderable(renderer, { id: "eisen-help-text", content: "", wrapMode: "none" });
  help.add(helpText);
  // S21: the presets with a preview of their labels, over the grid.
  const settings = new BoxRenderable(renderer, {
    id: "eisen-settings",
    position: "absolute",
    zIndex: 10,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.focus,
    title: " Settings · quadrant names ",
    titleColor: COLOR.focus,
    backgroundColor: COLOR.panel,
    paddingLeft: 1,
    paddingRight: 1,
    overflow: "hidden",
  });
  const settingsText = new TextRenderable(renderer, { id: "eisen-settings-text", content: "", wrapMode: "none" });
  settings.add(settingsText);
  // The triage card covers the grid (not the status line) while triaging.
  const card = new BoxRenderable(renderer, {
    id: "eisen-triage",
    position: "absolute",
    zIndex: 5,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.focus,
    titleColor: COLOR.focus,
    backgroundColor: COLOR.panel,
    paddingLeft: 1,
    paddingRight: 1,
    overflow: "hidden",
  });
  const cardText = new TextRenderable(renderer, { id: "eisen-triage-text", content: "", wrapMode: "none" });
  card.add(cardText);
  for (const row of rows) left.add(row);
  left.add(stripBox);
  main.add(left);
  main.add(side);
  container.add(main);
  container.add(status);
  container.add(card);
  container.add(help);
  container.add(settings);
  renderer.root.add(container);

  // ── Data ─────────────────────────────────────────────────────────────────
  /** Reads every task; done ones are needed by the done panel (S27) and by search (S19). */
  function fetch(): void {
    currentDay = today();
    all = repo.list({ status: "all" });
    searchIndex = null;
  }

  /** The sidebar for view state `s` at the current size, or null while hidden (S26). */
  function sidebarFor(s: ViewState): Sidebar | null {
    return sidebarLayout(renderer.width, renderer.height, { preview: s.preview, done: s.donePanel });
  }

  /**
   * Splits `all` into the panes, the Inbox strip and the done panel for view
   * state `s`. Done tasks go to the done panel while it is on screen (S27);
   * otherwise they show only as search matches, in their quadrant (S19).
   */
  function build(s: ViewState): void {
    let rank: Map<number, number> | null = null;
    if (s.query.trim() !== "") {
      searchIndex ??= prepareSearch(all);
      rank = new Map(search(searchIndex, s.query).map((m, i) => [m.task.id, i]));
    }
    sidebar = sidebarFor(s);
    const panel = sidebar !== null && sidebar.done > 0;
    const next: Record<Quadrant, Task[]> = { 1: [], 2: [], 3: [], 4: [] };
    const counts: Record<Quadrant, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const total: Record<Focus, number> = { 1: 0, 2: 0, 3: 0, 4: 0, inbox: 0, done: 0 };
    const nextInbox: Task[] = [];
    const nextStrip: Task[] = [];
    const nextDone: Task[] = [];
    let dones = 0;
    for (const task of all) {
      const bucket = displayBucket(task, currentDay, within);
      const open = task.status === "open";
      if (!open) dones++;
      if (open && bucket === "inbox") nextInbox.push(task);
      if (open && bucket !== "inbox") counts[bucket]++;
      const matched = rank ? rank.has(task.id) : true;
      if (!open && panel) {
        total.done++;
        if (matched) nextDone.push(task);
        continue;
      }
      total[bucket]++;
      // A query shows its matches, done ones included (the panel is off screen);
      // without one, only open tasks.
      if (!(rank ? matched : open)) continue;
      if (bucket === "inbox") nextStrip.push(task);
      else next[bucket].push(task);
    }
    if (rank) {
      const order = (a: Task, b: Task) => rank.get(a.id)! - rank.get(b.id)!;
      for (const q of QUADRANTS) next[q].sort(order);
      nextStrip.sort(order);
    }
    nextDone.sort(byCompletion);
    tasks = next;
    openCounts = counts;
    inbox = nextInbox;
    inboxCount = nextInbox.length;
    strip = nextStrip;
    doneList = nextDone;
    doneCount = dones;
    filter = rank ? { matches: rank.size, total } : null;
  }

  function load(): void {
    fetch();
    build(state);
  }

  /** The panes' lists; `done` only while the done panel is on screen (S27). */
  const items = (): PaneItems => ({
    ...tasks,
    inbox: strip,
    ...(sidebar !== null && sidebar.done > 0 ? { done: doneList } : {}),
  });

  function taskById(id: number | null): Task | undefined {
    if (id === null) return undefined;
    return all.find((t) => t.id === id);
  }

  /**
   * Reload (or, for `fresh: false`, only re-filter what was read last), then
   * drop triage cards whose task left the Inbox meanwhile.
   */
  function reload(next: ViewState, fresh = true): ViewState {
    try {
      if (fresh) fetch();
    } catch (error) {
      // Keep the last loaded tasks on screen and say why they may be stale.
      next = { ...next, status: errorMessage(error) };
    }
    build(next);
    return syncTriage(next, inbox);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  /**
   * Grid sizes, the Inbox strip's height (1: a title line without a border;
   * S24) and the width left of the sidebar (S26).
   */
  function sizes() {
    const stripRows = stripHeight(renderer.height);
    const leftWidth = Math.max(0, renderer.width - (sidebar?.width ?? 0));
    return { g: gridSizes(leftWidth, renderer.height, stripRows), stripRows, leftWidth };
  }

  function layout(): void {
    const width = renderer.width;
    const height = renderer.height;
    const { g, stripRows, leftWidth } = sizes();
    const above = Math.max(0, height - 1);
    main.width = width;
    main.height = above;
    left.width = leftWidth;
    left.height = above;
    side.visible = sidebar !== null;
    side.width = sidebar?.width ?? 0;
    side.height = above;
    previewBox.visible = (sidebar?.preview ?? 0) > 0;
    previewBox.width = sidebar?.width ?? 0;
    previewBox.height = sidebar?.preview ?? 0;
    doneBox.visible = (sidebar?.done ?? 0) > 0;
    doneBox.border = (sidebar?.done ?? 0) > 1;
    doneBox.width = sidebar?.width ?? 0;
    doneBox.height = sidebar?.done ?? 0;
    rows[0]!.height = g.top;
    rows[1]!.height = g.bottom;
    for (const q of QUADRANTS) {
      const paneHeight = q <= 2 ? g.top : g.bottom;
      panes[q].box.width = q % 2 === 1 ? g.left : g.right;
      panes[q].box.height = paneHeight;
      // A bordered box takes 2 rows whatever its height: on a tiny screen it
      // would spill over the Inbox strip's line (S24).
      panes[q].box.visible = paneHeight >= 2;
    }
    stripBox.visible = stripRows > 0;
    stripBox.border = stripRows > 1;
    stripBox.width = leftWidth;
    stripBox.height = stripRows;
    status.width = width;
    const rowsOfHelp = helpRows(state.preset, keymap);
    const helpWidth = Math.min(helpContentWidth(rowsOfHelp) + 4, Math.max(0, width - 4));
    const helpHeight = Math.min(rowsOfHelp.length + 2, Math.max(0, height - 2));
    help.width = helpWidth;
    help.height = helpHeight;
    help.left = Math.max(0, Math.floor((width - helpWidth) / 2));
    help.top = Math.max(0, Math.floor((height - 1 - helpHeight) / 2));
    card.left = 0;
    card.top = 0;
    card.width = width;
    card.height = Math.max(0, height - 1);
    const { width: settingsW, height: settingsH } = settingsSize();
    settings.width = settingsW;
    settings.height = settingsH;
    settings.left = Math.max(0, Math.floor((width - settingsW) / 2));
    settings.top = Math.max(0, Math.floor((height - 1 - settingsH) / 2));
    layoutEditor();
  }

  /** The floating editor follows the screen (S22): its box, the embedded terminal and the PTY. */
  function layoutEditor(): void {
    const f = floating;
    if (!f) return;
    const rect = editorBox(renderer.width, renderer.height);
    f.box.left = rect.left;
    f.box.top = rect.top;
    f.box.width = rect.width;
    f.box.height = rect.height;
    f.box.title = editorTitle(f.title, rect.width);
    const cols = Math.max(1, rect.width - 2);
    const rows = Math.max(1, rect.height - 2);
    f.term.width = cols;
    f.term.height = rows;
    if (cols === f.cols && rows === f.rows) return;
    f.cols = cols;
    f.rows = rows;
    try {
      f.pty.resize(cols, rows);
    } catch {
      // The editor is exiting: its PTY is already closed.
    }
  }

  /** The settings box: its lines plus border (2) and padding (2), never over the status line. */
  function settingsSize(): { width: number; height: number } {
    return {
      width: Math.min(settingsWidth() + 4, renderer.width),
      height: Math.min(settingsHeight() + 2, Math.max(0, renderer.height - 1)),
    };
  }

  function drawSettings(): void {
    settings.visible = state.mode === "settings";
    if (!settings.visible) return;
    const size = settingsSize();
    const inner = { width: Math.max(0, size.width - 4), height: Math.max(0, size.height - 2) };
    const title = " Settings · quadrant names ";
    settings.title = Bun.stringWidth(title) + 4 <= size.width ? title : undefined;
    const chunks: TextChunk[] = [];
    settingsLines(state.preset, state.settingsCursor, inner.width, inner.height).forEach((l, i) => {
      if (i > 0) chunks.push(plain("\n"));
      chunks.push(settingsChunk(l));
    });
    settingsText.content = new StyledText(chunks);
  }

  /** Inner size of the card: border (2) and padding (2) across, border (2) down. */
  function cardInner(): { width: number; height: number } {
    return { width: Math.max(0, renderer.width - 4), height: Math.max(0, renderer.height - 1 - 2) };
  }

  function drawCard(): void {
    const t = state.triage;
    card.visible = t !== null;
    if (!t) return;
    const task = taskById(t.queue[t.index] ?? null);
    const label = ` Triage ${t.index + 1}/${t.queue.length} `;
    card.title = Bun.stringWidth(label) + 2 <= renderer.width ? label : undefined;
    const inner = cardInner();
    if (!task) {
      cardText.content = new StyledText([fg(COLOR.muted)(fit("Task not found", inner.width))]);
      return;
    }
    const chunks: TextChunk[] = [];
    cardLines(task, inner.width, inner.height, triageHints(state.preset, keymap)).forEach((l, i) => {
      if (i > 0) chunks.push(plain("\n"));
      chunks.push(CARD_STYLE[l.kind](l.text));
    });
    cardText.content = new StyledText(chunks);
  }

  function draw(): void {
    // The Inbox strip comes and goes with the search: size the grid first.
    layout();
    const { g, stripRows, leftWidth } = sizes();
    for (const q of QUADRANTS) {
      const pane = panes[q];
      const inner = {
        width: Math.max(0, (q % 2 === 1 ? g.left : g.right) - 2),
        height: Math.max(0, (q <= 2 ? g.top : g.bottom) - 2),
      };
      const count = filter ? `${tasks[q].length}/${filter.total[q]}` : `${openCounts[q]}`;
      drawList(pane.box, pane.text, tasks[q], q, inner, paneTitle(state.preset, q, count, inner.width + 2));
    }
    const stripCount = filter ? `${strip.length}/${filter.total.inbox}` : `${inboxCount}`;
    if (stripRows === 1) drawStripLine(stripCount);
    else if (stripRows > 1) {
      const inner = { width: Math.max(0, leftWidth - 2), height: Math.max(0, stripRows - 2) };
      drawList(stripBox, stripText, strip, "inbox", inner, stripTitle(state.preset, stripCount, leftWidth));
    }
    drawPreview();
    drawDonePanel();
    status.content = statusContent(renderer.width);
    drawCard();
    help.visible = state.mode === "help";
    if (help.visible) helpText.content = helpContent(helpRows(state.preset, keymap));
    drawSettings();
    renderer.requestRender();
  }

  /**
   * A tiny screen's strip (S24): only its title, on one line without a
   * border, in the Inbox colour (bold while focused); the keys still act on
   * its selected task.
   */
  function drawStripLine(count: string): void {
    const style = paneStyle("inbox", state.focus === "inbox");
    stripBox.title = undefined;
    stripBox.bottomTitle = undefined;
    boldTitles.delete(stripBox);
    const title = fg(style.title)(` ${labelFor(state.preset, "inbox")} (${count})`);
    stripText.content = line(renderer.width, [style.bold ? bold(title) : title]);
  }

  /**
   * The preview panel (S25): the selected task (the triage card's while
   * triaging), its description from `preview.scroll` on, which goes back to
   * the top whenever the task changes.
   */
  function drawPreview(): void {
    const rowsOfPanel = sidebar?.preview ?? 0;
    if (rowsOfPanel === 0 || !sidebar) return;
    const id = currentId(state, items());
    if (id !== preview.id) preview = { ...preview, id, scroll: 0 };
    const task = taskById(id) ?? null;
    const info = task ? previewInfo(task, state.preset, currentDay, within) : null;
    const inner = { width: Math.max(0, sidebar.width - 2), height: Math.max(0, rowsOfPanel - 2) };
    const model = previewLines(task, inner.width, inner.height, preview.scroll, info);
    preview = { ...preview, scroll: model.scroll, bodyRows: model.bodyRows, maxScroll: model.maxScroll };
    const title = " Preview ";
    previewBox.title = Bun.stringWidth(title) + 4 <= sidebar.width ? title : undefined;
    const shown = Math.min(model.bodyRows, model.total - model.scroll);
    previewBox.bottomTitle =
      model.total > model.bodyRows && shown > 0 ? ` ${model.scroll + 1}-${model.scroll + shown} of ${model.total} ` : undefined;
    previewBox.bottomTitleAlignment = "right";
    const chunks: TextChunk[] = [];
    model.lines.forEach((l, i) => {
      if (i > 0) chunks.push(plain("\n"));
      chunks.push(previewChunk(l.kind, fit(l.text, inner.width), info));
    });
    previewText.content = new StyledText(chunks);
  }

  /** The done panel (S27): a bordered list, or its title line alone when collapsed (S26). */
  function drawDonePanel(): void {
    const rowsOfPanel = sidebar?.done ?? 0;
    if (rowsOfPanel === 0 || !sidebar) return;
    const count = filter ? `${doneList.length}/${filter.total.done}` : `${doneCount}`;
    if (rowsOfPanel === 1) {
      const style = paneStyle("done", state.focus === "done");
      doneBox.title = undefined;
      doneBox.bottomTitle = undefined;
      boldTitles.delete(doneBox);
      const title = fg(style.title)(` ✓ Done (${count})`);
      doneText.content = line(sidebar.width, [style.bold ? bold(title) : title]);
      return;
    }
    const inner = { width: Math.max(0, sidebar.width - 2), height: Math.max(0, rowsOfPanel - 2) };
    drawList(doneBox, doneText, doneList, "done", inner, doneTitle(count, sidebar.width));
  }

  /** One pane: title, focus colour, the window of rows around its selection. */
  function drawList(
    box: BoxRenderable,
    text: TextRenderable,
    list: Task[],
    id: Focus,
    inner: { width: number; height: number },
    title: string,
  ): void {
    const focused = state.focus === id;
    const selected = state.selected[id] ?? 0;
    const style = paneStyle(id, focused);
    box.title = title;
    box.borderColor = style.border;
    box.titleColor = style.title;
    if (style.bold) boldTitles.set(box, { text: title, color: RGBA.fromHex(style.title) });
    else boldTitles.delete(box);
    const start = windowStart(selected, list.length, inner.height);
    const visible = list.slice(start, start + inner.height);
    box.bottomTitle =
      list.length > inner.height && inner.height > 0 ? ` ${start + 1}-${start + visible.length} of ${list.length} ` : undefined;
    box.bottomTitleAlignment = "right";
    text.content = paneContent(visible, start, inner.width, focused ? selected : -1, style.selectBg, id);
  }

  function paneContent(
    visible: Task[],
    start: number,
    width: number,
    selected: number,
    selectBg: string,
    pane: Focus,
  ): StyledText {
    if (visible.length === 0) {
      const empty = filter ? "  No matches" : pane === "done" ? "  Nothing done yet" : "  No tasks";
      return new StyledText([fg(COLOR.muted)(fit(empty, width))]);
    }
    const chunks: TextChunk[] = [];
    visible.forEach((task, i) => {
      if (i > 0) chunks.push(plain("\n"));
      const highlight = start + i === selected ? selectBg : null;
      chunks.push(...(pane === "done" ? doneRowChunks(task, width, highlight) : rowChunks(task, width, highlight, pane)));
    });
    return new StyledText(chunks);
  }

  /** The 2-column mark, clipped to `width`. */
  const markText = (mark: string, width: number) => `${mark} `.slice(0, Math.min(2, width));

  /**
   * One task row in a quadrant or the strip; `selectBg` is the highlight of
   * the selected row (S23), null for the others. The mark: `✓` done, `!`
   * escalated (S7), else `•` in the pane's colour with bullets on (S28) or blank.
   */
  function rowChunks(task: Task, width: number, selectBg: string | null, pane: Bucket): TextChunk[] {
    const isDone = task.status === "done";
    const escalated = isEscalated(task, currentDay, within);
    const mark = isDone ? "✓" : escalated ? "!" : state.bullets ? "•" : " ";
    const markColor = isDone ? COLOR.ok : escalated || !state.bullets ? COLOR.escalated : BUCKET_COLOR[pane];
    const due = task.dueDate && width >= 28 ? ` ${task.dueDate}` : "";
    const titleWidth = Math.max(0, width - 2 - due.length);
    const parts: TextChunk[] = [
      fg(markColor)(bold(markText(mark, width))),
      isDone ? dim(fg(COLOR.done)(fit(task.title, titleWidth))) : fg(COLOR.text)(fit(task.title, titleWidth)),
    ];
    if (due) parts.push(fg(escalated ? COLOR.escalated : isDone ? COLOR.done : COLOR.due)(due));
    return selectBg ? parts.map((chunk) => bg(selectBg)(chunk)) : parts;
  }

  /**
   * One row of the done panel (S27): `✓` in the task's quadrant colour (Inbox
   * grey), the title, and the completion date `MM-DD` on the right when the
   * panel is wide enough.
   */
  function doneRowChunks(task: Task, width: number, selectBg: string | null): TextChunk[] {
    const day = task.completedAt && width >= 20 ? monthDay(task.completedAt) : "";
    const date = day ? ` ${day}` : "";
    const titleWidth = Math.max(0, width - 2 - date.length);
    const parts: TextChunk[] = [
      fg(BUCKET_COLOR[bucketOf(task)])(bold(markText("✓", width))),
      fg(COLOR.text)(fit(task.title, titleWidth)),
    ];
    if (date) parts.push(fg(COLOR.muted)(date));
    return selectBg ? parts.map((chunk) => bg(selectBg)(chunk)) : parts;
  }

  /** `2 matches`, `No matches for "q"`, or null when no query filters. */
  function matchesText(): string | null {
    if (!filter) return null;
    if (filter.matches === 0) return `No matches for "${state.query.trim()}"`;
    return `${filter.matches} ${filter.matches === 1 ? "match" : "matches"}`;
  }

  /** `Triage 2/8 · ? help`, with the triage help key (S30). */
  function triageStatus(where: string): string {
    const key = firstKey(keymap, "help", "triage");
    return key ? `${where} · ${key} help` : where;
  }

  function statusContent(width: number): StyledText {
    if (floating) {
      return line(width, [
        fg(floating.color)(bold(` ${floating.name}`)),
        fg(COLOR.muted)("  │ save and quit to finish · quit without saving to cancel"),
      ]);
    }
    const quadrant = focusLabel(state.preset, addTarget(state));
    switch (state.mode) {
      case "settings":
        return line(width, [fg(COLOR.focus)(bold(" Settings")), fg(COLOR.muted)("  │ j/k choose · Enter save · Esc cancel")]);
      case "command": {
        const prefix = " :";
        const cycle = state.command.completion;
        const after = cycle
          ? `  ${cycle.candidates.map((c) => c.trim().split(/\s+/).at(-1)).join(" ")}`
          : "  Tab complete · ↑↓ history · Enter run · Esc cancel";
        const room = Math.max(1, width - Bun.stringWidth(prefix) - Math.min(Bun.stringWidth(after), 40) - 1);
        return line(width, [
          fg(COLOR.focus)(bold(prefix)),
          plain(tail(state.command.line, room)),
          fg(COLOR.focus)("█"),
          fg(COLOR.muted)(after),
        ]);
      }
      case "search": {
        const prefix = " / ";
        const after = `  ${matchesText() ?? "type to search"} · Enter keep · Esc clear`;
        // Keep room for the result after the query; the query scrolls left.
        const room = Math.max(1, width - Bun.stringWidth(prefix) - Math.min(Bun.stringWidth(after), 40) - 1);
        return line(width, [
          fg(COLOR.focus)(bold(prefix)),
          plain(tail(state.query, room)),
          fg(COLOR.focus)("█"),
          (filter?.matches === 0 ? fg(COLOR.due) : fg(COLOR.muted))(after),
        ]);
      }
      case "add": {
        const prefix = ` Add to ${quadrant}: `;
        const hint = "  Enter save · Esc cancel";
        const room = Math.max(1, width - Bun.stringWidth(prefix) - hint.length - 1);
        return line(width, [
          fg(COLOR.focus)(bold(prefix)),
          plain(tail(state.input, room)),
          fg(COLOR.focus)("█"),
          fg(COLOR.muted)(hint),
        ]);
      }
      case "confirmDelete": {
        const task = taskById(currentId(state, items()));
        return line(width, [fg(COLOR.escalated)(bold(` Delete "${task?.title ?? ""}"? y/n`))]);
      }
      case "triage": {
        const t = state.triage;
        const where = t ? `Triage ${t.index + 1}/${t.queue.length}` : "Triage";
        return line(width, [
          plain(" "),
          state.status ? fg(COLOR.due)(state.status) : fg(COLOR.muted)(triageStatus(where)),
        ]);
      }
      case "help":
        return line(width, [fg(COLOR.muted)(" Esc close help")]);
      case "normal": {
        // S24: the Inbox count lives in the strip's title, not here.
        const result = matchesText();
        const searchKey = firstKey(keymap, "search");
        const edit = searchKey ? ` · ${searchKey} edit` : "";
        const hint = result === null ? fg(COLOR.muted)(hints) : fg(COLOR.due)(`${result}${edit} · Esc clear · ${hints}`);
        return line(width, [plain(" "), state.status ? fg(COLOR.due)(state.status) : hint]);
      }
    }
  }

  /** Chunks clipped and padded to exactly `width` columns. */
  function line(width: number, chunks: TextChunk[]): StyledText {
    const out: TextChunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const room = width - used;
      if (room <= 0) break;
      const w = Bun.stringWidth(chunk.text);
      const text = w <= room ? chunk.text : fit(chunk.text, room);
      out.push({ ...chunk, text });
      used += Math.min(w, room);
    }
    if (used < width) out.push(plain(" ".repeat(width - used)));
    return new StyledText(out);
  }

  // ── Controller ───────────────────────────────────────────────────────────
  function dispatch(action: Action): void {
    const before = state;
    const id = currentId(before, items());
    let next = reduce(before, action, items(), inbox);
    let followId: number | null = null;
    let message: string | null = null;
    let failed = false;
    if ((action.type === "edit" && id !== null) || action.type === "newTask") {
      // The editor owns the keys from here; the session redraws when it is over.
      state = next;
      const target: EditTarget = action.type === "newTask" ? { kind: "new", focus: addTarget(before) } : { kind: "edit", id: id! };
      editing = editorSession(target).finally(() => (editing = null));
      return;
    }
    if (action.type === "submitCommand") {
      runCommand(before.command.line, next);
      return;
    }
    try {
      switch (action.type) {
        case "moveTo": {
          if (id === null) {
            message = "Nothing selected";
            break;
          }
          const from = bucketOf(repo.get(id)!);
          repo.move(id, action.quadrant);
          const label = headingFor(before.preset, action.quadrant);
          message = from === action.quadrant ? `Already in ${label}` : `Moved to ${label}`;
          break;
        }
        case "toggleDone": {
          if (id === null) {
            message = "Nothing selected";
            break;
          }
          const task = repo.toggleDone(id);
          message = task.status === "done" ? `Done: ${task.title}` : `Reopened: ${task.title}`;
          followId = id;
          break;
        }
        case "confirmDelete": {
          if (id === null) break;
          const task = repo.get(id);
          repo.delete(id);
          message = `Deleted: ${task?.title ?? id}`;
          break;
        }
        case "edit":
          message = "Nothing selected";
          break;
        case "reorder":
          // S27: the done panel keeps the completion order (the reducer said so).
          if (id !== null && before.focus !== "done") {
            repo.reorder(id, action.dir);
            followId = id;
          }
          break;
        case "submitAdd": {
          const title = before.input.trim();
          if (!title) {
            message = "Empty title: nothing added";
            break;
          }
          const target = addTarget(before);
          const task = repo.create({ title, quadrant: target === "inbox" ? null : target, tags: parseTags(title) });
          followId = task.id;
          message = `Added to ${focusLabel(before.preset, target)}`;
          break;
        }
        case "toggleDonePanel": {
          // S29: the session keeps the new value even when it cannot be saved.
          message = `Done panel ${next.donePanel ? "on" : "off"}`;
          if (next.donePanel && sidebarFor(next) === null) message += ` · ${SIDEBAR_HIDDEN}`;
          saveView({ donePanel: next.donePanel });
          break;
        }
        case "toggleBullets":
          message = `Bullets ${next.bullets ? "on" : "off"}`;
          saveView({ bullets: next.bullets });
          break;
        case "togglePreview": {
          // S29: the session keeps the new value even when it cannot be saved.
          message = `Preview ${next.preview ? "on" : "off"}`;
          if (next.preview && sidebarFor(next) === null) message += ` · ${SIDEBAR_HIDDEN}`;
          saveView({ preview: next.preview });
          break;
        }
        case "scrollPreview": {
          // Half the description's rows per key, within what it has (S25).
          const step = Math.max(1, Math.floor(preview.bodyRows / 2));
          preview = { ...preview, scroll: Math.max(0, Math.min(preview.maxScroll, preview.scroll + action.dir * step)) };
          break;
        }
        case "saveSettings": {
          // S21: the reducer applied the choice; keep it only if it is saved.
          const name = getPreset(next.preset).name;
          if (next.preset === before.preset) {
            message = `Preset unchanged: ${name}`;
            break;
          }
          savePreset(next.preset);
          message = `Preset: ${name}`;
          break;
        }
        default:
          break;
      }
    } catch (error) {
      message = errorMessage(error);
      failed = true;
    }
    // A failed effect keeps the triage card where it was.
    if (failed && before.triage) next = { ...next, mode: "triage", triage: before.triage };
    // A preset that could not be saved is not applied either.
    if (failed && action.type === "saveSettings") next = { ...next, preset: before.preset };
    // The end-of-triage summary wins over the last move's message, not over an error.
    if (message !== null && (failed || next.status === null)) next = { ...next, status: message };
    state = next; // build() reads the done panel toggle from the new state
    // Quitting never depends on the repository: a failing reload must not
    // keep the user in the alternate screen.
    if (state.quit) {
      resolveDone();
      return;
    }
    // Search keys only re-filter what is loaded: no read per keystroke.
    const typing = action.type === "search" || action.type === "searchInput" || action.type === "searchBackspace";
    // Leaving the search keeps the selected match selected in the full view.
    if (action.type === "clearSearch" || action.type === "submitSearch") followId = id;
    // Typing on the `:` line only redraws the status line: no read per keystroke.
    const commandTyping = state.mode === "command" || action.type === "cancelCommand";
    next = reload(next, !typing && !commandTyping);
    state = followId === null ? clamp(next, items()) : follow(next, items(), followId);
    if (typing || action.type === "runSearch") state = focusMatches(state, items());
    draw();
  }

  /**
   * S31: Enter on the `:` line. `closed` is the state with the line closed
   * and recorded in the history. A parse error, or `on`/`off` that is already
   * the value, changes nothing and saves nothing; everything else goes
   * through the same action as its key (`p`, `.`, `A` + Enter, `/` + Enter…),
   * so it is saved and reported the same way.
   */
  function runCommand(text: string, closed: ViewState): void {
    state = closed;
    const parsed = parseCommand(text);
    if (!parsed.ok || parsed.command === null) {
      if (!parsed.ok) state = { ...state, status: parsed.error };
      draw();
      return;
    }
    const command = parsed.command;
    switch (command.kind) {
      case "toggle": {
        const current = state[command.view];
        if (command.value === current) {
          state = { ...state, status: `${TOGGLE_LABEL[command.view]} already ${current ? "on" : "off"}` };
          draw();
          return;
        }
        return dispatch(TOGGLE_ACTION[command.view]);
      }
      case "settings":
        return dispatch({ type: "openSettings" });
      case "help":
        return dispatch({ type: "help" });
      case "triage":
        return dispatch({ type: "triage" });
      case "quit":
        return dispatch({ type: "quit" });
      case "search":
        return dispatch({ type: "runSearch", query: command.query });
      case "add":
        // The quick add's own path (`A`, S22): same target, `#tags` and messages.
        state = { ...state, mode: "add", input: command.title };
        return dispatch({ type: "submitAdd" });
    }
  }

  /**
   * S22 (S11 for the full-screen fallback): write the task, or the new-task
   * template, to a 0600 temp file, run the editor on it, read it back, then
   * create the task (`a`) or save what changed (`e`). Never rejects: every
   * outcome ends in the status line, and the temp file is always deleted.
   * Keys go to the editor (floating) or are ignored (full screen) until this
   * settles.
   */
  async function editorSession(target: EditTarget): Promise<void> {
    let message: string;
    let path: string | null = null;
    let followId = target.kind === "edit" ? target.id : null;
    /** The pane a new task goes to; null when editing. */
    const newIn = target.kind === "new" ? target.focus : null;
    // A crash or exit while the editor is open: no editor left running, no task text left in /tmp.
    const onExit = () => {
      floating?.pty.kill();
      if (path !== null) removeQuietly(path);
    };
    process.on("exit", onExit);
    try {
      const task = target.kind === "edit" ? repo.get(target.id) : null;
      if (target.kind === "edit" && !task) throw new Error(`Task ${target.id} not found`);
      path = join(tmpdir(), `eisen-${task ? task.id : "new"}-${crypto.randomUUID().slice(0, 8)}.md`);
      writeFileSync(path, task ? serializeTask(task) : NEW_TASK_FILE, { flag: "wx", mode: 0o600 });
      const bucket = task ? displayBucket(task, currentDay, within) : (newIn ?? "inbox");
      const title = task ? `Edit · ${task.title}` : `New task · ${labelFor(state.preset, bucket)}`;
      const code = await runInEditor(path, title, BUCKET_COLOR[bucket]);
      if (destroyed) return;
      if (code !== 0) message = `Editor exited with code ${code}`;
      else if (task) message = saveEdit(task, readFileSync(path, "utf8"));
      else {
        const created = createFromFile(newIn ?? "inbox", readFileSync(path, "utf8"));
        message = created.message;
        followId = created.id;
      }
    } catch (error) {
      message = errorMessage(error);
    } finally {
      process.off("exit", onExit);
      if (path !== null) removeQuietly(path);
    }
    if (destroyed) return;
    const next = reload({ ...state, status: message });
    state = followId === null ? clamp(next, items()) : follow(next, items(), followId);
    try {
      draw();
    } catch {
      // Same as a key handler's draw failing: the next key redraws.
    }
  }

  /**
   * Runs the editor on `path`: in the floating box when the screen is big
   * enough, EISEN_EDITOR_MODE is not `fullscreen` and the PTY starts;
   * otherwise full screen. Resolves with the editor's exit code.
   */
  async function runInEditor(path: string, title: string, color: string): Promise<number> {
    const wanted = env.EISEN_EDITOR_MODE !== "fullscreen" && editorFits(renderer.width, renderer.height);
    const session = wanted ? openFloating(path, title, color) : null;
    if (session) {
      try {
        return await session.pty.exited;
      } finally {
        closeFloating(session);
      }
    }
    // S11: since OpenTUI 0.6 suspend()/resume() throw while another transition is pending.
    await renderer.suspend();
    try {
      return await runEditor(path);
    } finally {
      await renderer.resume();
    }
  }

  /**
   * Opens the floating box with the editor running in it, focused; null when
   * the embedded terminal or the PTY cannot start (the caller falls back).
   */
  function openFloating(path: string, title: string, color: string): FloatingEditor | null {
    const rect = editorBox(renderer.width, renderer.height);
    const cols = Math.max(1, rect.width - 2);
    const rows = Math.max(1, rect.height - 2);
    let box: BoxRenderable | null = null;
    let term: EmbeddedTerminalRenderable;
    let pty: EditorPty;
    // Keys and the box's replies to terminal queries go to the editor once it runs.
    let toEditor: ((data: Uint8Array) => void) | null = null;
    try {
      box = new BoxRenderable(renderer, {
        id: "eisen-editor",
        position: "absolute",
        zIndex: 20,
        border: true,
        borderStyle: "rounded",
        borderColor: color,
        titleColor: color,
        backgroundColor: COLOR.panel,
        overflow: "hidden",
      });
      term = new EmbeddedTerminalRenderable(renderer, {
        id: "eisen-editor-terminal",
        cols,
        rows,
        width: cols,
        height: rows,
        onData: (data) => toEditor?.(data),
      });
      box.add(term);
      pty = launchEditorPty(editorCommand(env), path, cols, rows);
    } catch {
      box?.destroyRecursively();
      return null;
    }
    const cmd = editorCommand(env);
    const session: FloatingEditor = {
      box,
      term,
      pty,
      title,
      color,
      name: cmd[0]!.split("/").at(-1) || cmd[0]!,
      cols,
      rows,
    };
    toEditor = (data) => {
      if (floating === session) pty.write(data);
    };
    pty.onData((data) => {
      if (floating === session && !term.isDestroyed) term.write(data);
    });
    try {
      container.add(box);
      term.focus();
    } catch {
      // The box never showed: stop the editor and let the caller fall back.
      pty.kill();
      if (!box.isDestroyed) box.destroyRecursively();
      return null;
    }
    floating = session;
    try {
      draw();
    } catch {
      // The editor runs anyway; the next output or resize redraws.
    }
    return session;
  }

  /** Takes the box down and gives the matrix its keys back. */
  function closeFloating(session: FloatingEditor): void {
    if (floating === session) floating = null;
    try {
      session.term.blur();
    } catch {
      // Blurring only tells the editor it lost focus; it has exited.
    }
    if (!session.box.isDestroyed) {
      container.remove(session.box);
      session.box.destroyRecursively();
    }
  }

  /** `a` (S22): the new task from the editor's file, in `focus`'s quadrant or the Inbox. */
  function createFromFile(focus: Bucket, text: string): { message: string; id: number | null } {
    const parsed = parseNewTask(text);
    if (!parsed.ok) return { message: parsed.cancelled ? "Cancelled" : `${parsed.error} (nothing created)`, id: null };
    const { title, dueDate, description, tags } = parsed.value;
    const task = repo.create({ title, description, dueDate, tags, quadrant: focus === "inbox" ? null : focus });
    return { message: `Added to ${focusLabel(state.preset, focus)}`, id: task.id };
  }

  function saveEdit(task: Task, text: string): string {
    const parsed = parseTaskFile(text);
    if (!parsed.ok) return `${parsed.error} (edit discarded)`;
    const changes = editChanges(task, parsed.value);
    if (changes === null) return "No changes";
    repo.update(task.id, changes);
    return "Saved";
  }

  function onKey(key: KeyEvent): void {
    if (key.eventType === "release") return;
    // S22: while the floating editor is open every key is the editor's, q and Ctrl+C included.
    if (floating) {
      floating.term.handleKeyPress(key);
      key.preventDefault();
      return;
    }
    if (editing !== null) {
      key.preventDefault();
      return;
    }
    const action = keyToAction(state, key, keymap);
    if (action.type === "noop") return;
    key.preventDefault();
    dispatch(action);
  }

  /**
   * S26: the sidebar comes and goes with the width. When it gets hidden the
   * status line says so once and a focused done panel hands the focus back to
   * the pane it was entered from (clamp); it comes back on a wider resize.
   */
  function onResize(): void {
    const wasShown = sidebar !== null;
    build(state);
    state = clamp(state, items());
    if (wasShown && sidebar === null && sidebarWanted(state)) state = { ...state, status: SIDEBAR_HIDDEN };
    layout();
    draw();
  }

  /** Some sidebar panel is on (S25, S27). */
  function sidebarWanted(s: ViewState): boolean {
    return s.preview || s.donePanel;
  }

  renderer.keyInput.on("keypress", onKey);
  renderer.on("resize", onResize);
  load();
  state = offerTriage(state, inboxCount, keymap);
  // S21, S29, S30: a config file or key that could not be used says so, next
  // to the triage offer: the first warning, plus how many more.
  const warning = startWarning([...(options.warning ? [options.warning] : []), ...(options.warnings ?? []), ...keyWarnings]);
  if (warning) state = { ...state, status: state.status ? `${warning} · ${state.status}` : warning };
  // S26: a panel that is on but does not fit says why it is missing.
  if (sidebarWanted(state) && sidebar === null)
    state = { ...state, status: state.status ? `${state.status} · ${SIDEBAR_HIDDEN}` : SIDEBAR_HIDDEN };
  layout();
  draw();

  return {
    done,
    get state() {
      return state;
    },
    idle() {
      return editing ?? Promise.resolve();
    },
    refresh() {
      load();
      state = clamp(syncTriage(state, inbox), items());
      draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // Quitting with the editor open ends it; its session deletes the temp file.
      if (floating) {
        try {
          floating.pty.kill();
        } catch {
          // Already exited.
        }
        closeFloating(floating);
      }
      renderer.keyInput.off("keypress", onKey);
      renderer.off("resize", onResize);
      resolveDone();
      renderer.root.remove(container);
      container.destroyRecursively();
    },
  };
}

const CARD_STYLE: Record<CardLineKind, (text: string) => TextChunk> = {
  title: (text) => fg(COLOR.text)(bold(text)),
  text: (text) => fg(COLOR.text)(text),
  meta: (text) => fg(COLOR.due)(text),
  hint: (text) => fg(COLOR.focus)(text),
  blank: (text) => plain(text),
};

/** A preview line (S25), styled by kind; the label in its bucket's colour. */
function previewChunk(kind: PreviewLineKind, text: string, info: PreviewInfo | null): TextChunk {
  switch (kind) {
    case "title":
      return fg(COLOR.text)(bold(text));
    case "label":
      return fg(info?.bucket === "done" ? DONE_COLOR : BUCKET_COLOR[info?.bucket ?? "inbox"])(bold(text));
    case "due":
      return fg(info?.escalated ? COLOR.escalated : COLOR.due)(text);
    case "tags":
      return fg(COLOR.focus)(text);
    case "text":
      return fg(COLOR.text)(text);
    case "footer":
      return dim(fg(COLOR.muted)(text));
    case "empty":
      return fg(COLOR.muted)(text);
    case "blank":
      return plain(text);
  }
}

/** Settings lines (S21): the cursor's preset stands out, the others are muted. */
function settingsChunk(l: SettingsLine): TextChunk {
  switch (l.kind) {
    case "name":
      return l.selected ? fg(COLOR.focus)(bold(l.text)) : fg(COLOR.text)(l.text);
    case "preview":
      return fg(l.selected ? COLOR.text : COLOR.muted)(l.text);
    case "hint":
      return fg(COLOR.muted)(l.text);
    case "blank":
      return plain(l.text);
  }
}

const helpKeyWidth = (rows: [string, string][]) => Math.max(...rows.map(([k]) => k.length)) + 2;

function helpContentWidth(rows: [string, string][]): number {
  return helpKeyWidth(rows) + Math.max(...rows.map(([, label]) => Bun.stringWidth(label)));
}

function helpContent(rows: [string, string][]): StyledText {
  const keyWidth = helpKeyWidth(rows);
  const chunks: TextChunk[] = [];
  rows.forEach(([k, label], i) => {
    if (i > 0) chunks.push(plain("\n"));
    chunks.push(fg(COLOR.focus)(bold(k.padEnd(keyWidth))), fg(COLOR.text)(label));
  });
  return new StyledText(chunks);
}

/** The end of `text` that fits in `width` columns, with a leading ellipsis if cut. */
function tail(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  let out = "";
  let used = 0;
  for (let i = graphemes.length - 1; i >= 0; i--) {
    const g = graphemes[i]!;
    const w = Bun.stringWidth(g);
    if (used + w > width - 1) break;
    out = g + out;
    used += w;
  }
  return `…${out}`;
}

/** Deletes a temp file; a leftover is not worth an error over the edit's result. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing more to do.
  }
}

function errorMessage(error: unknown): string {
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Runs `$VISUAL`, else `$EDITOR`, else `vi` on `path` with the terminal's
 * stdio, and resolves with its exit code.
 */
export async function spawnEditor(path: string, env: Record<string, string | undefined> = process.env): Promise<number> {
  const proc = Bun.spawn([...editorCommand(env), path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

export interface TuiDeps {
  /** Builds the renderer. Default: a real terminal renderer on the alternate screen. */
  createRenderer?: () => Promise<CliRenderer>;
  /** Where the config file is found (S21). Default: process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Opens the matrix in the terminal and returns once the user quits (S9). The
 * preset comes from the config file and `,` saves it there (S21); a config
 * that cannot be used shows a warning in the status line.
 */
export async function startTui(repo: TaskRepository, options: AppOptions = {}, deps: TuiDeps = {}): Promise<void> {
  const createRenderer =
    deps.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" }));
  const env = deps.env ?? process.env;
  const { config, warning } = loadConfig(env);
  // S30: the key overrides come from the v2 settings; their section's own
  // warnings are added (the file-level ones are loadConfig's, said once).
  const loaded = loadSettings(env);
  options = {
    preset: config.preset,
    warning,
    warnings: loaded.warnings.filter((w) => w.startsWith("Config: keys") || w.startsWith("Config: view")),
    keys: loaded.settings.keys,
    savePreset: (preset) => void saveConfig(env, { preset }),
    // S29: the view toggles start from the file (defaults: done panel off,
    // bullets on) and each toggle saves only its own field.
    view: loaded.settings.view,
    saveView: (patch) => void saveSettings(env, { view: patch }),
    // $EDITOR and EISEN_EDITOR_MODE (S22) come from the same environment.
    env,
    ...options,
  };
  const renderer = await createRenderer();
  // Whatever fails from here on (the first load included), the renderer is
  // torn down before the error propagates: OpenTUI's process handlers would
  // otherwise keep the process alive on the alternate screen.
  try {
    const app = createMatrixApp(renderer, repo, options);
    try {
      await app.done;
    } finally {
      app.destroy();
    }
  } finally {
    renderer.destroy();
    await renderer.closed;
  }
}
