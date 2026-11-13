import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { osaDistance, prepareSearch, search } from "../../src/domain/search.ts";
import type { Task } from "../../src/domain/task.ts";
import { parseMarkdown } from "../../src/import/markdown.ts";

const fixture = readFileSync(join(import.meta.dir, "../../fixtures/import/user-tasks.md"), "utf8");

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    description: null,
    important: null,
    urgent: null,
    dueDate: null,
    tags: [],
    status: "open",
    position: id,
    createdAt: "2026-11-12T00:00:00Z",
    updatedAt: "2026-11-12T00:00:00Z",
    completedAt: null,
    ...over,
  };
}

/** The user's fixture as Task objects, all in the Inbox (S15). */
function fixtureTasks(): Task[] {
  return parseMarkdown(fixture).items.map((item, i) =>
    task(i + 1, { title: item.title, description: item.description, tags: item.tags, status: item.status }),
  );
}

const titles = (tasks: Task[], query: string) => search(tasks, query).map((m) => m.task.title);

describe("search on the user's fixture (S19)", () => {
  const tasks = fixtureTasks();

  test("the fixture has the 8 tasks the cases below rely on", () => {
    expect(tasks).toHaveLength(8);
    expect(tasks.every((t) => t.important === null && t.urgent === null)).toBe(true);
  });

  test("delvira finds the Delivra task (typo, transposition)", () => {
    const found = search(tasks, "delvira");
    expect(found.map((m) => m.task.title)).toEqual(["en delivra montar los sigueintes features:"]);
    expect(found[0]!.fields).toEqual(["title"]);
  });

  test("compañía finds the company-deletion task (accents and case)", () => {
    expect(titles(tasks, "compañía")).toEqual([
      "cuando se elimina una compania , generar parquet zip con adjuntos Sergio , desactivar organizacion o caompania",
    ]);
    expect(titles(tasks, "COMPAÑÍA")).toHaveLength(1);
  });

  test("#zoho finds only the tag match", () => {
    const found = search(tasks, "#zoho");
    expect(found).toHaveLength(1);
    expect(found[0]!.task.tags).toContain("zoho");
    expect(found[0]!.fields).toEqual(["tags"]);
  });

  test("#word matches tags by prefix only, never title or description text", () => {
    expect(titles(tasks, "#zo")).toHaveLength(1);
    // "rainer" is a tag of one task; "Rainer" is plain text in another's description.
    expect(titles(tasks, "#rainer")).toEqual([
      "provide new meta permissions integration description for sending messages #instagram and #messenger",
    ]);
    // "configured" is only in a title, never a tag.
    expect(titles(tasks, "#configured")).toEqual([]);
  });

  test("rainer finds the #rainer task and the STASH task whose description mentions Rainer", () => {
    const found = titles(tasks, "rainer");
    expect(found).toHaveLength(2);
    expect(found).toContain("provide new meta permissions integration description for sending messages #instagram and #messenger");
    expect(found).toContain("Create epic for cloudbeds new integration");
  });

  test("vacations finds the task while it is still in the Inbox", () => {
    const found = search(tasks, "vacations");
    expect(found.map((m) => m.task.title)).toEqual(["aporove #vacations request from #david"]);
    expect(found[0]!.task.important).toBeNull();
  });

  test("a done task is found and comes back with status done", () => {
    const withDone = [...tasks, task(99, { title: "Renew the zoho certificate", status: "done" })];
    const found = search(withDone, "certificate");
    expect(found).toHaveLength(1);
    expect(found[0]!.task.status).toBe("done");
  });

  test("every token must match: zoho prod finds one task, zoho stash none", () => {
    expect(titles(tasks, "zoho prod")).toEqual([
      "test prod new activities integration for #zoho all activities should be already configured bridge --> CRM",
    ]);
    expect(titles(tasks, "zoho stash")).toEqual([]);
  });

  test("tokens under 4 characters match only by substring, never by typo", () => {
    // "ad" is a substring of "adjuntos" and "Add": found by substring.
    expect(titles(tasks, "ad").length).toBeGreaterThan(0);
    // "zx" and "qzo" are within distance 1-2 of many short words but must not fuzzy-match.
    expect(titles(tasks, "zx")).toEqual([]);
    expect(titles(tasks, "zoh")).toHaveLength(1); // substring of "zoho"
    expect(titles(tasks, "zohx")).toHaveLength(1); // 4 chars: distance 1 from "zoho"
    expect(titles(tasks, "zhx")).toEqual([]);
  });

  test("typo budget: 1 edit for 4-7 characters, 2 edits for 8 or more", () => {
    expect(titles(tasks, "cloudbedz")).toHaveLength(1); // 9 chars, 1 edit
    expect(titles(tasks, "cluodbedz")).toHaveLength(1); // 9 chars, 2 edits (transposition + substitution)
    expect(titles(tasks, "clxudbedz")).toHaveLength(1); // 2 substitutions
    expect(titles(tasks, "clxxdbedz")).toEqual([]); // 3 edits
    expect(titles(tasks, "zxhx")).toEqual([]); // 4 chars, 2 edits from "zoho"
  });

  test("empty or whitespace query: no filter, every task in input order", () => {
    expect(search(tasks, "").map((m) => m.task.id)).toEqual(tasks.map((t) => t.id));
    expect(search(tasks, "   ").map((m) => m.task.id)).toEqual(tasks.map((t) => t.id));
  });

  test("a prepared index gives the same results as the raw list", () => {
    const index = prepareSearch(tasks);
    for (const q of ["rainer", "delvira", "#zoho", "zoho prod", ""]) {
      expect(search(index, q).map((m) => m.task.id)).toEqual(search(tasks, q).map((m) => m.task.id));
    }
  });
});

describe("ranking (S19)", () => {
  test("a title match outranks a description-only match", () => {
    const tasks = [
      task(1, { title: "Call the team", description: "about the budget" }),
      task(2, { title: "Budget review" }),
    ];
    const found = search(tasks, "budget");
    expect(found.map((m) => m.task.id)).toEqual([2, 1]);
    expect(found[0]!.fields).toEqual(["title"]);
    expect(found[1]!.fields).toEqual(["description"]);
    expect(found[0]!.score).toBeGreaterThan(found[1]!.score);
  });

  test("title > tag > description", () => {
    const tasks = [
      task(1, { title: "x", description: "plan" }),
      task(2, { title: "y", tags: ["plan"] }),
      task(3, { title: "plan" }),
    ];
    expect(search(tasks, "plan").map((m) => m.task.id)).toEqual([3, 2, 1]);
  });

  test("exact word > prefix > substring > fuzzy, inside the same field", () => {
    const tasks = [
      task(1, { title: "Pant the fence" }), // fuzzy: "pant" is 1 edit from "paint"
      task(2, { title: "Paintings for the hall" }), // prefix of a word
      task(3, { title: "Paint the door" }), // exact word
      task(4, { title: "Repaint the door" }), // inside a word
    ];
    const found = search(tasks, "paint");
    expect(found.map((m) => m.task.id)).toEqual([3, 2, 4, 1]);
    const scores = found.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(4);
  });

  test("open before done, then position and id as a stable tiebreak", () => {
    const tasks = [
      task(1, { title: "report", status: "done", position: 0 }),
      task(2, { title: "report", position: 5 }),
      task(3, { title: "report", position: 1 }),
      task(4, { title: "report", position: 1 }),
    ];
    expect(search(tasks, "report").map((m) => m.task.id)).toEqual([3, 4, 2, 1]);
  });

  test("fields lists every field any token matched, in title, tags, description order", () => {
    const tasks = [task(1, { title: "Ship the zoho bridge", tags: ["zoho"], description: "zoho CRM" })];
    expect(search(tasks, "zoho")[0]!.fields).toEqual(["title", "tags", "description"]);
    expect(search(tasks, "bridge crm")[0]!.fields).toEqual(["title", "description"]);
  });
});

describe("osaDistance", () => {
  test.each([
    ["delivra", "delvira", 1],
    ["abc", "abc", 0],
    ["abc", "acb", 1],
    ["kitten", "sitting", 3],
    ["", "abc", 3],
    ["ca", "abc", 3], // optimal string alignment, not unrestricted Damerau
  ])("%s ~ %s = %d", (a, b, d) => {
    expect(osaDistance(a, b, 10)).toBe(d);
  });

  test("stops early and returns max + 1 once the distance exceeds max", () => {
    expect(osaDistance("abcdefgh", "zyxwvuts", 2)).toBe(3);
  });
});

describe("performance (S19: under 16 ms locally, 50 ms in CI)", () => {
  const words = ["deploy", "invoice", "review", "meeting", "client", "budget", "zoho", "webhook", "integration", "release",
    "design", "report", "server", "backup", "contract", "hiring", "roadmap", "support", "migration", "dashboard"];
  const tasks: Task[] = [];
  let seed = 42;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let i = 1; i <= 5000; i++) {
    const title = Array.from({ length: 4 + rand(6) }, () => words[rand(words.length)]).join(" ");
    const description = rand(2) ? Array.from({ length: 10 + rand(20) }, () => words[rand(words.length)]).join(" ") : null;
    tasks.push(task(i, { title: `${title} ${i}`, description, tags: [words[rand(words.length)]!], status: rand(5) ? "open" : "done" }));
  }

  test.each(["zoho", "migratoin", "#web", "client budget", "dashbaord review", "nothingmatches"])(
    "5,000 tasks, query %p",
    (query) => {
      search(tasks, query); // warm up the JIT
      const runs = 5;
      const start = performance.now();
      for (let i = 0; i < runs; i++) search(tasks, query);
      const ms = (performance.now() - start) / runs;
      console.log(`search 5,000 tasks ${JSON.stringify(query)}: ${ms.toFixed(2)} ms`);
      expect(ms).toBeLessThan(50);
    },
  );
});
