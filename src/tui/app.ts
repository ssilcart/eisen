// The matrix TUI (S9, S10): OpenTUI view + controller. View state and key
// mapping live in state.ts; every change to tasks goes through TaskRepository,
// and the panes are reloaded from it after each effect. `e` hands the terminal
// to $EDITOR (S11); the edit file format lives in edit-file.ts. `i` triages
// the Inbox one card at a time (S12); the card's layout is in triage-card.ts.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoxRenderable,
  StyledText,
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
import { parseTags } from "../domain/tags.ts";
import { QUADRANTS, QUADRANT_LABELS, bucketOf, type Quadrant, type Task } from "../domain/task.ts";
import type { TaskRepository } from "../store/repository.ts";
import { editChanges, editorCommand, parseTaskFile, serializeTask } from "./edit-file.ts";
import { fit, gridSizes, windowStart } from "./layout.ts";
import {
  clamp,
  currentId,
  follow,
  initialState,
  keyToAction,
  offerTriage,
  reduce,
  syncTriage,
  type Action,
  type PaneItems,
  type ViewState,
} from "./state.ts";
import { cardLines, type CardLineKind } from "./triage-card.ts";

export interface AppOptions {
  /** Today as YYYY-MM-DD, for due-date escalation (S7). Default: local date. */
  today?: () => string;
  urgentWithinDays?: number;
  /**
   * Runs the editor on `path` with the terminal and resolves with its exit
   * code. Default: `spawnEditor` ($VISUAL, $EDITOR or vi).
   */
  runEditor?: (path: string) => Promise<number>;
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

const COLOR = {
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
};

const HINTS = "h/j/k/l move · 1-4 send · a add · e edit · x done · d delete · J/K order · . done · ? help · q quit";

const HELP: [string, string][] = [
  ["h j k l / arrows", "Move between quadrants and tasks"],
  ["1 – 4", "Move the selected task to that quadrant"],
  ["a", "Add a task here (#tags work)"],
  ["x", "Toggle done"],
  ["d", "Delete (y/n)"],
  ["J / K", "Reorder inside the quadrant"],
  [".", "Show / hide done tasks"],
  ["e", "Edit in $EDITOR"],
  ["i", "Triage the Inbox: 1-4 sort, s skip, Esc exit"],
  ["/", "Search (coming soon)"],
  ["?", "Help"],
  ["q", "Quit"],
];

const plain = (text: string): TextChunk => ({ __isChunk: true, text });

/** `Q1 · Do (n)`, or `Q1 (n)` when the pane is too narrow for the label. */
function paneTitle(q: Quadrant, open: number, paneWidth = Infinity): string {
  const full = ` Q${q} · ${QUADRANT_LABELS[q]} (${open}) `;
  return Bun.stringWidth(full) + 4 <= paneWidth ? full : ` Q${q} (${open}) `;
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
  /** The running editor session; keys are ignored while it is set. */
  let editing: Promise<void> | null = null;
  let destroyed = false;

  let state = initialState();
  let tasks: Record<Quadrant, Task[]> = { 1: [], 2: [], 3: [], 4: [] };
  let openCounts: Record<Quadrant, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let inboxCount = 0;
  /** Open Inbox tasks in display order: the triage queue's source (S12). */
  let inbox: Task[] = [];
  let currentDay = today();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  // ── View tree ────────────────────────────────────────────────────────────
  const container = new BoxRenderable(renderer, { id: "eisen", flexDirection: "column", width: "100%", height: "100%" });
  const rows = [0, 1].map(
    (i) => new BoxRenderable(renderer, { id: `eisen-row-${i}`, flexDirection: "row", flexShrink: 0 }),
  );
  const panes = {} as Record<Quadrant, Pane>;
  for (const q of QUADRANTS) {
    const box = new BoxRenderable(renderer, {
      id: `eisen-q${q}`,
      border: true,
      borderStyle: "rounded",
      borderColor: COLOR.border,
      titleColor: COLOR.title,
      title: paneTitle(q, 0),
      flexShrink: 0,
      overflow: "hidden",
    });
    const text = new TextRenderable(renderer, { id: `eisen-q${q}-list`, content: "", wrapMode: "none", fg: COLOR.text });
    box.add(text);
    rows[q <= 2 ? 0 : 1]!.add(box);
    panes[q] = { box, text };
  }
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
  const helpText = new TextRenderable(renderer, { id: "eisen-help-text", content: helpContent(), wrapMode: "none" });
  help.add(helpText);
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
  container.add(status);
  container.add(card);
  container.add(help);
  renderer.root.add(container);

  // ── Data ─────────────────────────────────────────────────────────────────
  function load(): void {
    currentDay = today();
    const all = repo.list({ status: state.showDone ? "all" : "open" });
    const next: Record<Quadrant, Task[]> = { 1: [], 2: [], 3: [], 4: [] };
    const counts: Record<Quadrant, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const nextInbox: Task[] = [];
    for (const task of all) {
      const bucket = displayBucket(task, currentDay, within);
      if (bucket === "inbox") {
        if (task.status === "open") nextInbox.push(task);
        continue;
      }
      next[bucket].push(task);
      if (task.status === "open") counts[bucket]++;
    }
    // Open tasks first, done ones after (stable: keeps the repository order).
    for (const q of QUADRANTS) next[q].sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
    tasks = next;
    openCounts = counts;
    inbox = nextInbox;
    inboxCount = nextInbox.length;
  }

  const items = (): PaneItems => tasks;

  function taskById(id: number | null): Task | undefined {
    if (id === null) return undefined;
    return inbox.find((t) => t.id === id) ?? QUADRANTS.map((q) => tasks[q].find((t) => t.id === id)).find(Boolean);
  }

  /** Reload, then drop triage cards whose task left the Inbox meanwhile. */
  function reload(next: ViewState): ViewState {
    try {
      load();
    } catch (error) {
      // Keep the last loaded tasks on screen and say why they may be stale.
      next = { ...next, status: errorMessage(error) };
    }
    return syncTriage(next, inbox);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  function layout(): void {
    const width = renderer.width;
    const height = renderer.height;
    const g = gridSizes(width, height);
    rows[0]!.height = g.top;
    rows[1]!.height = g.bottom;
    for (const q of QUADRANTS) {
      panes[q].box.width = q % 2 === 1 ? g.left : g.right;
      panes[q].box.height = q <= 2 ? g.top : g.bottom;
    }
    status.width = width;
    const helpWidth = Math.min(helpContentWidth() + 4, Math.max(0, width - 4));
    const helpHeight = Math.min(HELP.length + 2, Math.max(0, height - 2));
    help.width = helpWidth;
    help.height = helpHeight;
    help.left = Math.max(0, Math.floor((width - helpWidth) / 2));
    help.top = Math.max(0, Math.floor((height - 1 - helpHeight) / 2));
    card.left = 0;
    card.top = 0;
    card.width = width;
    card.height = Math.max(0, height - 1);
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
    cardLines(task, inner.width, inner.height).forEach((l, i) => {
      if (i > 0) chunks.push(plain("\n"));
      chunks.push(CARD_STYLE[l.kind](l.text));
    });
    cardText.content = new StyledText(chunks);
  }

  function draw(): void {
    const g = gridSizes(renderer.width, renderer.height);
    for (const q of QUADRANTS) {
      const pane = panes[q];
      const focused = state.focus === q;
      const inner = {
        width: Math.max(0, (q % 2 === 1 ? g.left : g.right) - 2),
        height: Math.max(0, (q <= 2 ? g.top : g.bottom) - 2),
      };
      pane.box.title = paneTitle(q, openCounts[q], inner.width + 2);
      pane.box.borderColor = focused ? COLOR.focus : COLOR.border;
      pane.box.titleColor = focused ? COLOR.focus : COLOR.title;
      const list = tasks[q];
      const start = windowStart(state.selected[q], list.length, inner.height);
      const visible = list.slice(start, start + inner.height);
      pane.box.bottomTitle =
        list.length > inner.height && inner.height > 0
          ? ` ${start + 1}-${start + visible.length} of ${list.length} `
          : undefined;
      pane.box.bottomTitleAlignment = "right";
      pane.text.content = paneContent(visible, start, inner.width, focused ? state.selected[q] : -1);
    }
    status.content = statusContent(renderer.width);
    drawCard();
    help.visible = state.mode === "help";
    renderer.requestRender();
  }

  function paneContent(visible: Task[], start: number, width: number, selected: number): StyledText {
    if (visible.length === 0) return new StyledText([fg(COLOR.muted)(fit("  No tasks", width))]);
    const chunks: TextChunk[] = [];
    visible.forEach((task, i) => {
      if (i > 0) chunks.push(plain("\n"));
      chunks.push(...rowChunks(task, width, start + i === selected));
    });
    return new StyledText(chunks);
  }

  function rowChunks(task: Task, width: number, selected: boolean): TextChunk[] {
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
    return selected ? parts.map((chunk) => bg(COLOR.selectBg)(chunk)) : parts;
  }

  function statusContent(width: number): StyledText {
    const quadrant = `Q${state.focus} · ${QUADRANT_LABELS[state.focus]}`;
    switch (state.mode) {
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
      case "normal":
        return line(width, [
          bold(` Inbox: ${inboxCount}`),
          fg(COLOR.muted)("  │ "),
          state.status ? fg(COLOR.due)(state.status) : fg(COLOR.muted)(HINTS),
        ]);
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
          const label = `Q${action.quadrant} · ${QUADRANT_LABELS[action.quadrant]}`;
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
          const task = repo.create({ title, quadrant: before.focus, tags: parseTags(title) });
          followId = task.id;
          message = `Added to Q${before.focus} · ${QUADRANT_LABELS[before.focus]}`;
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
    // The end-of-triage summary wins over the last move's message, not over an error.
    if (message !== null && (failed || next.status === null)) next = { ...next, status: message };
    state = next; // load() reads showDone from the new state
    // Quitting never depends on the repository: a failing reload must not
    // keep the user in the alternate screen.
    if (state.quit) {
      resolveDone();
      return;
    }
    next = reload(next);
    state = followId === null ? clamp(next, items()) : follow(next, items(), followId);
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

const HELP_KEY_WIDTH = Math.max(...HELP.map(([k]) => k.length)) + 2;

function helpContentWidth(): number {
  return HELP_KEY_WIDTH + Math.max(...HELP.map(([, label]) => Bun.stringWidth(label)));
}

function helpContent(): StyledText {
  const keyWidth = HELP_KEY_WIDTH;
  const chunks: TextChunk[] = [];
  HELP.forEach(([k, label], i) => {
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

/** Opens the matrix in the terminal and returns once the user quits (S9). */
export interface TuiDeps {
  /** Builds the renderer. Default: a real terminal renderer on the alternate screen. */
  createRenderer?: () => Promise<CliRenderer>;
}

export async function startTui(repo: TaskRepository, options: AppOptions = {}, deps: TuiDeps = {}): Promise<void> {
  const createRenderer =
    deps.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" }));
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
