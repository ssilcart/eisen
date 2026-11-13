import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfigPath, saveConfig } from "../src/config.ts";

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
