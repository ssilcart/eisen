import { describe, expect, test } from "bun:test";
import {
  clamp,
  currentId,
  focusMatches,
  follow,
  initialState,
  keyToAction,
  offerTriage,
  reduce,
  searchActive,
  selectedId,
  syncTriage,
  type Action,
  type Key,
  type PaneItems,
  type ViewState,
} from "../../src/tui/state.ts";

function key(name: string, extra: Partial<Key> = {}): Key {
  return { name, sequence: extra.sequence ?? name, shift: false, ctrl: false, ...extra };
}
const upper = (ch: string): Key => key(ch.toLowerCase(), { shift: true, sequence: ch });

function items(...ids: number[]) {
  return ids.map((id) => ({ id }));
}
function panes(q1: number[], q2: number[] = [], q3: number[] = [], q4: number[] = []): PaneItems {
  return { 1: items(...q1), 2: items(...q2), 3: items(...q3), 4: items(...q4) };
}
function state(over: Partial<ViewState> = {}): ViewState {
  return { ...initialState(), ...over };
}
function press(s: ViewState, k: Key, p: PaneItems): ViewState {
  return reduce(s, keyToAction(s, k), p);
}

describe("keyToAction in normal mode (S10)", () => {
  const s = initialState();
  const cases: [string, Key, Action][] = [
    ["h", key("h"), { type: "navigate", dir: "left" }],
    ["l", key("l"), { type: "navigate", dir: "right" }],
    ["j", key("j"), { type: "navigate", dir: "down" }],
    ["k", key("k"), { type: "navigate", dir: "up" }],
    ["left", key("left", { sequence: "\u001b[D" }), { type: "navigate", dir: "left" }],
    ["right", key("right", { sequence: "\u001b[C" }), { type: "navigate", dir: "right" }],
    ["down", key("down", { sequence: "\u001b[B" }), { type: "navigate", dir: "down" }],
    ["up", key("up", { sequence: "\u001b[A" }), { type: "navigate", dir: "up" }],
    ["1", key("1"), { type: "moveTo", quadrant: 1 }],
    ["2", key("2"), { type: "moveTo", quadrant: 2 }],
    ["3", key("3"), { type: "moveTo", quadrant: 3 }],
    ["4", key("4"), { type: "moveTo", quadrant: 4 }],
    ["a", key("a"), { type: "startAdd" }],
    ["x", key("x"), { type: "toggleDone" }],
    ["d", key("d"), { type: "requestDelete" }],
    ["J", upper("J"), { type: "reorder", dir: 1 }],
    ["K", upper("K"), { type: "reorder", dir: -1 }],
    [".", key("."), { type: "toggleShowDone" }],
    ["?", key("?"), { type: "help" }],
    ["q", key("q"), { type: "quit" }],
    ["ctrl+c", key("c", { ctrl: true, sequence: "\u0003" }), { type: "quit" }],
    ["e", key("e"), { type: "edit" }],
    ["i", key("i"), { type: "triage" }],
    ["/", key("/"), { type: "search" }],
    ["escape", key("escape", { sequence: "\u001b" }), { type: "cancel" }],
    ["unbound", key("z"), { type: "noop" }],
  ];
  for (const [label, k, action] of cases) {
    test(`${label} → ${action.type}`, () => {
      expect(keyToAction(s, k)).toEqual(action);
    });
  }

  test("J and K are recognised by the sequence too", () => {
    expect(keyToAction(s, key("J"))).toEqual({ type: "reorder", dir: 1 });
    expect(keyToAction(s, key("K"))).toEqual({ type: "reorder", dir: -1 });
  });

  test("a shifted letter is not its lowercase action", () => {
    expect(keyToAction(s, upper("X"))).toEqual({ type: "noop" });
    expect(keyToAction(s, upper("Q"))).toEqual({ type: "noop" });
  });
});

describe("keyToAction in the other modes", () => {
  test("add mode: printable keys type, Backspace erases, Enter submits, Esc cancels", () => {
    const s = state({ mode: "add" });
    expect(keyToAction(s, key("q"))).toEqual({ type: "inputChar", text: "q" });
    expect(keyToAction(s, upper("J"))).toEqual({ type: "inputChar", text: "J" });
    expect(keyToAction(s, key("space", { sequence: " " }))).toEqual({ type: "inputChar", text: " " });
    expect(keyToAction(s, key("#", { sequence: "#" }))).toEqual({ type: "inputChar", text: "#" });
    expect(keyToAction(s, key("ñ", { sequence: "ñ" }))).toEqual({ type: "inputChar", text: "ñ" });
    expect(keyToAction(s, key("backspace", { sequence: "\u007f" }))).toEqual({ type: "inputBackspace" });
    expect(keyToAction(s, key("return", { sequence: "\r" }))).toEqual({ type: "submitAdd" });
    expect(keyToAction(s, key("escape", { sequence: "\u001b" }))).toEqual({ type: "cancel" });
    expect(keyToAction(s, key("up", { sequence: "\u001b[A" }))).toEqual({ type: "noop" });
    expect(keyToAction(s, key("w", { ctrl: true, sequence: "\u0017" }))).toEqual({ type: "noop" });
    expect(keyToAction(s, key("c", { ctrl: true, sequence: "\u0003" }))).toEqual({ type: "quit" });
  });

  test("confirmDelete mode: y confirms, n and Esc cancel, anything else is ignored", () => {
    const s = state({ mode: "confirmDelete" });
    expect(keyToAction(s, key("y"))).toEqual({ type: "confirmDelete" });
    expect(keyToAction(s, key("n"))).toEqual({ type: "cancel" });
    expect(keyToAction(s, key("escape", { sequence: "\u001b" }))).toEqual({ type: "cancel" });
    expect(keyToAction(s, key("d"))).toEqual({ type: "noop" });
    expect(keyToAction(s, key("q"))).toEqual({ type: "noop" });
  });

  test("help mode: ?, q and Esc close it, other keys do nothing", () => {
    const s = state({ mode: "help" });
    expect(keyToAction(s, key("?"))).toEqual({ type: "cancel" });
    expect(keyToAction(s, key("q"))).toEqual({ type: "cancel" });
    expect(keyToAction(s, key("escape", { sequence: "\u001b" }))).toEqual({ type: "cancel" });
    expect(keyToAction(s, key("x"))).toEqual({ type: "noop" });
    expect(keyToAction(s, key("1"))).toEqual({ type: "noop" });
  });
});

describe("reduce: navigation", () => {
  const p = panes([1, 2, 3], [4], [5, 6], []);

  test("h/l move between left and right panes in the same row", () => {
    let s = state();
    s = press(s, key("l"), p);
    expect(s.focus).toBe(2);
    s = press(s, key("l"), p);
    expect(s.focus).toBe(2);
    s = press(s, key("h"), p);
    expect(s.focus).toBe(1);
    s = press(s, key("h"), p);
    expect(s.focus).toBe(1);
    s = press(state({ focus: 3 }), key("l"), p);
    expect(s.focus).toBe(4);
    s = press(s, key("h"), p);
    expect(s.focus).toBe(3);
  });

  test("h/l keep each pane's own selection, clamped", () => {
    const s = press(state({ focus: 1, selected: { 1: 2, 2: 5, 3: 1, 4: 0 } }), key("l"), p);
    expect(s.focus).toBe(2);
    expect(s.selected[2]).toBe(0);
    expect(s.selected[1]).toBe(2);
  });

  test("j/k move the selection inside the pane", () => {
    let s = state();
    s = press(s, key("j"), p);
    expect(s.selected[1]).toBe(1);
    s = press(s, key("down", { sequence: "\u001b[B" }), p);
    expect(s.selected[1]).toBe(2);
    s = press(s, key("k"), p);
    expect(s.selected[1]).toBe(1);
    s = press(s, key("up", { sequence: "\u001b[A" }), p);
    expect(s.selected[1]).toBe(0);
  });

  test("j at the bottom edge crosses to the pane below, at its first task", () => {
    const s = press(state({ focus: 1, selected: { 1: 2, 2: 0, 3: 1, 4: 0 } }), key("j"), p);
    expect(s.focus).toBe(3);
    expect(s.selected[3]).toBe(0);
  });

  test("k at the top edge crosses to the pane above, at its last task", () => {
    const s = press(state({ focus: 3, selected: { 1: 0, 2: 0, 3: 0, 4: 0 } }), key("k"), p);
    expect(s.focus).toBe(1);
    expect(s.selected[1]).toBe(2);
  });

  test("an empty pane crosses at once; the outer edges stay put", () => {
    let s = press(state({ focus: 4 }), key("k"), p);
    expect(s.focus).toBe(2);
    s = press(state({ focus: 4 }), key("j"), p);
    expect(s.focus).toBe(4);
    s = press(state({ focus: 1 }), key("k"), p);
    expect(s.focus).toBe(1);
    expect(s.selected[1]).toBe(0);
    s = press(state({ focus: 3, selected: { 1: 0, 2: 0, 3: 1, 4: 0 } }), key("j"), p);
    expect(s.focus).toBe(3);
    expect(s.selected[3]).toBe(1);
  });

  test("navigation clears the status message", () => {
    const s = press(state({ status: "hello" }), key("j"), p);
    expect(s.status).toBeNull();
  });
});

describe("reduce: modes", () => {
  const p = panes([1, 2], [], [], []);

  test("a opens the add input; typing, Backspace and Esc", () => {
    let s = press(state(), key("a"), p);
    expect(s.mode).toBe("add");
    expect(s.input).toBe("");
    for (const ch of "Pay #rent") s = press(s, key(ch === " " ? "space" : ch, { sequence: ch }), p);
    expect(s.input).toBe("Pay #rent");
    s = press(s, key("backspace", { sequence: "\u007f" }), p);
    expect(s.input).toBe("Pay #ren");
    s = press(s, key("escape", { sequence: "\u001b" }), p);
    expect(s.mode).toBe("normal");
    expect(s.input).toBe("");
  });

  test("Backspace removes a whole character, not half a surrogate pair", () => {
    const s = reduce(state({ mode: "add", input: "ok 🔥" }), { type: "inputBackspace" }, p);
    expect(s.input).toBe("ok ");
  });

  test("Enter in add mode returns to normal and clears the input", () => {
    const s = press(state({ mode: "add", input: "Call mom" }), key("return", { sequence: "\r" }), p);
    expect(s.mode).toBe("normal");
    expect(s.input).toBe("");
  });

  test("d asks for confirmation; n and Esc cancel; y confirms", () => {
    let s = press(state(), key("d"), p);
    expect(s.mode).toBe("confirmDelete");
    expect(press(s, key("n"), p).mode).toBe("normal");
    expect(press(s, key("escape", { sequence: "\u001b" }), p).mode).toBe("normal");
    s = press(s, key("y"), p);
    expect(s.mode).toBe("normal");
  });

  test("d on an empty pane does not ask and says why", () => {
    const s = press(state({ focus: 2 }), key("d"), p);
    expect(s.mode).toBe("normal");
    expect(s.status).toBe("Nothing selected");
  });

  test("? opens help, Esc closes it", () => {
    let s = press(state(), key("?"), p);
    expect(s.mode).toBe("help");
    s = press(s, key("escape", { sequence: "\u001b" }), p);
    expect(s.mode).toBe("normal");
  });

  test(". toggles showDone", () => {
    let s = press(state(), key("."), p);
    expect(s.showDone).toBe(true);
    s = press(s, key("."), p);
    expect(s.showDone).toBe(false);
  });

  test("/ opens the search input (S19)", () => {
    const s = press(state(), key("/"), p);
    expect(s.mode).toBe("search");
    expect(s.status).toBeNull();
  });

  test("q sets quit", () => {
    expect(press(state(), key("q"), p).quit).toBe(true);
  });

  test("effect actions leave the view where it is", () => {
    const s = state({ selected: { 1: 1, 2: 0, 3: 0, 4: 0 } });
    for (const action of [
      { type: "moveTo", quadrant: 3 },
      { type: "toggleDone" },
      { type: "reorder", dir: 1 },
      { type: "edit" },
    ] as const) {
      const next = reduce(s, action, p);
      expect(next.focus).toBe(1);
      expect(next.selected[1]).toBe(1);
      expect(next.mode).toBe("normal");
      expect(next.status).toBeNull();
    }
  });
});

describe("selection helpers", () => {
  test("clamp keeps every pane's selection inside its list", () => {
    const s = clamp(state({ selected: { 1: 5, 2: 3, 3: -1, 4: 0 } }), panes([1, 2], [], [3], []));
    expect(s.selected).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0 });
  });

  test("selectedId returns the focused pane's task, or null", () => {
    const p = panes([1, 2], [], [], []);
    expect(selectedId(state({ selected: { 1: 1, 2: 0, 3: 0, 4: 0 } }), p)).toBe(2);
    expect(selectedId(state({ focus: 2 }), p)).toBeNull();
  });

  test("follow selects the task where it now is in the focused pane, else clamps", () => {
    const p = panes([7, 8, 9]);
    expect(follow(state({ selected: { 1: 0, 2: 0, 3: 0, 4: 0 } }), p, 9).selected[1]).toBe(2);
    expect(follow(state({ selected: { 1: 5, 2: 0, 3: 0, 4: 0 } }), p, 42).selected[1]).toBe(2);
  });
});

describe("triage (S12)", () => {
  const p = panes([1, 2], [3], [], []);
  const inbox = items(10, 11, 12);
  const esc = key("escape", { sequence: "\u001b" });

  // press() with the Inbox passed to the reducer.
  function tpress(s: ViewState, k: Key, box = inbox): ViewState {
    return reduce(s, keyToAction(s, k), p, box);
  }
  function startTriage(box = inbox): ViewState {
    return tpress(state(), key("i"), box);
  }

  test("i starts a session over the Inbox, in order, at the first task", () => {
    const s = startTriage();
    expect(s.mode).toBe("triage");
    expect(s.triage).toEqual({ queue: [10, 11, 12], index: 0, sorted: 0, skipped: 0, deleted: 0 });
    expect(currentId(s, p)).toBe(10);
  });

  test("i with an empty Inbox stays in the matrix and says so", () => {
    const s = startTriage([]);
    expect(s.mode).toBe("normal");
    expect(s.triage).toBeNull();
    expect(s.status).toMatch(/Inbox is empty/);
  });

  test("keyToAction in triage mode", () => {
    const s = startTriage();
    const cases: [Key, Action][] = [
      [key("1"), { type: "moveTo", quadrant: 1 }],
      [key("2"), { type: "moveTo", quadrant: 2 }],
      [key("3"), { type: "moveTo", quadrant: 3 }],
      [key("4"), { type: "moveTo", quadrant: 4 }],
      [key("s"), { type: "skip" }],
      [key("e"), { type: "edit" }],
      [key("d"), { type: "requestDelete" }],
      [esc, { type: "exitTriage" }],
      [key("q"), { type: "exitTriage" }],
      [key("?"), { type: "help" }],
      [key("c", { ctrl: true, sequence: "\u0003" }), { type: "quit" }],
      // Matrix keys do nothing while a card is shown.
      [key("j"), { type: "noop" }],
      [key("x"), { type: "noop" }],
      [key("a"), { type: "noop" }],
      [key("i"), { type: "noop" }],
      [upper("S"), { type: "noop" }],
      [upper("J"), { type: "noop" }],
    ];
    for (const [k, action] of cases) expect(keyToAction(s, k)).toEqual(action);
  });

  test("1–4 count the task as sorted and show the next one", () => {
    let s = startTriage();
    s = tpress(s, key("2"));
    expect(s.mode).toBe("triage");
    expect(s.triage).toMatchObject({ index: 1, sorted: 1, skipped: 0 });
    expect(currentId(s, p)).toBe(11);
    s = tpress(s, key("4"));
    expect(currentId(s, p)).toBe(12);
    expect(s.triage!.sorted).toBe(2);
  });

  test("s skips to the next task without sorting it", () => {
    const s = tpress(startTriage(), key("s"));
    expect(s.triage).toMatchObject({ index: 1, sorted: 0, skipped: 1 });
    expect(currentId(s, p)).toBe(11);
  });

  test("e keeps the current task and stays in triage", () => {
    const s = tpress(startTriage(), key("e"));
    expect(s.mode).toBe("triage");
    expect(currentId(s, p)).toBe(10);
  });

  test("d asks; n and Esc go back to the same card; y deletes and shows the next", () => {
    let s = tpress(startTriage(), key("d"));
    expect(s.mode).toBe("confirmDelete");
    expect(currentId(s, p)).toBe(10);
    for (const cancel of [key("n"), esc]) {
      const back = tpress(s, cancel);
      expect(back.mode).toBe("triage");
      expect(currentId(back, p)).toBe(10);
      expect(back.triage!.deleted).toBe(0);
    }
    s = tpress(s, key("y"));
    expect(s.mode).toBe("triage");
    expect(s.triage).toMatchObject({ index: 1, deleted: 1 });
    expect(currentId(s, p)).toBe(11);
  });

  test("? opens help; closing it returns to the card", () => {
    let s = tpress(startTriage(), key("?"));
    expect(s.mode).toBe("help");
    s = tpress(s, esc);
    expect(s.mode).toBe("triage");
    expect(currentId(s, p)).toBe(10);
  });

  test("the last key ends the session with a summary, back in the matrix", () => {
    let s = startTriage();
    s = tpress(s, key("1"));
    s = tpress(s, key("s"));
    s = tpress(s, key("3"));
    expect(s.mode).toBe("normal");
    expect(s.triage).toBeNull();
    expect(s.quit).toBe(false);
    expect(s.status).toBe("Inbox triaged: 2 sorted, 1 skipped");
    expect(currentId(s, p)).toBe(selectedId(s, p));
  });

  test("the summary mentions deletions when there were any", () => {
    let s = startTriage(items(10));
    s = tpress(s, key("d"), items(10));
    s = tpress(s, key("y"), items(10));
    expect(s.mode).toBe("normal");
    expect(s.status).toBe("Inbox triaged: 0 sorted, 0 skipped, 1 deleted");
  });

  test("Esc and q leave triage early without quitting and say what is left", () => {
    for (const k of [esc, key("q")]) {
      let s = tpress(startTriage(), key("2"));
      s = tpress(s, k);
      expect(s.mode).toBe("normal");
      expect(s.triage).toBeNull();
      expect(s.quit).toBe(false);
      expect(s.status).toBe("Triage stopped: 1 sorted, 0 skipped, 2 left in the Inbox");
    }
  });

  test("a session visits each task at most once: tasks added later are not in the queue", () => {
    let s = startTriage(items(10));
    s = tpress(s, key("s"), items(10, 99));
    expect(s.mode).toBe("normal");
    expect(s.status).toBe("Inbox triaged: 0 sorted, 1 skipped");
  });

  test("syncTriage skips queued tasks that left the Inbox and ends when none remain", () => {
    const s = startTriage();
    expect(syncTriage(s, items(10, 11, 12))).toEqual(s);
    const moved = syncTriage(s, items(12));
    expect(currentId(moved, p)).toBe(12);
    expect(moved.triage).toMatchObject({ index: 2, sorted: 0, skipped: 0 });
    const gone = syncTriage(s, []);
    expect(gone.mode).toBe("normal");
    expect(gone.triage).toBeNull();
    expect(gone.status).toBe("Inbox triaged: 0 sorted, 0 skipped");
    expect(syncTriage(state(), [])).toEqual(state());
  });

  test("offerTriage puts the offer in the status line only when the Inbox has tasks", () => {
    expect(offerTriage(state(), 8).status).toBe("press i to triage");
    expect(offerTriage(state(), 0).status).toBeNull();
  });
});

describe("search (S19)", () => {
  const esc = key("escape", { sequence: "\u001b" });
  const enter = key("return", { sequence: "\r" });
  const backspace = key("backspace", { sequence: "\u007f" });
  // Panes while a search is active: the Inbox strip is a fifth pane.
  function searchPanes(q1: number[], q2: number[], q3: number[], q4: number[], inbox: number[]): PaneItems {
    return { ...panes(q1, q2, q3, q4), inbox: items(...inbox) };
  }
  function type(s: ViewState, text: string, p: PaneItems): ViewState {
    for (const ch of text) s = press(s, key(ch === " " ? "space" : ch, { sequence: ch }), p);
    return s;
  }

  test("in the search input every printable key types, global keys included", () => {
    const s = state({ mode: "search" });
    for (const ch of ["q", "x", "d", "1", "i", "/", ".", "?", "a", "e", "j", "#", "ñ"]) {
      expect(keyToAction(s, key(ch, { sequence: ch }))).toEqual({ type: "searchInput", text: ch });
    }
    expect(keyToAction(s, upper("J"))).toEqual({ type: "searchInput", text: "J" });
    expect(keyToAction(s, key("space", { sequence: " " }))).toEqual({ type: "searchInput", text: " " });
    expect(keyToAction(s, backspace)).toEqual({ type: "searchBackspace" });
    expect(keyToAction(s, enter)).toEqual({ type: "submitSearch" });
    expect(keyToAction(s, esc)).toEqual({ type: "clearSearch" });
    expect(keyToAction(s, key("up", { sequence: "\u001b[A" }))).toEqual({ type: "noop" });
    expect(keyToAction(s, key("c", { ctrl: true, sequence: "\u0003" }))).toEqual({ type: "quit" });
  });

  test("typing edits the query live; Backspace removes a whole character", () => {
    const p = panes([1]);
    let s = press(state(), key("/"), p);
    s = type(s, "zoho 🔥", p);
    expect(s.query).toBe("zoho 🔥");
    s = press(s, backspace, p);
    expect(s.query).toBe("zoho ");
    expect(s.mode).toBe("search");
  });

  test("typing resets every pane's selection to its best match", () => {
    const p = searchPanes([1, 2, 3], [], [], [], [4, 5]);
    const s = press(state({ mode: "search", query: "a", selected: { 1: 2, 2: 0, 3: 0, 4: 0, inbox: 1 } }), key("b"), p);
    expect(s.selected).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, inbox: 0 });
  });

  test("Enter keeps the filter and returns to normal navigation", () => {
    const s = press(state({ mode: "search", query: "zoho" }), enter, panes([1]));
    expect(s.mode).toBe("normal");
    expect(s.query).toBe("zoho");
    expect(searchActive(s)).toBe(true);
    // Global keys act again, on the filtered panes.
    expect(keyToAction(s, key("2"))).toEqual({ type: "moveTo", quadrant: 2 });
    expect(keyToAction(s, key("x"))).toEqual({ type: "toggleDone" });
  });

  test("Enter on a blank query ends the search", () => {
    const s = press(state({ mode: "search", query: "   ", focus: "inbox" }), enter, panes([1]));
    expect(s.mode).toBe("normal");
    expect(s.query).toBe("");
    expect(searchActive(s)).toBe(false);
    expect(s.focus).toBe(1);
  });

  test("Esc clears the filter, from the input or from normal navigation", () => {
    const p = panes([1]);
    let s = press(state({ mode: "search", query: "zoho" }), esc, p);
    expect(s).toMatchObject({ mode: "normal", query: "" });
    s = state({ query: "zoho", focus: "inbox" });
    expect(keyToAction(s, esc)).toEqual({ type: "clearSearch" });
    s = press(s, esc, p);
    expect(s).toMatchObject({ mode: "normal", query: "", focus: 1 });
    // Without a filter Esc stays a plain cancel.
    expect(keyToAction(state(), esc)).toEqual({ type: "cancel" });
  });

  test("/ again edits the query, prefilled", () => {
    const s = press(state({ query: "zoho" }), key("/"), panes([1]));
    expect(s).toMatchObject({ mode: "search", query: "zoho" });
  });

  test("searchActive: while typing, or while a non-blank query is kept", () => {
    expect(searchActive(state())).toBe(false);
    expect(searchActive(state({ mode: "search" }))).toBe(true);
    expect(searchActive(state({ query: "x" }))).toBe(true);
    expect(searchActive(state({ query: "  " }))).toBe(false);
  });

  test("j from the bottom panes goes into the Inbox strip; k at its top comes back to Q3", () => {
    const p = searchPanes([1], [2], [3, 4], [], [5, 6]);
    let s = press(state({ query: "x", focus: 3, selected: { 1: 0, 2: 0, 3: 1, 4: 0 } }), key("j"), p);
    expect(s.focus).toBe("inbox");
    expect(s.selected.inbox).toBe(0);
    expect(selectedId(s, p)).toBe(5);
    s = press(s, key("j"), p);
    expect(selectedId(s, p)).toBe(6);
    s = press(s, key("j"), p);
    expect(selectedId(s, p)).toBe(6); // the strip is the bottom edge
    s = press(s, key("k"), p);
    s = press(s, key("k"), p);
    expect(s.focus).toBe(3);
    expect(s.selected[3]).toBe(1);
    // An empty Q4 crosses at once.
    s = press(state({ query: "x", focus: 4 }), key("j"), p);
    expect(s.focus).toBe("inbox");
    // h/l do nothing in the strip.
    expect(press(s, key("h"), p).focus).toBe("inbox");
    expect(press(s, key("l"), p).focus).toBe("inbox");
  });

  test("without the strip (no search) j at the bottom stays put", () => {
    const s = press(state({ focus: 3 }), key("j"), panes([1], [2], [3], []));
    expect(s.focus).toBe(3);
  });

  test("actions apply to the selected Inbox match", () => {
    const p = searchPanes([], [], [], [], [5, 6]);
    const s = state({ query: "x", focus: "inbox", selected: { 1: 0, 2: 0, 3: 0, 4: 0, inbox: 1 } });
    expect(currentId(s, p)).toBe(6);
    expect(press(s, key("d"), p).mode).toBe("confirmDelete");
    expect(follow(s, p, 5).selected.inbox).toBe(0);
    expect(clamp(state({ focus: "inbox", selected: { 1: 0, 2: 0, 3: 0, 4: 0, inbox: 9 } }), p).selected.inbox).toBe(1);
  });

  test("focusMatches moves the focus to the first pane with matches when the focused one has none", () => {
    const p = searchPanes([], [], [3], [], [5]);
    expect(focusMatches(state({ query: "x", focus: 1 }), p).focus).toBe(3);
    expect(focusMatches(state({ query: "x", focus: 3 }), p).focus).toBe(3);
    expect(focusMatches(state({ query: "x", focus: 2 }), searchPanes([], [], [], [], [5])).focus).toBe("inbox");
    // Nothing matches anywhere: the focus stays.
    expect(focusMatches(state({ query: "x", focus: 2 }), searchPanes([], [], [], [], [])).focus).toBe(2);
  });
});
