import { describe, expect, test } from "bun:test";
import {
  COMMAND_NAMES,
  completeCommand,
  parseCommand,
  pushHistory,
  walkHistory,
  type Completion,
} from "../../src/tui/commands.ts";

describe("parseCommand (S31)", () => {
  test("view toggles: no argument toggles, on/off set", () => {
    expect(parseCommand("preview")).toEqual({ ok: true, command: { kind: "toggle", view: "preview" } });
    expect(parseCommand("preview on")).toEqual({ ok: true, command: { kind: "toggle", view: "preview", value: true } });
    expect(parseCommand("preview off")).toEqual({ ok: true, command: { kind: "toggle", view: "preview", value: false } });
    expect(parseCommand("done")).toEqual({ ok: true, command: { kind: "toggle", view: "donePanel" } });
    expect(parseCommand("done on")).toEqual({ ok: true, command: { kind: "toggle", view: "donePanel", value: true } });
    expect(parseCommand("bullets off")).toEqual({ ok: true, command: { kind: "toggle", view: "bullets", value: false } });
  });

  test("a toggle with no argument carries no `value` key at all (patches never carry undefined)", () => {
    const parsed = parseCommand("preview");
    expect(parsed.ok && parsed.command !== null && "value" in parsed.command).toBe(false);
  });

  test("surrounding and repeated whitespace is ignored", () => {
    expect(parseCommand("  bullets   on  ")).toEqual({ ok: true, command: { kind: "toggle", view: "bullets", value: true } });
  });

  test("bad toggle argument → usage, for each toggle", () => {
    expect(parseCommand("preview maybe")).toEqual({ ok: false, error: "Usage: :preview [on|off]" });
    expect(parseCommand("done 1")).toEqual({ ok: false, error: "Usage: :done [on|off]" });
    expect(parseCommand("bullets on off")).toEqual({ ok: false, error: "Usage: :bullets [on|off]" });
  });

  test("mode shortcuts take no argument", () => {
    expect(parseCommand("settings")).toEqual({ ok: true, command: { kind: "settings" } });
    expect(parseCommand("help")).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseCommand("triage")).toEqual({ ok: true, command: { kind: "triage" } });
    expect(parseCommand("help me")).toEqual({ ok: false, error: "Usage: :help" });
  });

  test(":q and :quit quit", () => {
    expect(parseCommand("q")).toEqual({ ok: true, command: { kind: "quit" } });
    expect(parseCommand("quit")).toEqual({ ok: true, command: { kind: "quit" } });
    expect(parseCommand("q now")).toEqual({ ok: false, error: "Usage: :q" });
  });

  test(":search and :add keep the rest of the line as typed (inner spaces, #tags)", () => {
    expect(parseCommand("search zoho  prod")).toEqual({ ok: true, command: { kind: "search", query: "zoho  prod" } });
    expect(parseCommand("add Call bank #fin")).toEqual({ ok: true, command: { kind: "add", title: "Call bank #fin" } });
    expect(parseCommand("search")).toEqual({ ok: false, error: "Usage: :search <query>" });
    expect(parseCommand("add   ")).toEqual({ ok: false, error: "Usage: :add <title>" });
  });

  test("an empty line is no command and no error", () => {
    expect(parseCommand("")).toEqual({ ok: true, command: null });
    expect(parseCommand("   ")).toEqual({ ok: true, command: null });
  });

  test("unknown commands name what was typed; names are exact (no prefixes, case-sensitive)", () => {
    expect(parseCommand("foo")).toEqual({ ok: false, error: "Unknown command: foo" });
    expect(parseCommand("foo bar")).toEqual({ ok: false, error: "Unknown command: foo" });
    expect(parseCommand("pre")).toEqual({ ok: false, error: "Unknown command: pre" });
    expect(parseCommand("Preview")).toEqual({ ok: false, error: "Unknown command: Preview" });
    // Configuration commands are out of scope (S31).
    expect(parseCommand("preset focus")).toEqual({ ok: false, error: "Unknown command: preset" });
  });
});

describe("completeCommand (S31)", () => {
  test("one matching command completes, with a space after commands that take an argument", () => {
    expect(completeCommand("pre", null)).toEqual({ line: "preview ", completion: null });
    expect(completeCommand("sea", null)).toEqual({ line: "search ", completion: null });
    expect(completeCommand("sett", null)).toEqual({ line: "settings", completion: null });
    expect(completeCommand("  pre", null)).toEqual({ line: "preview ", completion: null });
  });

  test("then the argument: on/off, filtered by what is typed", () => {
    expect(completeCommand("preview o", null).line).toBe("preview on");
    expect(completeCommand("preview of", null)).toEqual({ line: "preview off", completion: null });
    expect(completeCommand("done on", null)).toEqual({ line: "done on", completion: null });
  });

  test("several candidates: the first is applied and repeated Tab cycles, wrapping around", () => {
    let r = completeCommand("preview ", null);
    expect(r.line).toBe("preview on");
    expect(r.completion?.candidates).toEqual(["preview on", "preview off"]);
    r = completeCommand(r.line, r.completion);
    expect(r.line).toBe("preview off");
    r = completeCommand(r.line, r.completion);
    expect(r.line).toBe("preview on");
  });

  test("an empty line cycles through every command name (aliases left out)", () => {
    let r = completeCommand("", null);
    const seen = [r.line];
    for (let i = 1; i < COMMAND_NAMES.length; i++) {
      r = completeCommand(r.line, r.completion);
      seen.push(r.line);
    }
    expect(seen.map((l) => l.trim())).toEqual([...COMMAND_NAMES]);
    expect(COMMAND_NAMES).not.toContain("q");
    expect(completeCommand(r.line, r.completion).line.trim()).toBe(COMMAND_NAMES[0]!);
  });

  test("a prefix shared by several commands cycles among them", () => {
    // `s` → search, settings (in COMMAND_NAMES order).
    let r = completeCommand("s", null);
    const first = r.line;
    r = completeCommand(r.line, r.completion);
    expect([first, r.line].sort()).toEqual(["search ", "settings"]);
  });

  test("a stale completion (the line was edited since) starts over from the line", () => {
    const stale: Completion = { candidates: ["preview on", "preview off"], index: 0 };
    expect(completeCommand("bul", stale)).toEqual({ line: "bullets ", completion: null });
  });

  test("nothing to complete leaves the line as it is", () => {
    expect(completeCommand("xyz", null)).toEqual({ line: "xyz", completion: null });
    expect(completeCommand("add Call", null)).toEqual({ line: "add Call", completion: null });
    expect(completeCommand("preview x", null)).toEqual({ line: "preview x", completion: null });
    expect(completeCommand("help ", null)).toEqual({ line: "help ", completion: null });
  });
});

describe("history (S31)", () => {
  test("pushHistory skips blank lines and an immediate repeat", () => {
    let h: readonly string[] = [];
    h = pushHistory(h, "preview");
    h = pushHistory(h, "  ");
    h = pushHistory(h, "preview");
    h = pushHistory(h, "done on");
    expect(h).toEqual(["preview", "done on"]);
  });

  test("↑ walks back from the newest, stops at the oldest; ↓ comes back to the draft", () => {
    const h = ["preview", "done on", "add x"];
    let r = walkHistory(h, null, "dra", -1);
    expect(r).toEqual({ line: "add x", cursor: { index: 2, draft: "dra" } });
    r = walkHistory(h, r.cursor, r.line, -1);
    expect(r.line).toBe("done on");
    r = walkHistory(h, r.cursor, r.line, -1);
    expect(r.line).toBe("preview");
    r = walkHistory(h, r.cursor, r.line, -1);
    expect(r.line).toBe("preview");
    expect(r.cursor?.index).toBe(0);
    r = walkHistory(h, r.cursor, r.line, 1);
    expect(r.line).toBe("done on");
    r = walkHistory(h, r.cursor, r.line, 1);
    r = walkHistory(h, r.cursor, r.line, 1);
    expect(r).toEqual({ line: "dra", cursor: null });
  });

  test("↓ without walking and ↑ on an empty history change nothing", () => {
    expect(walkHistory(["a"], null, "x", 1)).toEqual({ line: "x", cursor: null });
    expect(walkHistory([], null, "x", -1)).toEqual({ line: "x", cursor: null });
  });
});
