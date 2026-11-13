// Rebindable keys (S30): every matrix and triage action with its default keys,
// key strings (parse/format), OpenTUI key events → key strings, and the
// keymap built from the config file's overrides. Pure: no @opentui, no
// bun:sqlite. Text-input modes (add, search, settings, …) never use it.

export type Scope = "normal" | "triage";

export interface ActionDef {
  /** snake_case, unique inside its scope. */
  readonly id: string;
  readonly scope: Scope;
  /** The name in `config.json` `keys`: the id, or `triage.<id>` for triage. */
  readonly name: string;
  /** English label for the settings list and messages. */
  readonly label: string;
  /** Today's keys, as canonical key strings. */
  readonly defaults: readonly string[];
}

function def(scope: Scope, id: string, label: string, defaults: string[]): ActionDef {
  return { id, scope, name: scope === "normal" ? id : `triage.${id}`, label, defaults };
}

export const ACTIONS: readonly ActionDef[] = [
  def("normal", "move_left", "Move left", ["h", "left"]),
  def("normal", "move_down", "Move down", ["j", "down"]),
  def("normal", "move_up", "Move up", ["k", "up"]),
  def("normal", "move_right", "Move right", ["l", "right"]),
  def("normal", "send_q1", "Send to Q1", ["1"]),
  def("normal", "send_q2", "Send to Q2", ["2"]),
  def("normal", "send_q3", "Send to Q3", ["3"]),
  def("normal", "send_q4", "Send to Q4", ["4"]),
  def("normal", "new_task", "New task", ["a"]),
  def("normal", "quick_add", "Quick add", ["A"]),
  def("normal", "edit", "Edit", ["e"]),
  def("normal", "toggle_done", "Toggle done", ["x"]),
  def("normal", "delete", "Delete", ["d"]),
  def("normal", "order_down", "Move down in the order", ["J"]),
  def("normal", "order_up", "Move up in the order", ["K"]),
  def("normal", "search", "Search", ["/"]),
  def("normal", "triage", "Triage the Inbox", ["i"]),
  def("normal", "toggle_done_panel", "Done panel", ["."]),
  def("normal", "toggle_preview", "Preview panel", ["p"]),
  def("normal", "toggle_bullets", "Bullets", []),
  def("normal", "preview_down", "Scroll the preview down", ["ctrl+d"]),
  def("normal", "preview_up", "Scroll the preview up", ["ctrl+u"]),
  def("normal", "command_line", "Command line", [":"]),
  def("normal", "settings", "Settings", [","]),
  def("normal", "help", "Help", ["?"]),
  def("normal", "quit", "Quit", ["q"]),
  def("triage", "send_q1", "Send to Q1", ["1"]),
  def("triage", "send_q2", "Send to Q2", ["2"]),
  def("triage", "send_q3", "Send to Q3", ["3"]),
  def("triage", "send_q4", "Send to Q4", ["4"]),
  def("triage", "skip", "Skip", ["s"]),
  def("triage", "edit", "Edit", ["e"]),
  def("triage", "delete", "Delete", ["d"]),
  def("triage", "help", "Help", ["?"]),
  def("triage", "exit_triage", "Exit triage", ["q"]),
];

/** Matrix actions that always keep at least one key (S30). */
export const GUARDED_ACTIONS: ReadonlySet<string> = new Set(["quit", "help", "settings", "command_line"]);

const BY_NAME: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((a) => [a.name, a]));

function findAction(scope: Scope, id: string): ActionDef | undefined {
  return BY_NAME.get(scope === "normal" ? id : `triage.${id}`);
}

// ── Key strings ─────────────────────────────────────────────────────────────

/** A key: an optional ctrl/alt and a base (one character or a key name). */
export interface KeyCombo {
  ctrl: boolean;
  alt: boolean;
  base: string;
}

const NAMES: ReadonlySet<string> = new Set([
  "space", "tab", "up", "down", "left", "right", "pageup", "pagedown", "home", "end",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** Names of the keys the app keeps for itself (Esc, Enter, Backspace). */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["esc", "escape", "enter", "return", "backspace"]);

const isLetter = (ch: string) => ch.toLowerCase() !== ch.toUpperCase();

/** One printable character, not a space or a control character. */
function isChar(s: string): boolean {
  return Array.from(s).length === 1 && !/[\p{Cc}\p{Z}]/u.test(s);
}

function splitPrefixes(raw: string): { ctrl: boolean; alt: boolean; rest: string } {
  let ctrl = false;
  let alt = false;
  let rest = raw;
  for (;;) {
    const lower = rest.toLowerCase();
    if (!ctrl && lower.startsWith("ctrl+") && rest.length > 5) {
      ctrl = true;
      rest = rest.slice(5);
    } else if (!alt && lower.startsWith("alt+") && rest.length > 4) {
      alt = true;
      rest = rest.slice(4);
    } else return { ctrl, alt, rest };
  }
}

/**
 * `a`, `A` (shift+a), `?`, `space`, `f1`, `ctrl+d`, `alt+x`… → a combo, or
 * null when it is not a key. Prefixes and names ignore case; a letter keeps
 * its case except under ctrl (terminals cannot tell ctrl+D from ctrl+d).
 */
export function parseKey(raw: string): KeyCombo | null {
  if (typeof raw !== "string") return null;
  const { ctrl, alt, rest } = splitPrefixes(raw);
  if (isChar(rest)) return { ctrl, alt, base: ctrl && isLetter(rest) ? rest.toLowerCase() : rest };
  const name = rest.toLowerCase();
  return NAMES.has(name) ? { ctrl, alt, base: name } : null;
}

/** The canonical key string: `ctrl+alt+x`, `A`, `space`. */
export function formatKey(combo: KeyCombo): string {
  return `${combo.ctrl ? "ctrl+" : ""}${combo.alt ? "alt+" : ""}${combo.base}`;
}

export type KeyCheck = { ok: true; key: string } | { ok: false; reason: string };

/** A key string from a config file or the settings, canonical, or why it cannot be bound. */
export function checkKey(raw: unknown): KeyCheck {
  if (typeof raw !== "string") return { ok: false, reason: "is not a key" };
  const { rest } = splitPrefixes(raw);
  if (RESERVED_NAMES.has(rest.toLowerCase())) return { ok: false, reason: "can't be bound" };
  const combo = parseKey(raw);
  if (!combo) return { ok: false, reason: "is not a key" };
  const key = formatKey(combo);
  return key === "ctrl+c" ? { ok: false, reason: "can't be bound" } : { ok: true, key };
}

/** The fields of an OpenTUI key event the keymap reads (L11). */
export interface KeyEventLike {
  name: string;
  sequence: string;
  shift: boolean;
  ctrl: boolean;
  meta?: boolean;
  option?: boolean;
}

/**
 * The canonical key string of an event, or null when no binding can match
 * it (shift with a named key: shift+tab, shift+up). `J` arrives as name `j`
 * with shift (or only its sequence says so); symbols arrive with name = the
 * character, so their shift is ignored.
 */
export function eventKey(event: KeyEventLike): string | null {
  const ctrl = event.ctrl;
  const alt = Boolean(event.meta || event.option);
  let base = event.name;
  if (!base) return null;
  if (Array.from(base).length === 1) {
    if (isLetter(base)) {
      const upper = base.toUpperCase();
      const shifted = event.shift || base === upper || event.sequence === upper;
      base = shifted && !ctrl ? upper : base.toLowerCase();
    }
  } else if (event.shift) return null;
  return formatKey({ ctrl, alt, base });
}

// ── The keymap ──────────────────────────────────────────────────────────────

export interface Keymap {
  /** Keys per action name (`toggle_done`, `triage.skip`), in display order. */
  readonly keys: ReadonlyMap<string, readonly string[]>;
  /** Key string → action id, per scope. */
  readonly lookup: Readonly<Record<Scope, ReadonlyMap<string, string>>>;
}

function fromKeys(keys: ReadonlyMap<string, readonly string[]>): Keymap {
  const lookup: Record<Scope, Map<string, string>> = { normal: new Map(), triage: new Map() };
  for (const action of ACTIONS) {
    for (const key of keys.get(action.name) ?? []) {
      if (!lookup[action.scope].has(key)) lookup[action.scope].set(key, action.id);
    }
  }
  return { keys, lookup };
}

export const DEFAULT_KEYMAP: Keymap = fromKeys(new Map(ACTIONS.map((a) => [a.name, a.defaults])));

/** A config value for a message: quoted and capped (L29d). */
function quote(text: string): string {
  return JSON.stringify(text.length > 24 ? `${text.slice(0, 24)}…` : text);
}

function shortName(name: string): string {
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

/**
 * The keymap for `overrides` (the config's `keys`): each override replaces
 * that action's keys. An unknown action, a bad list, an invalid or
 * never-bindable key, an empty list on a guarded action, or a key another
 * action of the same scope keeps → that override is ignored, with one
 * warning. Only own properties are read (L29a).
 */
export function buildKeymap(overrides: Readonly<Record<string, unknown>> | undefined): { keymap: Keymap; warnings: string[] } {
  const warnings: string[] = [];
  const accepted = new Map<string, string[]>();
  for (const name of overrides ? Object.keys(overrides) : []) {
    if (!Object.hasOwn(overrides!, name)) continue;
    const field = `Config: keys.${shortName(name)}`;
    const action = BY_NAME.get(name);
    if (!action) {
      warnings.push(`${field} is not an action, ignored`);
      continue;
    }
    const value: unknown = overrides![name];
    if (!Array.isArray(value)) {
      warnings.push(`${field} is not a list of keys, ignored`);
      continue;
    }
    const keys: string[] = [];
    let problem: string | null = null;
    for (const raw of value) {
      const check = checkKey(raw);
      if (!check.ok) {
        problem = `${typeof raw === "string" ? quote(raw) : "a value"} ${check.reason}`;
        break;
      }
      if (!keys.includes(check.key)) keys.push(check.key);
    }
    if (problem) warnings.push(`${field} ${problem}, ignored`);
    else if (keys.length === 0 && action.scope === "normal" && GUARDED_ACTIONS.has(action.id))
      warnings.push(`${field} needs at least one key, ignored`);
    else accepted.set(name, keys);
  }

  // Conflicts: an override sharing a key with another action of its scope is
  // dropped; dropping one restores its defaults, which may clash again.
  for (;;) {
    const owners = new Map<string, ActionDef[]>();
    for (const action of ACTIONS) {
      for (const key of accepted.get(action.name) ?? action.defaults) {
        const slot = `${action.scope} ${key}`;
        owners.set(slot, [...(owners.get(slot) ?? []), action]);
      }
    }
    const dropped = new Map<string, string>();
    for (const [slot, actions] of owners) {
      if (actions.length < 2) continue;
      const key = slot.slice(slot.indexOf(" ") + 1);
      for (const action of actions) {
        if (!accepted.has(action.name) || dropped.has(action.name)) continue;
        const other = actions.find((a) => a !== action)!;
        dropped.set(action.name, `Config: keys.${action.name} ${quote(key)} is already ${other.label}, ignored`);
      }
    }
    if (dropped.size === 0) break;
    for (const [name, message] of dropped) {
      accepted.delete(name);
      warnings.push(message);
    }
  }

  const keys = new Map(ACTIONS.map((a) => [a.name, accepted.get(a.name) ?? a.defaults]));
  return { keymap: fromKeys(keys), warnings };
}

/** The action id `event` triggers in `scope`, or null. */
export function actionFor(keymap: Keymap, scope: Scope, event: KeyEventLike): string | null {
  const key = eventKey(event);
  return key === null ? null : (keymap.lookup[scope].get(key) ?? null);
}

/** The keys of an action, for help, hints and the settings list ([] when unbound or unknown). */
export function keysOf(keymap: Keymap, scope: Scope, id: string): readonly string[] {
  const action = findAction(scope, id);
  return action ? (keymap.keys.get(action.name) ?? []) : [];
}

/** The action of `scope` that holds `key`, other than `except`; null when free. */
export function conflictFor(keymap: Keymap, scope: Scope, key: string, except?: string): string | null {
  const owner = keymap.lookup[scope].get(key);
  return owner === undefined || owner === except ? null : owner;
}

/** A copy of `keymap` with the action's keys replaced (checks are the caller's: `checkKey`, `conflictFor`). */
export function withKeys(keymap: Keymap, scope: Scope, id: string, keys: readonly string[]): Keymap {
  const action = findAction(scope, id);
  if (!action) return keymap;
  return fromKeys(new Map([...keymap.keys, [action.name, [...keys]]]));
}
