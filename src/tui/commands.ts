// The `:` command line (S31): parsing, Tab completion and history, all pure.
// No @opentui here; the reducer in state.ts keeps the line and the controller
// in app.ts runs what a parsed command asks for.

/** The view toggles a command can set, by their ViewState / config field. */
export type ViewToggle = "preview" | "donePanel" | "bullets";

export type Command =
  /** No `value`: flip it. `value`: set it (the key is absent, never `undefined`). */
  | { kind: "toggle"; view: ViewToggle; value?: boolean }
  | { kind: "settings" }
  | { kind: "help" }
  | { kind: "triage" }
  | { kind: "search"; query: string }
  | { kind: "add"; title: string }
  | { kind: "quit" };

/** `command: null` is an empty line: nothing to run, nothing to report. */
export type ParseResult = { ok: true; command: Command | null } | { ok: false; error: string };

type Spec =
  | { arg: "toggle"; view: ViewToggle }
  | { arg: "none"; command: Command }
  | { arg: "text"; usage: string; make: (text: string) => Command };

const TOGGLE_ARGS = ["on", "off"] as const;

const SPECS: Readonly<Record<string, Spec>> = {
  preview: { arg: "toggle", view: "preview" },
  done: { arg: "toggle", view: "donePanel" },
  bullets: { arg: "toggle", view: "bullets" },
  settings: { arg: "none", command: { kind: "settings" } },
  help: { arg: "none", command: { kind: "help" } },
  triage: { arg: "none", command: { kind: "triage" } },
  search: { arg: "text", usage: "<query>", make: (query) => ({ kind: "search", query }) },
  add: { arg: "text", usage: "<title>", make: (title) => ({ kind: "add", title }) },
  quit: { arg: "none", command: { kind: "quit" } },
  q: { arg: "none", command: { kind: "quit" } },
};

/** The names Tab offers, in this order; the `q` alias is left out. */
export const COMMAND_NAMES: readonly string[] = ["preview", "done", "bullets", "settings", "help", "triage", "search", "add", "quit"];

/** `name` and the rest of the line (trimmed at both ends, inner spaces kept). */
function split(line: string): { name: string; rest: string; spaced: boolean } {
  const text = line.trimStart();
  const at = text.search(/\s/);
  if (at < 0) return { name: text, rest: "", spaced: false };
  return { name: text.slice(0, at), rest: text.slice(at).trim(), spaced: true };
}

function usage(name: string, spec: Spec): string {
  switch (spec.arg) {
    case "toggle":
      return `Usage: :${name} [on|off]`;
    case "none":
      return `Usage: :${name}`;
    case "text":
      return `Usage: :${name} ${spec.usage}`;
  }
}

/**
 * The command on a `:` line (without the `:`). Names are exact and
 * case-sensitive (Tab completes them); `:q` is `:quit`.
 */
export function parseCommand(line: string): ParseResult {
  const { name, rest } = split(line);
  if (name === "") return { ok: true, command: null };
  if (!Object.hasOwn(SPECS, name)) return { ok: false, error: `Unknown command: ${name}` };
  const spec = SPECS[name]!;
  switch (spec.arg) {
    case "toggle":
      if (rest === "") return { ok: true, command: { kind: "toggle", view: spec.view } };
      if (rest === "on" || rest === "off") return { ok: true, command: { kind: "toggle", view: spec.view, value: rest === "on" } };
      return { ok: false, error: usage(name, spec) };
    case "none":
      return rest === "" ? { ok: true, command: spec.command } : { ok: false, error: usage(name, spec) };
    case "text":
      return rest === "" ? { ok: false, error: usage(name, spec) } : { ok: true, command: spec.make(rest) };
  }
}

/** A Tab cycle in progress: the full lines it offers and the one shown. */
export interface Completion {
  candidates: readonly string[];
  index: number;
}

/**
 * Tab on `line`. When `line` is still the candidate `previous` put there,
 * the next candidate replaces it (wrapping). Otherwise: no space yet →
 * the command names starting with it (a space after those that take an
 * argument); `name …` → that toggle's `on`/`off` starting with the argument.
 * One candidate ends the cycle, so the next Tab goes on to the argument.
 */
export function completeCommand(line: string, previous: Completion | null): { line: string; completion: Completion | null } {
  if (previous && previous.candidates[previous.index] === line) {
    const index = (previous.index + 1) % previous.candidates.length;
    return { line: previous.candidates[index]!, completion: { candidates: previous.candidates, index } };
  }
  const candidates = candidatesFor(line);
  if (candidates.length === 0) return { line, completion: null };
  return { line: candidates[0]!, completion: candidates.length > 1 ? { candidates, index: 0 } : null };
}

function candidatesFor(line: string): string[] {
  const { name, rest, spaced } = split(line);
  if (!spaced) {
    return COMMAND_NAMES.filter((n) => n.startsWith(name)).map((n) => (SPECS[n]!.arg === "none" ? n : `${n} `));
  }
  const spec = Object.hasOwn(SPECS, name) ? SPECS[name]! : null;
  if (spec?.arg !== "toggle") return [];
  return TOGGLE_ARGS.filter((a) => a.startsWith(rest)).map((a) => `${name} ${a}`);
}

/** The history after running `line`: blank lines and an immediate repeat are not kept. */
export function pushHistory(history: readonly string[], line: string): readonly string[] {
  const entry = line.trim();
  if (entry === "" || history.at(-1) === entry) return history;
  return [...history, entry];
}

/** Where ↑/↓ are in the history; `draft` is the line typed before the first ↑. */
export interface HistoryCursor {
  index: number;
  draft: string;
}

/**
 * ↑ (`dir` -1) recalls older lines and stops at the oldest; ↓ (+1) newer ones,
 * then the draft again. `cursor` null: not walking.
 */
export function walkHistory(
  history: readonly string[],
  cursor: HistoryCursor | null,
  line: string,
  dir: -1 | 1,
): { line: string; cursor: HistoryCursor | null } {
  if (cursor === null) {
    if (dir === 1 || history.length === 0) return { line, cursor: null };
    const index = history.length - 1;
    return { line: history[index]!, cursor: { index, draft: line } };
  }
  const index = cursor.index + dir;
  if (index >= history.length) return { line: cursor.draft, cursor: null };
  const clamped = Math.max(0, index);
  return { line: history[clamped]!, cursor: { index: clamped, draft: cursor.draft } };
}
