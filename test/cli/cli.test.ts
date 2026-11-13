import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/cli.ts";

let dir: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eisen-cli-"));
  env = { EISEN_DB: join(dir, "eisen.db"), HOME: dir };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    env,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    today: "2026-11-12",
  });
  return { code, stdout, stderr };
}

const fixture = join(import.meta.dir, "../../fixtures/import/user-tasks.md");

describe("add", () => {
  test("no quadrant goes to the Inbox, #tags parsed", () => {
    expect(run("add", "Call the #bank").code).toBe(0);
    const [task] = JSON.parse(run("ls", "--inbox", "--json").stdout);
    expect(task).toMatchObject({ title: "Call the #bank", tags: ["bank"], bucket: "inbox" });
  });

  test("--q2 --due", () => {
    const r = run("add", "plan", "--q2", "--due", "2026-12-01");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Q2 · Schedule");
    const [task] = JSON.parse(run("ls", "--q2", "--json").stdout);
    expect(task).toMatchObject({ title: "plan", dueDate: "2026-12-01", bucket: 2 });
  });

  test.each([
    [["add"], "title"],
    [["add", "x", "--q1", "--q2"], "one quadrant"],
    [["add", "x", "--due", "2026-02-30"], "YYYY-MM-DD"],
    [["add", "x", "--nope"], "nope"],
    [["add", "  "], "title"],
  ])("usage error %p exits 2", (argv, message) => {
    const r = run(...argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
  });
});

describe("ls", () => {
  test("text output, open tasks only, grouped", () => {
    run("add", "first", "--q1");
    run("add", "second");
    run("add", "third", "--q4");
    const r = run("ls");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      ["Q1 · Do", "  1  first", "Q4 · Delete", "  3  third", "Inbox", "  2  second", ""].join("\n"),
    );
  });

  test("escalated tasks are listed where they are shown, with a mark", () => {
    run("add", "soon", "--q2", "--due", "2026-11-13");
    expect(run("ls", "--q2", "--json").stdout).toBe("[]\n");
    const [task] = JSON.parse(run("ls", "--q1", "--json").stdout);
    expect(task).toMatchObject({ title: "soon", bucket: 2, shownIn: 1, escalated: true });
    expect(run("ls").stdout).toContain("  1  soon  due 2026-11-13 !");
  });

  test("two filters is a usage error", () => {
    expect(run("ls", "--q1", "--inbox").code).toBe(2);
  });

  test("empty", () => {
    expect(run("ls").stdout).toBe("No tasks.\n");
  });
});

describe("import / export", () => {
  test("import the fixture, then again", () => {
    const first = run("import", fixture);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Imported 8 tasks");
    const second = run("import", fixture);
    expect(second.stdout).toContain("Imported 0 tasks, skipped 8");
    expect(JSON.parse(run("ls", "--json").stdout)).toHaveLength(8);
  });

  test("warnings go to stderr with their line", () => {
    const file = join(dir, "x.md");
    writeFileSync(file, "- [ ] ok\nnonsense\n");
    const r = run("import", file);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("x.md:2:");
  });

  test("missing file exits 1, missing argument exits 2", () => {
    expect(run("import", join(dir, "nope.md")).code).toBe(1);
    expect(run("import").code).toBe(2);
  });

  test("export | import into an empty DB reproduces the same open tasks", () => {
    run("import", fixture);
    run("add", "scheduled #x", "--q2", "--due", "2026-12-24");
    const exported = run("export").stdout;
    const file = join(dir, "backup.md");
    writeFileSync(file, exported);
    const before = JSON.parse(run("ls", "--json").stdout);
    env = { ...env, EISEN_DB: join(dir, "other.db") };
    expect(run("import", file).code).toBe(0);
    const strip = (ts: any[]) => ts.map(({ id, position, createdAt, updatedAt, ...rest }) => rest);
    expect(strip(JSON.parse(run("ls", "--json").stdout))).toEqual(strip(before));
  });
});

describe("help and errors", () => {
  for (const argv of [["--help"], ["add", "--help"], ["ls", "--help"], ["import", "--help"], ["export", "--help"]]) {
    test(`${argv.join(" ")} prints usage and exits 0`, () => {
      const r = run(...argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Usage: eisen");
    });
  }

  test("the binary entry point passes exit codes through", async () => {
    const main = join(import.meta.dir, "../../src/main.ts");
    const exec = (...argv: string[]) => Bun.spawnSync([process.execPath, main, ...argv], { env: { ...process.env, ...env } });
    expect(exec("add", "from the binary").exitCode).toBe(0);
    expect(exec("add").exitCode).toBe(2);
    expect(exec("--version").stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(exec("ls").stdout.toString()).toContain("from the binary");
  });

  test("unknown command exits 2", () => {
    const r = run("frobnicate");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("frobnicate");
  });
});
