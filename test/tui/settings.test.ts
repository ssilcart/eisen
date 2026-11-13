import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, type EditorSettings } from "../../src/config.ts";
import { labelFor, PRESET_IDS } from "../../src/domain/presets.ts";
import { QUADRANTS } from "../../src/domain/task.ts";
import { ACTIONS, DEFAULT_KEYMAP, buildKeymap, withKeys, type ActionDef } from "../../src/tui/keymap.ts";
import {
  SETTINGS_HINTS,
  bindKey,
  isCustomCommand,
  keysPatch,
  removeLastKey,
  resetAllPatch,
  resetKey,
  settingsHeight,
  settingsLines,
  settingsRows,
  settingsWidth,
  type SettingsValues,
} from "../../src/tui/settings.ts";

function values(over: Partial<SettingsValues> = {}): SettingsValues {
  return {
    preset: "classic",
    view: { ...DEFAULT_SETTINGS.view },
    editor: { ...DEFAULT_SETTINGS.editor },
    keymap: DEFAULT_KEYMAP,
    ...over,
  };
}
const editor = (over: Partial<EditorSettings>): EditorSettings => ({ ...DEFAULT_SETTINGS.editor, ...over });
const action = (scope: "normal" | "triage", id: string): ActionDef => ACTIONS.find((a) => a.scope === scope && a.id === id)!;
const texts = (...args: Parameters<typeof settingsLines>) => settingsLines(...args).map((l) => l.text);

describe("settings tabs (S33)", () => {
  test("the first line holds the three sections, the active one marked", () => {
    for (const section of ["general", "editor", "keys"] as const) {
      const [tabs] = settingsLines(section, values(), 0, 80, 40);
      expect(tabs!.kind).toBe("tabs");
      expect(tabs!.text).toContain("General");
      expect(tabs!.text).toContain("Editor");
      expect(tabs!.text).toContain("Keys");
      expect(tabs!.tabs!.filter((t) => t.active).map((t) => t.label)).toEqual([
        { general: "General", editor: "Editor", keys: "Keys" }[section],
      ]);
    }
  });

  test("hints per section: Keys names its own keys", () => {
    expect(SETTINGS_HINTS.general).toContain("Tab section");
    expect(SETTINGS_HINTS.general).toContain("Enter change");
    expect(SETTINGS_HINTS.general).toContain("Esc close");
    expect(SETTINGS_HINTS.editor).toBe(SETTINGS_HINTS.general);
    for (const part of ["Enter set", "a add", "Backspace remove", "r reset", "R reset all", "Esc close"]) {
      expect(SETTINGS_HINTS.keys).toContain(part);
    }
  });

  test("never wider than the width nor taller than the height, in every section", () => {
    for (const section of ["general", "editor", "keys"] as const) {
      for (const [w, h] of [
        [80, 40],
        [40, 10],
        [20, 5],
        [8, 3],
        [8, 1],
      ] as const) {
        const count = settingsRows(section, DEFAULT_SETTINGS.editor).length;
        for (const cursor of [0, count - 1]) {
          const lines = settingsLines(section, values({ preset: "focus" }), cursor, w, h);
          expect(lines.length).toBeLessThanOrEqual(h);
          for (const line of lines) expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(w);
          expect(lines.filter((l) => l.selected).length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("nothing for an empty box", () => {
    expect(settingsLines("general", values(), 0, 0, 10)).toEqual([]);
    expect(settingsLines("keys", values(), 0, 10, 0)).toEqual([]);
  });

  test("width and height cover the full-size lines", () => {
    const v = values();
    for (const section of ["general", "editor", "keys"] as const) {
      const lines = settingsLines(section, v, 0, 500, 500);
      expect(settingsHeight(section, v)).toBe(lines.length);
      for (const l of lines) expect(Bun.stringWidth(l.text)).toBeLessThanOrEqual(settingsWidth(v));
    }
  });
});

describe("General section (S33, S21)", () => {
  test("rows: the three presets, then Preview, Done panel and Bullets", () => {
    expect(settingsRows("general", DEFAULT_SETTINGS.editor)).toEqual([
      ...PRESET_IDS.map((preset) => ({ kind: "preset" as const, preset })),
      { kind: "view", field: "preview" },
      { kind: "view", field: "donePanel" },
      { kind: "view", field: "bullets" },
    ]);
  });

  test("lists every preset with a preview of its four labels, emoji included", () => {
    const all = texts("general", values(), 0, 80, 40).join("\n");
    for (const id of PRESET_IDS) for (const q of QUADRANTS) expect(all).toContain(`${q} ${labelFor(id, q)}`);
    for (const name of ["Classic", "Priority", "Focus"]) expect(all).toContain(name);
  });

  test("marks the current preset and the cursor", () => {
    const lines = settingsLines("general", values({ preset: "priority" }), 2, 80, 40);
    const names = lines.filter((l) => l.kind === "row" && /Classic|Priority|Focus/.test(l.text));
    expect(names.map((l) => l.text.trimEnd())).toEqual(["  Classic", "  Priority · current", "› Focus"]);
    expect(names.map((l) => l.selected)).toEqual([false, false, true]);
  });

  test("the preview mirrors the grid: 1 and 2 on a line, 3 and 4 on the next", () => {
    const lines = texts("general", values(), 0, 80, 40);
    const one = lines.find((l) => l.includes("1 ✅ Do"))!;
    expect(one).toContain("2 📅 Schedule");
    const three = lines.find((l) => l.includes("3 🤝 Delegate"))!;
    expect(three).toContain("4 🧹 Delete");
    const col = (line: string, text: string) => Bun.stringWidth(line.slice(0, line.indexOf(text)));
    expect(col(one, "2 📅")).toBe(col(three, "4 🧹"));
  });

  test("the panels show on/off and follow the values", () => {
    const v = values({ view: { preview: false, donePanel: true, bullets: true } });
    const rows = texts("general", v, 3, 80, 40);
    expect(rows.find((l) => l.includes("Preview"))).toMatch(/^› Preview\s+off$/);
    expect(rows.find((l) => l.includes("Done panel"))).toMatch(/^ {2}Done panel\s+on$/);
    expect(rows.find((l) => l.includes("Bullets"))).toMatch(/^ {2}Bullets\s+on$/);
  });

  test("when short of rows the cursor's preset stays visible with its preview, the tabs on top", () => {
    const lines = texts("general", values(), 2, 60, 6);
    expect(lines[0]).toContain("General");
    const all = lines.join("\n");
    expect(all).toContain("› Focus");
    expect(all).toContain("🔥 Urgent");
    expect(all).toContain("🧊 Someday");
    expect(all).not.toContain("Classic");
  });
});

describe("Editor section (S33, S32)", () => {
  test("auto: Mode and Display, no Command rows", () => {
    expect(settingsRows("editor", editor({ mode: "auto" }))).toEqual([
      { kind: "mode", mode: "auto" },
      { kind: "mode", mode: "command" },
      { kind: "mode", mode: "form" },
      { kind: "display", display: "floating" },
      { kind: "display", display: "fullscreen" },
    ]);
  });

  test("command: Mode, then nvim / vim / nano / hx / Custom…, then Display", () => {
    expect(settingsRows("editor", editor({ mode: "command" }))).toEqual([
      { kind: "mode", mode: "auto" },
      { kind: "mode", mode: "command" },
      { kind: "mode", mode: "form" },
      { kind: "command", command: "nvim" },
      { kind: "command", command: "vim" },
      { kind: "command", command: "nano" },
      { kind: "command", command: "hx" },
      { kind: "command", command: null },
      { kind: "display", display: "floating" },
      { kind: "display", display: "fullscreen" },
    ]);
  });

  test("form: only the Mode rows (no display)", () => {
    expect(settingsRows("editor", editor({ mode: "form" })).map((r) => r.kind)).toEqual(["mode", "mode", "mode"]);
    const all = texts("editor", values({ editor: editor({ mode: "form" }) }), 0, 80, 40).join("\n");
    expect(all).not.toContain("floating");
    expect(all).not.toContain("Display");
  });

  test("the chosen values are marked (*), a custom command shows on Custom…", () => {
    const v = values({ editor: editor({ mode: "command", command: "emacs -nw", display: "fullscreen" }) });
    const lines = texts("editor", v, 7, 80, 40);
    expect(lines.find((l) => l.includes("command") && l.includes("("))).toContain("(*) command");
    expect(lines.find((l) => l.includes(" auto"))).toContain("( ) auto");
    expect(lines.find((l) => l.includes("Custom…"))).toMatch(/^› \(\*\) Custom… +emacs -nw$/);
    expect(lines.find((l) => l.includes("nvim"))).toContain("( ) nvim");
    expect(lines.find((l) => l.includes("fullscreen"))).toContain("(*) fullscreen");
    for (const heading of ["Mode", "Command", "Display"]) expect(lines).toContain(heading);
  });

  test("a named command is marked on its row, not on Custom…", () => {
    const lines = texts("editor", values({ editor: editor({ mode: "command", command: "nano" }) }), 0, 80, 40);
    expect(lines.find((l) => l.includes("nano"))).toContain("(*) nano");
    expect(lines.find((l) => l.includes("Custom…"))!.trimEnd()).toBe("  ( ) Custom…");
  });

  test("isCustomCommand: anything but the four names", () => {
    expect(["nvim", "vim", "nano", "hx"].map(isCustomCommand)).toEqual([false, false, false, false]);
    expect(isCustomCommand("emacs -nw")).toBe(true);
    expect(isCustomCommand("nvim -u NONE")).toBe(true);
  });
});

describe("Keys section (S33, S30)", () => {
  test("one row per action, Matrix then Triage", () => {
    const rows = settingsRows("keys", DEFAULT_SETTINGS.editor);
    expect(rows.map((r) => (r.kind === "key" ? r.action : null))).toEqual([...ACTIONS]);
    const lines = texts("keys", values(), 0, 80, 60);
    const matrix = lines.indexOf("Matrix");
    const triage = lines.indexOf("Triage");
    expect(matrix).toBeGreaterThan(0);
    expect(triage).toBeGreaterThan(matrix);
    expect(lines.findIndex((l) => l.includes("Skip"))).toBeGreaterThan(triage);
  });

  test("label and current keys; changed ones marked *; an action without a key shows —", () => {
    const keymap = withKeys(DEFAULT_KEYMAP, "normal", "toggle_done", ["space", "x"]);
    const lines = settingsLines("keys", values({ keymap }), 0, 80, 60);
    const done = lines.find((l) => l.text.includes("Toggle done"))!;
    expect(done.text).toMatch(/^ {2}Toggle done +\* space \/ x$/);
    expect(done.changed).toBe(true);
    const left = lines.find((l) => l.text.includes("Move left"))!;
    expect(left.text).toMatch(/^› Move left +h \/ left$/);
    expect(left.changed).toBe(false);
    expect(lines.find((l) => l.text.includes("Bullets"))!.text).toMatch(/Bullets +—$/);
  });

  test("the cursor stays visible in a short box", () => {
    const last = ACTIONS.length - 1;
    const lines = texts("keys", values(), last, 60, 8);
    expect(lines[0]).toContain("Keys");
    expect(lines.join("\n")).toContain("› Exit triage");
  });
});

describe("key edits (S33, S30)", () => {
  const done = action("normal", "toggle_done");

  test("Enter's capture replaces the keys; `a` adds one", () => {
    expect(bindKey(DEFAULT_KEYMAP, done, "space", false)).toEqual({ ok: true, keys: ["space"], message: "Toggle done: space" });
    expect(bindKey(DEFAULT_KEYMAP, done, "space", true)).toEqual({ ok: true, keys: ["x", "space"], message: "Toggle done: x / space" });
  });

  test("a key of another action of the same scope is refused; the other scope is fine", () => {
    expect(bindKey(DEFAULT_KEYMAP, action("normal", "edit"), "x", false)).toEqual({ ok: false, message: "`x` is already Toggle done" });
    expect(bindKey(DEFAULT_KEYMAP, action("triage", "skip"), "x", false)).toMatchObject({ ok: true, keys: ["x"] });
    // Its own key again is fine.
    expect(bindKey(DEFAULT_KEYMAP, done, "x", false)).toMatchObject({ ok: true, keys: ["x"] });
  });

  test("adding a key it already has, or a never-bindable or unknown key, is refused", () => {
    expect(bindKey(DEFAULT_KEYMAP, done, "x", true)).toEqual({ ok: false, message: "Toggle done already has `x`" });
    expect(bindKey(DEFAULT_KEYMAP, done, "return", false)).toEqual({ ok: false, message: "`Enter` can't be bound" });
    expect(bindKey(DEFAULT_KEYMAP, done, "backspace", false)).toEqual({ ok: false, message: "`Backspace` can't be bound" });
    expect(bindKey(DEFAULT_KEYMAP, done, null, false)).toEqual({ ok: false, message: "That key can't be bound" });
  });

  test("Backspace removes the last key; refused on a guarded action's last key", () => {
    const keymap = withKeys(DEFAULT_KEYMAP, "normal", "toggle_done", ["x", "space"]);
    expect(removeLastKey(keymap, done)).toEqual({ ok: true, keys: ["x"], message: "Toggle done: x" });
    expect(removeLastKey(DEFAULT_KEYMAP, done)).toEqual({ ok: true, keys: [], message: "Toggle done: no key" });
    expect(removeLastKey(DEFAULT_KEYMAP, action("normal", "toggle_bullets"))).toEqual({ ok: false, message: "Bullets has no key" });
    for (const id of ["quit", "help", "settings", "command_line"]) {
      const result = removeLastKey(DEFAULT_KEYMAP, action("normal", id));
      expect(result.ok).toBe(false);
      expect(result.message).toEndWith("needs at least one key");
    }
    expect(removeLastKey(withKeys(DEFAULT_KEYMAP, "normal", "quit", ["q", "Q"]), action("normal", "quit"))).toMatchObject({
      ok: true,
      keys: ["q"],
    });
    // Triage's help is not guarded (S30 guards matrix actions).
    expect(removeLastKey(DEFAULT_KEYMAP, action("triage", "help")).ok).toBe(true);
  });

  test("reset goes back to the defaults, unless another action took one of them", () => {
    const moved = withKeys(DEFAULT_KEYMAP, "normal", "toggle_done", ["space"]);
    expect(resetKey(moved, done)).toEqual({ ok: true, keys: ["x"], message: "Toggle done: x (default)" });
    const taken = withKeys(moved, "normal", "edit", ["x"]);
    expect(resetKey(taken, done)).toEqual({ ok: false, message: "`x` is already Edit" });
  });

  test("patches: the action's config name, null when the keys equal the defaults; reset all nulls every action", () => {
    expect(keysPatch(done, ["space"])).toEqual({ toggle_done: ["space"] });
    expect(keysPatch(done, ["x"])).toEqual({ toggle_done: null });
    expect(keysPatch(action("triage", "skip"), ["n"])).toEqual({ "triage.skip": ["n"] });
    const all = resetAllPatch();
    expect(Object.keys(all).sort()).toEqual(ACTIONS.map((a) => a.name).sort());
    expect(Object.values(all).every((v) => v === null)).toBe(true);
    // The patches never hold undefined (L29b).
    expect(JSON.stringify(keysPatch(done, []))).toBe('{"toggle_done":[]}');
  });

  test("a keymap built from the reset patch's result is the default", () => {
    expect(buildKeymap({}).keymap.keys).toEqual(DEFAULT_KEYMAP.keys);
  });
});
