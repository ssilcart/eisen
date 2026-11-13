import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { TaskRepository } from "../../src/store/repository.ts";
import { parseMarkdown } from "../../src/import/markdown.ts";
import { exportMarkdown } from "../../src/import/export.ts";
import { importMarkdown } from "../../src/import/importer.ts";
import { bucketOf } from "../../src/domain/task.ts";

const fixture = await Bun.file(join(import.meta.dir, "../../fixtures/import/user-tasks.md")).text();

function freshRepo() {
  return new TaskRepository(openDb(":memory:"));
}

describe("parser (S14)", () => {
  test("open, done, sections, descriptions and unknown lines", () => {
    const { items, warnings } = parseMarkdown(
      [
        "# 🔥 TO-DO",
        "- [ ] first #a",
        "  > line one",
        "  > line two #b",
        "- [x] finished",
        "random text",
        "---",
        "# Notes",
        "* [ ] star bullet",
      ].join("\n"),
    );
    expect(items).toEqual([
      { title: "first #a", description: "line one\nline two #b", tags: ["todo", "a", "b"], status: "open", quadrant: null, dueDate: null },
      { title: "finished", description: null, tags: ["todo"], status: "done", quadrant: null, dueDate: null },
      { title: "star bullet", description: null, tags: ["notes"], status: "open", quadrant: null, dueDate: null },
    ]);
    expect(warnings).toEqual([{ line: 6, message: 'Unrecognised line ignored: "random text"' }]);
  });

  test("a quote with no task before it is a warning", () => {
    expect(parseMarkdown("> orphan").warnings).toEqual([{ line: 1, message: 'Description without a task ignored: "> orphan"' }]);
  });

  test("export headings and metadata comments", () => {
    const { items } = parseMarkdown(
      ["# Q2 · Schedule", "- [ ] plan <!-- eisen: due=2026-12-01 tags=x,y -->", "# Inbox", "- [ ] later"].join("\n"),
    );
    expect(items).toEqual([
      { title: "plan", description: null, tags: ["x", "y"], status: "open", quadrant: 2, dueDate: "2026-12-01" },
      { title: "later", description: null, tags: [], status: "open", quadrant: null, dueDate: null },
    ]);
  });
});

describe("the user's file (S15)", () => {
  const { items, warnings } = parseMarkdown(fixture);
  const byTitle = (prefix: string) => items.find((i) => i.title.startsWith(prefix))!;

  test("8 open tasks: 5 todo, 3 stash, no warnings", () => {
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(8);
    expect(items.every((i) => i.status === "open" && i.quadrant === null)).toBe(true);
    expect(items.filter((i) => i.tags[0] === "todo")).toHaveLength(5);
    expect(items.filter((i) => i.tags[0] === "stash")).toHaveLength(3);
  });

  test("descriptions and tags", () => {
    expect(byTitle("en delivra").title).toBe("en delivra montar los sigueintes features:");
    expect(byTitle("en delivra").description).toBe("poder organizar los subitems");
    const meta = byTitle("provide new meta");
    expect(meta.title).toBe("provide new meta permissions integration description for sending messages #instagram and #messenger");
    expect(meta.tags).toEqual(["todo", "instagram", "messenger", "rainer"]);
    expect(meta.description).toBe("send to #rainer description for prototype record");
    expect(byTitle("Add #opt-in").tags).toEqual(["stash", "opt-in", "webhook"]);
  });

  test("imports into the Inbox", () => {
    const repo = freshRepo();
    const report = importMarkdown(repo, fixture);
    expect(report.created).toBe(8);
    expect(repo.list({ bucket: "inbox" })).toHaveLength(8);
  });
});

describe("re-import (S16)", () => {
  test("importing twice leaves 8 tasks and reports 8 skipped", () => {
    const repo = freshRepo();
    importMarkdown(repo, fixture);
    const second = importMarkdown(repo, fixture);
    expect(second.created).toBe(0);
    expect(second.skipped).toHaveLength(8);
    expect(repo.list()).toHaveLength(8);
  });
});

describe("export (S13)", () => {
  test("export | import reproduces the same tasks", () => {
    const a = freshRepo();
    importMarkdown(a, fixture);
    const [t1, t2, t3] = a.list();
    a.move(t1!.id, 1);
    a.move(t2!.id, 4);
    a.update(t2!.id, { dueDate: "2026-12-01", tags: [...t2!.tags, "extra"] });
    a.toggleDone(t3!.id);

    const b = freshRepo();
    const report = importMarkdown(b, exportMarkdown(a.list({ status: "all" })));
    expect(report.warnings).toEqual([]);
    const shape = (r: TaskRepository) =>
      r
        .list({ status: "all" })
        .map((t) => ({ title: t.title, description: t.description, tags: t.tags, bucket: bucketOf(t), due: t.dueDate, status: t.status }))
        .sort((x, y) => x.title.localeCompare(y.title));
    expect(shape(b)).toEqual(shape(a));
  });

  test("groups by quadrant then Inbox", () => {
    const repo = freshRepo();
    repo.create({ title: "inbox one" });
    repo.create({ title: "do it", quadrant: 1 });
    expect(exportMarkdown(repo.list())).toBe("# Q1 · Do\n\n- [ ] do it\n\n# Inbox\n\n- [ ] inbox one\n");
  });
});
