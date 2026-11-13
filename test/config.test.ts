import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadConfig, loadSettings, resolveConfigPath, saveConfig, saveSettings } from "../src/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eisen-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveConfigPath (S21)", () => {
  test("EISEN_CONFIG wins over XDG_CONFIG_HOME and HOME", () => {
    expect(resolveConfigPath({ EISEN_CONFIG: "/x/c.json", XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" })).toBe("/x/c.json");
  });

  test("XDG_CONFIG_HOME wins over HOME", () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" })).toBe("/xdg/eisen/config.json");
  });

  test("falls back to ~/.config/eisen/config.json", () => {
    expect(resolveConfigPath({ HOME: "/home/u" })).toBe("/home/u/.config/eisen/config.json");
  });

  test("empty variables are ignored", () => {
    expect(resolveConfigPath({ EISEN_CONFIG: "", XDG_CONFIG_HOME: "", HOME: "/home/u" })).toBe(
      "/home/u/.config/eisen/config.json",
    );
  });
});

describe("loadConfig (S21)", () => {
  test("a missing file gives the defaults without a warning", () => {
    const result = loadConfig({ EISEN_CONFIG: join(dir, "nope", "config.json") });
    expect(result.config).toEqual({ preset: "classic" });
    expect(result.warning).toBeUndefined();
  });

  test("reads the preset", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, '{"preset": "focus"}');
    expect(loadConfig({ EISEN_CONFIG: path })).toEqual({ config: { preset: "focus" }, path });
  });

  test("reads it from XDG_CONFIG_HOME", () => {
    mkdirSync(join(dir, "eisen"));
    writeFileSync(join(dir, "eisen", "config.json"), '{"preset": "priority"}');
    expect(loadConfig({ XDG_CONFIG_HOME: dir, HOME: "/nowhere" }).config.preset).toBe("priority");
  });

  test("invalid JSON gives the defaults and a warning, never throws", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, '{"preset": "focus",');
    const result = loadConfig({ EISEN_CONFIG: path });
    expect(result.config).toEqual({ preset: "classic" });
    expect(result.warning).toContain("invalid JSON");
    expect(result.warning).toContain("config.json");
  });

  test("a JSON value that is not an object gives the defaults and a warning", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, '["focus"]');
    const result = loadConfig({ EISEN_CONFIG: path });
    expect(result.config).toEqual({ preset: "classic" });
    expect(result.warning).toBeDefined();
  });

  test("an unknown preset gives the default preset and a warning", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, '{"preset": "fantasy"}');
    const result = loadConfig({ EISEN_CONFIG: path });
    expect(result.config).toEqual({ preset: "classic" });
    expect(result.warning).toContain('unknown preset "fantasy"');
  });

  test("an unreadable path (a directory) gives the defaults and a warning", () => {
    const result = loadConfig({ EISEN_CONFIG: dir });
    expect(result.config).toEqual({ preset: "classic" });
    expect(result.warning).toBeDefined();
  });
});

describe("saveConfig (S21)", () => {
  test("creates the directory and writes the preset", () => {
    const path = join(dir, "deep", "eisen", "config.json");
    saveConfig({ EISEN_CONFIG: path }, { preset: "focus" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ preset: "focus" });
    expect(loadConfig({ EISEN_CONFIG: path }).config.preset).toBe("focus");
  });

  test("keeps unknown keys", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ preset: "classic", theme: { accent: "red" }, future: [1, 2] }));
    saveConfig({ EISEN_CONFIG: path }, { preset: "priority" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ preset: "priority", theme: { accent: "red" }, future: [1, 2] });
  });

  test("writes atomically: no temp file is left next to it", () => {
    const path = join(dir, "config.json");
    saveConfig({ EISEN_CONFIG: path }, { preset: "focus" });
    saveConfig({ EISEN_CONFIG: path }, { preset: "priority" });
    expect(readdirSync(dir)).toEqual(["config.json"]);
    expect(readFileSync(path, "utf8")).toBe('{\n  "preset": "priority"\n}\n');
  });

  test("refuses to overwrite a file that is not valid JSON, and leaves it as it was", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{oops");
    expect(() => saveConfig({ EISEN_CONFIG: path }, { preset: "focus" })).toThrow("not valid JSON");
    expect(readFileSync(path, "utf8")).toBe("{oops");
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  test("a directory it cannot write to throws and leaves no temp file", () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(() => saveConfig({ EISEN_CONFIG: join(locked, "config.json") }, { preset: "focus" })).toThrow();
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(existsSync(join(locked, "config.json"))).toBe(false);
  });
});

describe("loadSettings (S29)", () => {
  const write = (value: unknown): string => {
    const path = join(dir, "config.json");
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };

  test("a missing file gives every default, no warnings", () => {
    const result = loadSettings({ EISEN_CONFIG: join(dir, "none.json") });
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warnings).toEqual([]);
  });

  test("a v0.1 file loads unchanged: only the preset differs from the defaults", () => {
    const result = loadSettings({ EISEN_CONFIG: write({ preset: "focus" }) });
    expect(result.settings).toEqual({ ...DEFAULT_SETTINGS, preset: "focus" });
    expect(result.warnings).toEqual([]);
  });

  test("reads every section", () => {
    const path = write({
      preset: "priority",
      view: { preview: false, donePanel: true, bullets: false },
      editor: { mode: "form", command: "nano", display: "fullscreen" },
      keys: { toggle_done: ["space"], quit: ["q", "ctrl+q"] },
    });
    expect(loadSettings({ EISEN_CONFIG: path }).settings).toEqual({
      preset: "priority",
      view: { preview: false, donePanel: true, bullets: false },
      editor: { mode: "form", command: "nano", display: "fullscreen" },
      keys: { toggle_done: ["space"], quit: ["q", "ctrl+q"] },
    });
  });

  test("a bad field falls back alone, with one warning naming it; the rest applies", () => {
    const path = write({ preset: "focus", view: { preview: "yes", bullets: false }, editor: { mode: "foo", command: "hx" } });
    const result = loadSettings({ EISEN_CONFIG: path });
    expect(result.settings.preset).toBe("focus");
    expect(result.settings.view).toEqual({ ...DEFAULT_SETTINGS.view, bullets: false });
    expect(result.settings.editor).toEqual({ ...DEFAULT_SETTINGS.editor, command: "hx" });
    expect(result.warnings).toEqual([
      'Config: view.preview "yes" is not true/false, using true',
      'Config: editor.mode "foo" unknown, using "auto"',
    ]);
  });

  test("an unknown preset keeps the other sections", () => {
    const result = loadSettings({ EISEN_CONFIG: write({ preset: "fantasy", view: { donePanel: true } }) });
    expect(result.settings.preset).toBe("classic");
    expect(result.settings.view.donePanel).toBe(true);
    expect(result.warnings).toEqual(['Config: preset "fantasy" unknown, using "classic"']);
  });

  test("an empty editor.command and a bad display fall back with warnings", () => {
    const result = loadSettings({ EISEN_CONFIG: write({ editor: { command: "  ", display: "popup" } }) });
    expect(result.settings.editor).toEqual(DEFAULT_SETTINGS.editor);
    expect(result.warnings).toHaveLength(2);
  });

  test("a section that is not an object is ignored with a warning", () => {
    const result = loadSettings({ EISEN_CONFIG: write({ view: 3, keys: ["x"] }) });
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warnings).toEqual(["Config: view is not an object, using the defaults", "Config: keys is not an object, using the defaults"]);
  });

  test("a keys entry that is not a list of strings is ignored with a warning, the others apply", () => {
    const result = loadSettings({ EISEN_CONFIG: write({ keys: { toggle_done: "x", quit: ["q"], edit: [1] } }) });
    expect(result.settings.keys).toEqual({ quit: ["q"] });
    expect(result.warnings).toEqual([
      "Config: keys.toggle_done is not a list of keys, ignored",
      "Config: keys.edit is not a list of keys, ignored",
    ]);
  });

  test("an unreadable file gives the defaults and one warning", () => {
    const result = loadSettings({ EISEN_CONFIG: write("{nope") });
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid JSON");
  });
});

describe("saveSettings (S29)", () => {
  test("deep-merges each section and keeps unknown keys at every level", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ preset: "focus", theme: "dark", view: { preview: true, extra: 1 }, keys: { quit: ["q"] }, editor: { mode: "auto", future: "x" } }),
    );
    saveSettings({ EISEN_CONFIG: path }, { view: { donePanel: true } });
    saveSettings({ EISEN_CONFIG: path }, { editor: { mode: "form" }, keys: { toggle_done: ["space"] } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      preset: "focus",
      theme: "dark",
      view: { preview: true, extra: 1, donePanel: true },
      keys: { quit: ["q"], toggle_done: ["space"] },
      editor: { mode: "form", future: "x" },
    });
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  test("null removes a key override", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ keys: { quit: ["q"], edit: ["E"] } }));
    const settings = saveSettings({ EISEN_CONFIG: path }, { keys: { edit: null } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ keys: { quit: ["q"] } });
    expect(settings.keys).toEqual({ quit: ["q"] });
  });

  test("replaces a section that is not an object", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ view: 3 }));
    saveSettings({ EISEN_CONFIG: path }, { view: { bullets: false } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ view: { bullets: false } });
  });

  test("returns what a fresh load would read, and round-trips", () => {
    const env = { EISEN_CONFIG: join(dir, "new", "config.json") };
    const saved = saveSettings(env, { preset: "priority", view: { preview: false }, editor: { command: "nano" } });
    expect(saved).toEqual(loadSettings(env).settings);
    expect(saved).toEqual({
      ...DEFAULT_SETTINGS,
      preset: "priority",
      view: { ...DEFAULT_SETTINGS.view, preview: false },
      editor: { ...DEFAULT_SETTINGS.editor, command: "nano" },
    });
  });

  test("refuses to overwrite a file that is not valid JSON", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{oops");
    expect(() => saveSettings({ EISEN_CONFIG: path }, { view: { preview: false } })).toThrow("not valid JSON");
    expect(readFileSync(path, "utf8")).toBe("{oops");
  });
});
