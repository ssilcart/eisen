import { describe, expect, test } from "bun:test";
import {
  ACTIONS,
  DEFAULT_KEYMAP,
  GUARDED_ACTIONS,
  actionFor,
  buildKeymap,
  checkKey,
  conflictFor,
  eventKey,
  formatKey,
  keysOf,
  parseKey,
  withKeys,
  type KeyEventLike,
} from "../../src/tui/keymap.ts";

function ev(name: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  return { name, sequence: extra.sequence ?? name, shift: false, ctrl: false, ...extra };
}

describe("key strings (S30)", () => {
  test("parse and format round-trip the canonical forms", () => {
    for (const s of [
      "a", "A", "?", ".", ":", "1", "ñ", "+", "space", "tab", "up", "down", "left", "right",
      "pageup", "pagedown", "home", "end", "f1", "f12", "ctrl+d", "alt+x", "alt+X", "ctrl+alt+k", "ctrl++",
    ]) {
      const parsed = parseKey(s);
      expect(parsed).not.toBeNull();
      expect(formatKey(parsed!)).toBe(s);
    }
  });

  test("names and prefixes are case-insensitive; a letter keeps its case except under ctrl", () => {
    expect(formatKey(parseKey("Space")!)).toBe("space");
    expect(formatKey(parseKey("CTRL+D")!)).toBe("ctrl+d");
    expect(formatKey(parseKey("Alt+PageUp")!)).toBe("alt+pageup");
    expect(formatKey(parseKey("ctrl+D")!)).toBe("ctrl+d");
  });

  test("rejects what is not a key", () => {
    for (const s of ["", "ab", "f13", "f0", "shift+a", "ctrl+", "ctrl+foo", " ", "\t", "\u0007", "super+x"]) {
      expect(parseKey(s)).toBeNull();
    }
    expect(parseKey(3 as unknown as string)).toBeNull();
  });

  test("Esc, Enter, Ctrl+C and Backspace are never bindable", () => {
    for (const s of ["esc", "escape", "Escape", "enter", "return", "ctrl+c", "backspace", "ctrl+C"]) {
      const result = checkKey(s);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("can't be bound");
    }
    expect(checkKey("bogus")).toEqual({ ok: false, reason: "is not a key" });
    expect(checkKey("ctrl+x")).toEqual({ ok: true, key: "ctrl+x" });
  });
});

describe("eventKey: OpenTUI key events (L11)", () => {
  test("letters, shifted letters and the sequence", () => {
    expect(eventKey(ev("j"))).toBe("j");
    expect(eventKey(ev("j", { shift: true, sequence: "J" }))).toBe("J");
    expect(eventKey(ev("J"))).toBe("J");
    expect(eventKey(ev("j", { sequence: "J" }))).toBe("J");
  });

  test("symbols and digits arrive with name = the char, shift ignored", () => {
    expect(eventKey(ev("?", { shift: true }))).toBe("?");
    expect(eventKey(ev("."))).toBe(".");
    expect(eventKey(ev("1"))).toBe("1");
  });

  test("named keys, modifiers, and shifted names that cannot be bound", () => {
    expect(eventKey(ev("space", { sequence: " " }))).toBe("space");
    expect(eventKey(ev("up", { sequence: "\u001b[A" }))).toBe("up");
    expect(eventKey(ev("d", { ctrl: true, sequence: "\u0004" }))).toBe("ctrl+d");
    expect(eventKey(ev("x", { meta: true, sequence: "\u001bx" }))).toBe("alt+x");
    expect(eventKey(ev("X", { meta: true, shift: true, sequence: "\u001bX" }))).toBe("alt+X");
    expect(eventKey(ev("up", { shift: true }))).toBeNull();
    expect(eventKey(ev("tab", { shift: true }))).toBeNull();
  });
});

describe("the default keymap equals today's keys (S10, S12)", () => {
  const normal = (k: KeyEventLike) => actionFor(DEFAULT_KEYMAP, "normal", k);
  const triage = (k: KeyEventLike) => actionFor(DEFAULT_KEYMAP, "triage", k);

  test("normal scope", () => {
    const cases: [KeyEventLike, string | null][] = [
      [ev("h"), "move_left"],
      [ev("left"), "move_left"],
      [ev("j"), "move_down"],
      [ev("down"), "move_down"],
      [ev("k"), "move_up"],
      [ev("up"), "move_up"],
      [ev("l"), "move_right"],
      [ev("right"), "move_right"],
      [ev("1"), "send_q1"],
      [ev("4"), "send_q4"],
      [ev("a"), "new_task"],
      [ev("a", { shift: true, sequence: "A" }), "quick_add"],
      [ev("e"), "edit"],
      [ev("x"), "toggle_done"],
      [ev("d"), "delete"],
      [ev("j", { shift: true, sequence: "J" }), "order_down"],
      [ev("k", { shift: true, sequence: "K" }), "order_up"],
      [ev("/"), "search"],
      [ev("i"), "triage"],
      [ev("."), "toggle_done_panel"],
      [ev("p"), "toggle_preview"],
      [ev("d", { ctrl: true }), "preview_down"],
      [ev("u", { ctrl: true }), "preview_up"],
      [ev(":"), "command_line"],
      [ev(","), "settings"],
      [ev("?"), "help"],
      [ev("q"), "quit"],
      [ev("x", { shift: true, sequence: "X" }), null],
      [ev("z"), null],
      [ev("escape", { sequence: "\u001b" }), null],
    ];
    for (const [k, id] of cases) expect([k.name, k.shift, normal(k)]).toEqual([k.name, k.shift, id]);
    expect(keysOf(DEFAULT_KEYMAP, "normal", "toggle_bullets")).toEqual([]);
  });

  test("triage scope", () => {
    const cases: [KeyEventLike, string | null][] = [
      [ev("1"), "send_q1"],
      [ev("2"), "send_q2"],
      [ev("3"), "send_q3"],
      [ev("4"), "send_q4"],
      [ev("s"), "skip"],
      [ev("e"), "edit"],
      [ev("d"), "delete"],
      [ev("?"), "help"],
      [ev("q"), "exit_triage"],
      [ev("x"), null],
      [ev("s", { shift: true, sequence: "S" }), null],
    ];
    for (const [k, id] of cases) expect([k.name, triage(k)]).toEqual([k.name, id]);
  });

  test("every action has a snake_case id, a label and a scope; ids are unique per scope", () => {
    const seen = new Set<string>();
    for (const a of ACTIONS) {
      expect(a.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(a.label.length).toBeGreaterThan(0);
      expect(["normal", "triage"]).toContain(a.scope);
      expect(seen.has(`${a.scope}:${a.id}`)).toBe(false);
      seen.add(`${a.scope}:${a.id}`);
    }
    expect([...GUARDED_ACTIONS].sort()).toEqual(["command_line", "help", "quit", "settings"]);
  });

  test("display keys of an action", () => {
    expect(keysOf(DEFAULT_KEYMAP, "normal", "move_left")).toEqual(["h", "left"]);
    expect(keysOf(DEFAULT_KEYMAP, "triage", "exit_triage")).toEqual(["q"]);
    expect(keysOf(DEFAULT_KEYMAP, "normal", "nope")).toEqual([]);
  });
});

describe("buildKeymap: overrides (S29, S30)", () => {
  test("no overrides: the defaults, no warnings", () => {
    const { keymap, warnings } = buildKeymap({});
    expect(warnings).toEqual([]);
    expect(keysOf(keymap, "normal", "toggle_done")).toEqual(["x"]);
    expect(buildKeymap(undefined).warnings).toEqual([]);
  });

  test("an override replaces the action's keys", () => {
    const { keymap, warnings } = buildKeymap({ toggle_done: ["space"] });
    expect(warnings).toEqual([]);
    expect(keysOf(keymap, "normal", "toggle_done")).toEqual(["space"]);
    expect(actionFor(keymap, "normal", ev("space", { sequence: " " }))).toBe("toggle_done");
    expect(actionFor(keymap, "normal", ev("x"))).toBeNull();
    // Triage is its own scope.
    expect(keysOf(keymap, "triage", "skip")).toEqual(["s"]);
  });

  test("several keys, duplicates collapsed, an empty list unbinds", () => {
    const { keymap, warnings } = buildKeymap({ toggle_done: ["x", "space", "x"], delete: [] });
    expect(warnings).toEqual([]);
    expect(keysOf(keymap, "normal", "toggle_done")).toEqual(["x", "space"]);
    expect(keysOf(keymap, "normal", "delete")).toEqual([]);
    expect(actionFor(keymap, "normal", ev("d"))).toBeNull();
  });

  test("triage actions are addressed as triage.<id>", () => {
    const { keymap, warnings } = buildKeymap({ "triage.skip": ["n"], "triage.edit": ["E"] });
    expect(warnings).toEqual([]);
    expect(actionFor(keymap, "triage", ev("n"))).toBe("skip");
    expect(actionFor(keymap, "triage", ev("e", { shift: true, sequence: "E" }))).toBe("edit");
    expect(actionFor(keymap, "normal", ev("e"))).toBe("edit");
  });

  test("unknown action, bad value, invalid or never-bindable key: that override is ignored with a warning", () => {
    const { keymap, warnings } = buildKeymap({
      fly: ["f"],
      edit: "e",
      delete: ["ctrl+c"],
      search: ["nope"],
      toggle_done: ["space"],
      skip: ["n"],
    });
    expect(keysOf(keymap, "normal", "edit")).toEqual(["e"]);
    expect(keysOf(keymap, "normal", "delete")).toEqual(["d"]);
    expect(keysOf(keymap, "normal", "search")).toEqual(["/"]);
    expect(keysOf(keymap, "normal", "toggle_done")).toEqual(["space"]);
    expect(warnings).toEqual([
      'Config: keys.fly is not an action, ignored',
      "Config: keys.edit is not a list of keys, ignored",
      `Config: keys.delete "ctrl+c" can't be bound, ignored`,
      'Config: keys.search "nope" is not a key, ignored',
      'Config: keys.skip is not an action, ignored',
    ]);
  });

  test("a conflict in the same scope ignores the override", () => {
    const { keymap, warnings } = buildKeymap({ toggle_done: ["d"] });
    expect(keysOf(keymap, "normal", "toggle_done")).toEqual(["x"]);
    expect(keysOf(keymap, "normal", "delete")).toEqual(["d"]);
    expect(warnings).toEqual(['Config: keys.toggle_done "d" is already Delete, ignored']);
  });

  test("swapping two actions' keys works", () => {
    const { keymap, warnings } = buildKeymap({ toggle_done: ["d"], delete: ["x"] });
    expect(warnings).toEqual([]);
    expect(actionFor(keymap, "normal", ev("d"))).toBe("toggle_done");
    expect(actionFor(keymap, "normal", ev("x"))).toBe("delete");
  });

  test("the same key in another scope is not a conflict", () => {
    const { warnings } = buildKeymap({ "triage.skip": ["x"] });
    expect(warnings).toEqual([]);
  });

  test("quit, help, settings and command_line keep at least one key", () => {
    const { keymap, warnings } = buildKeymap({ quit: [], help: [], settings: [], command_line: [], search: [] });
    expect(keysOf(keymap, "normal", "quit")).toEqual(["q"]);
    expect(keysOf(keymap, "normal", "help")).toEqual(["?"]);
    expect(keysOf(keymap, "normal", "settings")).toEqual([","]);
    expect(keysOf(keymap, "normal", "command_line")).toEqual([":"]);
    expect(keysOf(keymap, "normal", "search")).toEqual([]);
    expect(warnings).toEqual([
      "Config: keys.quit needs at least one key, ignored",
      "Config: keys.help needs at least one key, ignored",
      "Config: keys.settings needs at least one key, ignored",
      "Config: keys.command_line needs at least one key, ignored",
    ]);
  });

  test("reads own properties only (L29a)", () => {
    const parsed = JSON.parse('{"__proto__": ["x"], "constructor": ["c"], "toString": ["t"]}');
    const { keymap, warnings } = buildKeymap(parsed);
    expect(warnings).toEqual([
      "Config: keys.__proto__ is not an action, ignored",
      "Config: keys.constructor is not an action, ignored",
      "Config: keys.toString is not an action, ignored",
    ]);
    expect(keysOf(keymap, "normal", "toggle_done")).toEqual(["x"]);
    // An inherited property is never read.
    const inherited = Object.create({ toggle_done: ["space"] });
    expect(keysOf(buildKeymap(inherited).keymap, "normal", "toggle_done")).toEqual(["x"]);
  });

  test("long or odd values do not blow up the warning", () => {
    const { warnings } = buildKeymap({ search: ["z".repeat(5000)], [`a${"b".repeat(5000)}`]: ["x"] });
    for (const w of warnings) expect(w.length).toBeLessThan(200);
  });
});

describe("helpers for the settings screen (T22)", () => {
  test("conflictFor names the action holding a key in that scope", () => {
    expect(conflictFor(DEFAULT_KEYMAP, "normal", "x")).toBe("toggle_done");
    expect(conflictFor(DEFAULT_KEYMAP, "normal", "x", "toggle_done")).toBeNull();
    expect(conflictFor(DEFAULT_KEYMAP, "normal", "space")).toBeNull();
    expect(conflictFor(DEFAULT_KEYMAP, "triage", "x")).toBeNull();
  });

  test("withKeys returns a new keymap and leaves the old one alone", () => {
    const next = withKeys(DEFAULT_KEYMAP, "normal", "toggle_done", ["space"]);
    expect(actionFor(next, "normal", ev("space"))).toBe("toggle_done");
    expect(actionFor(next, "normal", ev("x"))).toBeNull();
    expect(actionFor(DEFAULT_KEYMAP, "normal", ev("x"))).toBe("toggle_done");
  });
});
