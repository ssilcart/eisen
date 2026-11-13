// The matrix TUI (S9, S10): OpenTUI view + controller. View state and key
// mapping live in state.ts; every change to tasks goes through TaskRepository,
// and the panes are reloaded from it after each effect. `e` hands the terminal
// to $EDITOR (S11); the edit file format lives in edit-file.ts. `i` triages
// the Inbox one card at a time (S12); the card's layout is in triage-card.ts.
// `/` filters every pane live with the domain's search (S19); while it is
// active an Inbox strip under the grid lists the Inbox matches. Pane titles
// and messages use the active quadrant preset (S20), which `,` changes and
// saves (S21); each pane has its colour (S23, theme.ts).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoxRenderable,
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
import { loadConfig, saveConfig } from "../config.ts";
import { getPreset, headingFor, labelFor, type PresetId } from "../domain/presets.ts";
import { QUADRANTS, bucketOf, type Quadrant, type Task } from "../domain/task.ts";
import type { TaskRepository } from "../store/repository.ts";
import { editChanges, editorCommand, parseTaskFile, serializeTask } from "./edit-file.ts";
import { fit, gridSizes, stripHeight, windowStart } from "./layout.ts";
import {
  clamp,
  currentId,
  focusMatches,
  follow,
  initialState,
  keyToAction,
  offerTriage,
  reduce,
  searchActive,
  syncTriage,
  type Action,
  type Focus,
  type PaneItems,
  type ViewState,
} from "./state.ts";
import { settingsHeight, settingsLines, settingsWidth, type SettingsLine } from "./settings.ts";
import { COLOR, paneStyle } from "./theme.ts";
import { cardLines, triageHints, type CardLineKind } from "./triage-card.ts";

export interface AppOptions {
  /** Today as YYYY-MM-DD, for due-date escalation (S7). Default: local date. */
  today?: () => string;
  urgentWithinDays?: number;
  /**
   * Runs the editor on `path` with the terminal and resolves with its exit
   * code. Default: `spawnEditor` ($VISUAL, $EDITOR or vi).
   */
  runEditor?: (path: string) => Promise<number>;
  /** The quadrant labels to start with (S20). Default: classic. */
  preset?: PresetId;
  /** Shown in the status line at start, e.g. a config file that could not be used (S21). */
  warning?: string;
  /**
   * Persists the preset picked in the settings (S21); throwing keeps the
   * previous preset and shows the error. Default: applied for this session only.
   */
  savePreset?: (preset: PresetId) => void;
}

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

const HINTS =
  "h/j/k/l move · 1-4 send · a add · e edit · x done · d delete · / search · J/K order · . done · , settings · ? help · q quit";

/** The help's rows; `1`–`4` name the quadrants with the active preset (S20). */
function helpRows(preset: PresetId): [string, string][] {
  return [
    ["h j k l / arrows", "Move between quadrants and tasks"],
    ...QUADRANTS.map((q): [string, string] => [String(q), `Send to ${labelFor(preset, q)}`]),
    ...HELP_REST,
  ];
}

const HELP_REST: [string, string][] = [
  ["a", "Add a task here (#tags work)"],
  ["x", "Toggle done"],
  ["d", "Delete (y/n)"],
  ["J / K", "Reorder inside the quadrant"],
  [".", "Show / hide done tasks"],
  ["e", "Edit in $EDITOR"],
  ["i", "Triage the Inbox: 1-4 sort, s skip, Esc exit"],
  ["/", "Search every task: type to filter, Enter keep, Esc clear"],
  [",", "Settings: quadrant names"],
  ["?", "Help"],
  ["q", "Quit"],
];

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

/** `Q1 · ✅ Do` or `📥 Inbox`, for messages. */
function focusLabel(preset: PresetId, focus: Focus): string {
  return headingFor(preset, focus);
}

interface Pane {
  box: BoxRenderable;
  text: TextRenderable;
}

/** Builds the matrix on `renderer` (a real one or `createTestRenderer`'s). */
export function createMatrixApp(renderer: CliRenderer, repo: TaskRepository, options: AppOptions = {}): MatrixApp {
  const today = options.today ?? (() => localToday());
  const within = options.urgentWithinDays ?? DEFAULT_URGENT_WITHIN_DAYS;
  const runEditor = options.runEditor ?? ((path: string) => spawnEditor(path));
  const savePreset = options.savePreset ?? (() => {});
  /** The running editor session; keys are ignored while it is set. */
  let editing: Promise<void> | null = null;
  let destroyed = false;

  let state = initialState(options.preset);
  /** Every task, open and done, as last read from the repository. */
  let all: Task[] = [];
  /** Folded fields of `all` for search (S19), built on the first query after a read. */
  let searchIndex: SearchIndex<Task> | null = null;
  let tasks: Record<Quadrant, Task[]> = { 1: [], 2: [], 3: [], 4: [] };
  let openCounts: Record<Quadrant, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let inboxCount = 0;
  /** Open Inbox tasks in display order: the triage queue's source (S12). */
  let inbox: Task[] = [];
  /** What the Inbox strip lists while searching (S19); null when it is hidden. */
  let strip: Task[] | null = null;
  /** Set while a non-blank query filters: matches and totals per pane. */
  let filter: { matches: number; total: Record<Focus, number> } | null = null;
  let currentDay = today();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  // ── View tree ────────────────────────────────────────────────────────────
  const container = new BoxRenderable(renderer, { id: "eisen", flexDirection: "column", width: "100%", height: "100%" });
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
  for (const row of rows) container.add(row);
  container.add(stripBox);
  container.add(status);
  container.add(card);
  container.add(help);
  container.add(settings);
  renderer.root.add(container);

  // ── Data ─────────────────────────────────────────────────────────────────
  /** Reads every task; done ones are needed by `.` and by search (S19). */
  function fetch(): void {
    currentDay = today();
    all = repo.list({ status: "all" });
    searchIndex = null;
  }

  /** Splits `all` into the panes (and the Inbox strip) for view state `s`. */
  function build(s: ViewState): void {
    const searching = searchActive(s);
    let rank: Map<number, number> | null = null;
    if (s.query.trim() !== "") {
      searchIndex ??= prepareSearch(all);
      rank = new Map(search(searchIndex, s.query).map((m, i) => [m.task.id, i]));
    }
    const next: Record<Quadrant, Task[]> = { 1: [], 2: [], 3: [], 4: [] };
    const counts: Record<Quadrant, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const total: Record<Focus, number> = { 1: 0, 2: 0, 3: 0, 4: 0, inbox: 0 };
    const nextInbox: Task[] = [];
    const nextStrip: Task[] = [];
    for (const task of all) {
      const bucket = displayBucket(task, currentDay, within);
      const open = task.status === "open";
      total[bucket]++;
      if (bucket === "inbox" && open) nextInbox.push(task);
      if (bucket !== "inbox" && open) counts[bucket]++;
      // A query shows its matches, done ones included; otherwise `.` decides.
      const shown = rank ? rank.has(task.id) : open || (s.showDone && bucket !== "inbox");
      if (!shown) continue;
      if (bucket === "inbox") {
        if (searching) nextStrip.push(task);
      } else next[bucket].push(task);
    }
    const order = rank
      ? (a: Task, b: Task) => rank.get(a.id)! - rank.get(b.id)!
      : // Open tasks first, done ones after (stable: keeps the repository order).
        (a: Task, b: Task) => Number(a.status === "done") - Number(b.status === "done");
    for (const q of QUADRANTS) next[q].sort(order);
    nextStrip.sort(order);
    tasks = next;
    openCounts = counts;
    inbox = nextInbox;
    inboxCount = nextInbox.length;
    strip = searching ? nextStrip : null;
    filter = rank ? { matches: rank.size, total } : null;
  }

  function load(): void {
    fetch();
    build(state);
  }

  const items = (): PaneItems => (strip ? { ...tasks, inbox: strip } : tasks);

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
  /** Grid sizes and the Inbox strip's height (0 when it is hidden). */
  function sizes() {
    const stripRows = strip ? stripHeight(renderer.height) : 0;
    return { g: gridSizes(renderer.width, renderer.height, stripRows), stripRows };
  }

  function layout(): void {
    const width = renderer.width;
    const height = renderer.height;
    const { g, stripRows } = sizes();
    rows[0]!.height = g.top;
    rows[1]!.height = g.bottom;
    for (const q of QUADRANTS) {
      panes[q].box.width = q % 2 === 1 ? g.left : g.right;
      panes[q].box.height = q <= 2 ? g.top : g.bottom;
    }
    stripBox.visible = stripRows > 0;
    stripBox.width = width;
    stripBox.height = stripRows;
    status.width = width;
    const rowsOfHelp = helpRows(state.preset);
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
    cardLines(task, inner.width, inner.height, triageHints(state.preset)).forEach((l, i) => {
      if (i > 0) chunks.push(plain("\n"));
      chunks.push(CARD_STYLE[l.kind](l.text));
    });
    cardText.content = new StyledText(chunks);
  }

  function draw(): void {
    // The Inbox strip comes and goes with the search: size the grid first.
    layout();
    const { g, stripRows } = sizes();
    for (const q of QUADRANTS) {
      const pane = panes[q];
      const inner = {
        width: Math.max(0, (q % 2 === 1 ? g.left : g.right) - 2),
        height: Math.max(0, (q <= 2 ? g.top : g.bottom) - 2),
      };
      const count = filter ? `${tasks[q].length}/${filter.total[q]}` : `${openCounts[q]}`;
      drawList(pane.box, pane.text, tasks[q], q, inner, paneTitle(state.preset, q, count, inner.width + 2));
    }
    if (strip && stripRows > 0) {
      const inner = { width: Math.max(0, renderer.width - 2), height: Math.max(0, stripRows - 2) };
      const count = filter ? `${strip.length}/${filter.total.inbox}` : `${strip.length}`;
      drawList(stripBox, stripText, strip, "inbox", inner, ` ${labelFor(state.preset, "inbox")} (${count}) `);
    }
    status.content = statusContent(renderer.width);
    drawCard();
    help.visible = state.mode === "help";
    if (help.visible) helpText.content = helpContent(helpRows(state.preset));
    drawSettings();
    renderer.requestRender();
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
    text.content = paneContent(visible, start, inner.width, focused ? selected : -1, style.selectBg);
  }

  function paneContent(visible: Task[], start: number, width: number, selected: number, selectBg: string): StyledText {
    if (visible.length === 0) return new StyledText([fg(COLOR.muted)(fit(filter ? "  No matches" : "  No tasks", width))]);
    const chunks: TextChunk[] = [];
    visible.forEach((task, i) => {
      if (i > 0) chunks.push(plain("\n"));
      chunks.push(...rowChunks(task, width, start + i === selected ? selectBg : null));
    });
    return new StyledText(chunks);
  }

  /** One task row; `selectBg` is the highlight of the selected row (S23), null for the others. */
  function rowChunks(task: Task, width: number, selectBg: string | null): TextChunk[] {
    const isDone = task.status === "done";
    const escalated = isEscalated(task, currentDay, within);
    const mark = isDone ? "✓" : escalated ? "!" : " ";
    const due = task.dueDate && width >= 28 ? ` ${task.dueDate}` : "";
    const titleWidth = Math.max(0, width - 2 - due.length);
    const parts: TextChunk[] = [
      fg(isDone ? COLOR.ok : COLOR.escalated)(bold(`${mark} `.slice(0, Math.min(2, width)))),
      isDone ? dim(fg(COLOR.done)(fit(task.title, titleWidth))) : fg(COLOR.text)(fit(task.title, titleWidth)),
    ];
    if (due) parts.push(fg(escalated ? COLOR.escalated : isDone ? COLOR.done : COLOR.due)(due));
    return selectBg ? parts.map((chunk) => bg(selectBg)(chunk)) : parts;
  }

  /** `2 matches`, `No matches for "q"`, or null when no query filters. */
  function matchesText(): string | null {
    if (!filter) return null;
    if (filter.matches === 0) return `No matches for "${state.query.trim()}"`;
    return `${filter.matches} ${filter.matches === 1 ? "match" : "matches"}`;
  }

  function statusContent(width: number): StyledText {
    const quadrant = focusLabel(state.preset, state.focus);
    switch (state.mode) {
      case "settings":
        return line(width, [fg(COLOR.focus)(bold(" Settings")), fg(COLOR.muted)("  │ j/k choose · Enter save · Esc cancel")]);
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
          bold(` Inbox: ${inboxCount}`),
          fg(COLOR.muted)("  │ "),
          state.status ? fg(COLOR.due)(state.status) : fg(COLOR.muted)(`${where} · ? help`),
        ]);
      }
      case "help":
        return line(width, [bold(` Inbox: ${inboxCount}`), fg(COLOR.muted)("  │ Esc close help")]);
      case "normal": {
        const result = matchesText();
        const hint = result === null ? fg(COLOR.muted)(HINTS) : fg(COLOR.due)(`${result} · / edit · Esc clear · ${HINTS}`);
        return line(width, [
          bold(` Inbox: ${inboxCount}`),
          fg(COLOR.muted)("  │ "),
          state.status ? fg(COLOR.due)(state.status) : hint,
        ]);
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
    if (action.type === "edit" && id !== null) {
      // The editor owns the terminal from here; editTask redraws when it is back.
      state = next;
      editing = editTask(id).finally(() => (editing = null));
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
          if (id !== null) {
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
          const quadrant = before.focus === "inbox" ? null : before.focus;
          const task = repo.create({ title, quadrant, tags: parseTags(title) });
          followId = task.id;
          message = `Added to ${focusLabel(before.preset, before.focus)}`;
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
    state = next; // load() reads showDone from the new state
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
    next = reload(next, !typing);
    state = followId === null ? clamp(next, items()) : follow(next, items(), followId);
    if (typing) state = focusMatches(state, items());
    draw();
  }

  /**
   * S11: write the task to a temp file, hand the terminal to the editor, read
   * the file back and save it if it changed. Never rejects: every outcome ends
   * in the status line. Since OpenTUI 0.6 suspend()/resume() throw while
   * another transition is pending, so keys are ignored until this settles.
   */
  async function editTask(id: number): Promise<void> {
    let message: string;
    let path: string | null = null;
    try {
      const task = repo.get(id);
      if (!task) throw new Error(`Task ${id} not found`);
      path = join(tmpdir(), `eisen-${id}-${crypto.randomUUID().slice(0, 8)}.md`);
      writeFileSync(path, serializeTask(task), { flag: "wx", mode: 0o600 });
      await renderer.suspend();
      let code: number;
      try {
        code = await runEditor(path);
      } finally {
        await renderer.resume();
      }
      message = code === 0 ? saveEdit(task, readFileSync(path, "utf8")) : `Editor exited with code ${code}`;
    } catch (error) {
      message = errorMessage(error);
    } finally {
      if (path !== null) {
        try {
          rmSync(path, { force: true });
        } catch {
          // A leftover temp file is not worth an error over the edit's result.
        }
      }
    }
    if (destroyed) return;
    state = follow(reload({ ...state, status: message }), items(), id);
    try {
      draw();
    } catch {
      // Same as a key handler's draw failing: the next key redraws.
    }
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
    if (editing !== null) {
      key.preventDefault();
      return;
    }
    const action = keyToAction(state, key);
    if (action.type === "noop") return;
    key.preventDefault();
    dispatch(action);
  }

  function onResize(): void {
    layout();
    draw();
  }

  renderer.keyInput.on("keypress", onKey);
  renderer.on("resize", onResize);
  load();
  state = offerTriage(state, inboxCount);
  // S21: a config file that could not be used says so, next to the triage offer.
  if (options.warning) state = { ...state, status: state.status ? `${options.warning} · ${state.status}` : options.warning };
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
      destroyed = true;
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
  options = {
    preset: config.preset,
    warning,
    savePreset: (preset) => void saveConfig(env, { preset }),
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
