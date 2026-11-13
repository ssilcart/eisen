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
  const path = resolveConfigPath(env);
  const raw = readRaw(path);
  if (!raw.ok) {
    const problem = raw.reason.startsWith("cannot") ? raw.reason : `is not valid JSON (${raw.reason})`;
    throw new Error(`${shortPath(path, env)} ${problem}: fix or delete it, then try again`);
  }
  const next = { ...(raw.value ?? {}), ...patch };
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
  return { preset: isPresetId(next.preset) ? next.preset : DEFAULT_PRESET };
}
