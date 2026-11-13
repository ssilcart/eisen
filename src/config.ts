// S21: user settings in a small JSON file, shared by the TUI and the CLI.
// Reading never throws (a bad file means defaults plus a warning); writing is
// atomic (temp file in the same directory, then rename) and keeps keys this
// version does not know.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PRESET, isPresetId, type PresetId } from "./domain/presets.ts";

type Env = Record<string, string | undefined>;

export interface Config {
  preset: PresetId;
}

export const DEFAULT_CONFIG: Readonly<Config> = { preset: DEFAULT_PRESET };

export interface LoadedConfig {
  config: Config;
  /** The file it was read from (or would be). */
  path: string;
  /** Set when the file exists but could not be used; the defaults apply. */
  warning?: string;
}

/** `$EISEN_CONFIG`, else `$XDG_CONFIG_HOME/eisen/config.json`, else `~/.config/eisen/config.json`. */
export function resolveConfigPath(env: Env = process.env): string {
  if (env.EISEN_CONFIG) return env.EISEN_CONFIG;
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(configHome, "eisen", "config.json");
}

type Raw = { ok: true; value: Record<string, unknown> | null } | { ok: false; reason: string };

/** The file's JSON object; `null` when there is no file. */
function readRaw(path: string): Raw {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: null };
    return { ok: false, reason: `cannot read it (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "not a JSON object" };
  return { ok: true, value: value as Record<string, unknown> };
}

/** `~/…` instead of the home directory, for messages. */
function shortPath(path: string, env: Env): string {
  const home = env.HOME || homedir();
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Never throws: a missing file gives the defaults, a bad one the defaults and a warning. */
export function loadConfig(env: Env = process.env): LoadedConfig {
  const path = resolveConfigPath(env);
  const raw = readRaw(path);
  const warn = (reason: string): LoadedConfig => ({
    config: { ...DEFAULT_CONFIG },
    path,
    // The reason first: the status line may cut the end.
    warning: `Config: ${reason}, using defaults (${shortPath(path, env)})`,
  });
  if (!raw.ok) return warn(raw.reason);
  if (raw.value === null || raw.value.preset === undefined) return { config: { ...DEFAULT_CONFIG }, path };
  const preset = raw.value.preset;
  if (!isPresetId(preset)) return warn(`unknown preset ${JSON.stringify(preset)}`);
  return { config: { preset }, path };
}

/**
 * Merges `patch` into the file and writes it atomically, creating its
 * directory. Unknown keys are kept. Throws when the file cannot be read as a
 * JSON object (it is left untouched rather than overwritten) or written.
 */
export function saveConfig(env: Env, patch: Partial<Config>): Config {
  const next = writeMerged(env, (current) => ({ ...current, ...patch }));
  return { preset: isPresetId(next.preset) ? next.preset : DEFAULT_PRESET };
}

/** Reads the file, applies `merge` and writes the result atomically; returns what was written. */
function writeMerged(env: Env, merge: (current: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const path = resolveConfigPath(env);
  const raw = readRaw(path);
  if (!raw.ok) {
    const problem = raw.reason.startsWith("cannot") ? raw.reason : `is not valid JSON (${raw.reason})`;
    throw new Error(`${shortPath(path, env)} ${problem}: fix or delete it, then try again`);
  }
  const next = merge(raw.value ?? {});
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.config.json.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return next;
}

// ── Settings v2 (S29): the whole file, validated field by field ─────────────

export const EDITOR_MODES = ["auto", "command", "form"] as const;
export type EditorMode = (typeof EDITOR_MODES)[number];
export const EDITOR_DISPLAYS = ["floating", "fullscreen"] as const;
export type EditorDisplay = (typeof EDITOR_DISPLAYS)[number];

export interface ViewSettings {
  /** The preview panel in the sidebar (S25). */
  preview: boolean;
  /** The completed-tasks panel in the sidebar (S27). */
  donePanel: boolean;
  /** `•` at the start of open rows (S28). */
  bullets: boolean;
}

export interface EditorSettings {
  /** `auto`: $VISUAL/$EDITOR/vi; `command`: `command`; `form`: the native form (S32). */
  mode: EditorMode;
  /** The command line for `command` mode (split on whitespace). */
  command: string;
  /** Floating box (S22) or the whole terminal (S11), for auto and command. */
  display: EditorDisplay;
}

export interface Settings {
  preset: PresetId;
  view: ViewSettings;
  editor: EditorSettings;
  /**
   * Overrides of the default keys, by action id (S30): each list replaces
   * that action's keys. Checked against the actions by the keymap, not here.
   */
  keys: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  preset: DEFAULT_PRESET,
  view: Object.freeze({ preview: true, donePanel: false, bullets: true }),
  editor: Object.freeze({ mode: "auto" as EditorMode, command: "nvim", display: "floating" as EditorDisplay }),
  keys: Object.freeze({}) as Record<string, string[]>,
});

export interface LoadedSettings {
  settings: Settings;
  path: string;
  /** One message per field that could not be used (its default applies). */
  warnings: string[];
}

/** A change to save: sections merge field by field; a `null` key list removes that override. */
export interface SettingsPatch {
  preset?: PresetId;
  view?: Partial<ViewSettings>;
  editor?: Partial<EditorSettings>;
  keys?: Record<string, string[] | null>;
}

function defaults(): Settings {
  return {
    preset: DEFAULT_SETTINGS.preset,
    view: { ...DEFAULT_SETTINGS.view },
    editor: { ...DEFAULT_SETTINGS.editor },
    keys: {},
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates a parsed file field by field; never throws. */
function parseSettings(value: Record<string, unknown>): { settings: Settings; warnings: string[] } {
  const settings = defaults();
  const warnings: string[] = [];
  const warn = (text: string) => warnings.push(`Config: ${text}`);

  if (value.preset !== undefined) {
    if (isPresetId(value.preset)) settings.preset = value.preset;
    else warn(`preset ${JSON.stringify(value.preset)} unknown, using "${DEFAULT_PRESET}"`);
  }

  const section = (name: "view" | "editor" | "keys"): Record<string, unknown> | null => {
    const raw = value[name];
    if (raw === undefined) return null;
    if (isObject(raw)) return raw;
    warn(`${name} is not an object, using the defaults`);
    return null;
  };

  const view = section("view");
  if (view) {
    for (const field of ["preview", "donePanel", "bullets"] as const) {
      const v = view[field];
      if (v === undefined) continue;
      if (typeof v === "boolean") settings.view[field] = v;
      else warn(`view.${field} ${JSON.stringify(v)} is not true/false, using ${settings.view[field]}`);
    }
  }

  const editor = section("editor");
  if (editor) {
    const { mode, command, display } = editor;
    if (mode !== undefined) {
      if ((EDITOR_MODES as readonly unknown[]).includes(mode)) settings.editor.mode = mode as EditorMode;
      else warn(`editor.mode ${JSON.stringify(mode)} unknown, using "${settings.editor.mode}"`);
    }
    if (command !== undefined) {
      if (typeof command === "string" && command.trim() !== "") settings.editor.command = command.trim();
      else warn(`editor.command ${JSON.stringify(command)} is not a command, using "${settings.editor.command}"`);
    }
    if (display !== undefined) {
      if ((EDITOR_DISPLAYS as readonly unknown[]).includes(display)) settings.editor.display = display as EditorDisplay;
      else warn(`editor.display ${JSON.stringify(display)} unknown, using "${settings.editor.display}"`);
    }
  }

  const keys = section("keys");
  if (keys) {
    for (const [action, list] of Object.entries(keys)) {
      if (Array.isArray(list) && list.every((k) => typeof k === "string")) settings.keys[action] = [...list];
      else warn(`keys.${action} is not a list of keys, ignored`);
    }
  }
  return { settings, warnings };
}

/** Never throws: a missing file gives the defaults, a bad field its default plus a warning. */
export function loadSettings(env: Env = process.env): LoadedSettings {
  const path = resolveConfigPath(env);
  const raw = readRaw(path);
  if (!raw.ok) return { settings: defaults(), path, warnings: [`Config: ${raw.reason}, using defaults (${shortPath(path, env)})`] };
  if (raw.value === null) return { settings: defaults(), path, warnings: [] };
  return { ...parseSettings(raw.value), path };
}

/**
 * Deep-merges `patch` into the file (S29): each section field by field,
 * unknown keys kept at every level, atomic write. Returns the settings a
 * fresh load would read. Throws like `saveConfig`.
 */
export function saveSettings(env: Env, patch: SettingsPatch): Settings {
  const next = writeMerged(env, (current) => {
    const out: Record<string, unknown> = { ...current };
    if (patch.preset !== undefined) out.preset = patch.preset;
    for (const name of ["view", "editor"] as const) {
      const p = patch[name];
      if (p === undefined) continue;
      out[name] = { ...(isObject(current[name]) ? current[name] : {}), ...p };
    }
    if (patch.keys !== undefined) {
      const keys: Record<string, unknown> = { ...(isObject(current.keys) ? current.keys : {}) };
      for (const [action, list] of Object.entries(patch.keys)) {
        if (list === null) delete keys[action];
        else keys[action] = [...list];
      }
      out.keys = keys;
    }
    return out;
  });
  return parseSettings(next).settings;
}
