import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { displayBucket, isEscalated, localToday } from "../domain/escalation.ts";
import { bucketOf, isValidDate, QUADRANT_LABELS, QUADRANTS, type Bucket, type Quadrant, type Task } from "../domain/task.ts";
import { parseTags } from "../domain/tags.ts";
import { exportMarkdown } from "../import/export.ts";
import { importMarkdown } from "../import/importer.ts";
import { openDb, resolveDbPath } from "../store/db.ts";
import { TaskRepository } from "../store/repository.ts";

export interface CliIO {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** YYYY-MM-DD, for due-date escalation; defaults to the local date. */
  today?: string;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

class UsageError extends Error {}

const USAGE: Record<string, string> = {
  main: `Usage: eisen [command]

Eisenhower matrix in your terminal. With no command, opens the matrix.

Commands:
  add "<title>"   Add a task (Inbox unless a quadrant is given)
  ls              List tasks
  import <file>   Import a Markdown checklist into the Inbox
  export          Print every task as Markdown (a backup "eisen import" reads)

Options:
  -h, --help      Show help (also after a command)
  -v, --version   Show the version

Data: $EISEN_DB, else $XDG_DATA_HOME/eisen/eisen.db, else ~/.local/share/eisen/eisen.db
`,
  add: `Usage: eisen add "<title>" [--q1|--q2|--q3|--q4] [--due YYYY-MM-DD]

Adds a task. Without a quadrant it goes to the Inbox. #words in the title become tags.
  --q1  Do (important, urgent)        --q2  Schedule (important, not urgent)
  --q3  Delegate (urgent, not important)  --q4  Delete (neither)
  --due YYYY-MM-DD  Due date; tasks due within 2 days are shown as urgent
`,
  ls: `Usage: eisen ls [--q1|--q2|--q3|--q4|--inbox] [--all] [--json]

Lists open tasks grouped by where they are shown (due-soon tasks escalate, marked "!").
  --q1..--q4, --inbox  Only that quadrant or the Inbox
  --all                Include done tasks
  --json               JSON array instead of text
`,
  import: `Usage: eisen import <file.md>

Imports "- [ ]" / "- [x]" items into the Inbox. Headings become tags, indented "> " lines
become the description, and open tasks with the same title are skipped.
`,
  export: `Usage: eisen export

Prints every task as Markdown, grouped by quadrant then Inbox, in the format
"eisen import" reads. Use it as a backup: eisen export > backup.md
`,
};

const QUADRANT_FLAGS = {
  q1: { type: "boolean" },
  q2: { type: "boolean" },
  q3: { type: "boolean" },
  q4: { type: "boolean" },
} as const;

export function runCli(argv: string[], io: CliIO): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "-h":
      case "--help":
        io.stdout(USAGE.main!);
        return EXIT_OK;
      case "add":
      case "ls":
      case "import":
      case "export":
        if (rest.includes("--help") || rest.includes("-h")) {
          io.stdout(USAGE[command]!);
          return EXIT_OK;
        }
        return COMMANDS[command](rest, io);
      default:
        throw new UsageError(`Unknown command "${command}". Run "eisen --help".`);
    }
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.stderr(`eisen: ${(error as Error).message}\n`);
      return EXIT_USAGE;
    }
    io.stderr(`eisen: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
}

function isParseArgsError(error: unknown): boolean {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

function repository(io: CliIO): TaskRepository {
  return new TaskRepository(openDb(resolveDbPath(io.env)));
}

function pickQuadrant(values: Partial<Record<"q1" | "q2" | "q3" | "q4", boolean>>): Quadrant | null {
  const chosen = QUADRANTS.filter((q) => values[`q${q}`]);
  if (chosen.length > 1) throw new UsageError("Pick at most one quadrant (--q1..--q4).");
  return chosen[0] ?? null;
}

const COMMANDS: Record<"add" | "ls" | "import" | "export", (args: string[], io: CliIO) => number> = {
  add(args, io) {
    const { values, positionals } = parseArgs({
      args,
      options: { ...QUADRANT_FLAGS, due: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const title = positionals.join(" ").trim();
    if (!title) throw new UsageError('Missing the task title: eisen add "<title>"');
    const quadrant = pickQuadrant(values);
    if (values.due !== undefined && !isValidDate(values.due)) throw new UsageError(`--due must be a date as YYYY-MM-DD, got "${values.due}".`);
    const task = repository(io).create({ title, quadrant, dueDate: values.due ?? null, tags: parseTags(title) });
    io.stdout(`Added ${task.id} to ${heading(bucketOf(task))}: ${task.title}\n`);
    return EXIT_OK;
  },

  ls(args, io) {
    const { values } = parseArgs({
      args,
      options: { ...QUADRANT_FLAGS, inbox: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" } },
      strict: true,
    });
    const quadrant = pickQuadrant(values);
    if (quadrant !== null && values.inbox) throw new UsageError("Pick one of --q1..--q4 or --inbox.");
    const filter: Bucket | null = values.inbox ? "inbox" : quadrant;
    const today = io.today ?? localToday();
    const order: Bucket[] = [...QUADRANTS, "inbox"];
    const rows = repository(io)
      .list({ status: values.all ? "all" : "open" })
      .map((task) => ({ ...task, bucket: bucketOf(task), shownIn: displayBucket(task, today), escalated: isEscalated(task, today) }))
      .filter((t) => filter === null || t.shownIn === filter)
      .sort(
        (a, b) =>
          order.indexOf(a.shownIn) - order.indexOf(b.shownIn) ||
          Number(a.status === "done") - Number(b.status === "done") ||
          a.position - b.position ||
          a.id - b.id,
      );

    if (values.json) {
      io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
      return EXIT_OK;
    }
    if (rows.length === 0) {
      io.stdout("No tasks.\n");
      return EXIT_OK;
    }
    const lines: string[] = [];
    let current: Bucket | undefined;
    for (const row of rows) {
      if (row.shownIn !== current) {
        current = row.shownIn;
        lines.push(heading(current));
      }
      lines.push(`  ${row.id}  ${describe(row, row.escalated)}`);
    }
    io.stdout(`${lines.join("\n")}\n`);
    return EXIT_OK;
  },

  import(args, io) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
    const [file] = positionals;
    if (!file || positionals.length > 1) throw new UsageError("Usage: eisen import <file.md>");
    const text = readFileSync(file, "utf8");
    const report = importMarkdown(repository(io), text);
    for (const w of report.warnings) io.stderr(`${basename(file)}:${w.line}: ${w.message}\n`);
    let summary = `Imported ${report.created} tasks`;
    if (report.skipped.length) summary += `, skipped ${report.skipped.length} already open`;
    io.stdout(`${summary}.\n`);
    for (const title of report.skipped) io.stdout(`  skipped: ${title}\n`);
    return EXIT_OK;
  },

  export(args, io) {
    parseArgs({ args, strict: true });
    io.stdout(exportMarkdown(repository(io).list({ status: "all" })));
    return EXIT_OK;
  },
};

function heading(bucket: Bucket): string {
  return bucket === "inbox" ? "Inbox" : `Q${bucket} · ${QUADRANT_LABELS[bucket]}`;
}

function describe(task: Task, escalated: boolean): string {
  const inText = new Set([...parseTags(task.title), ...parseTags(task.description ?? "")]);
  const extraTags = task.tags.filter((t) => !inText.has(t)).map((t) => `#${t}`);
  const parts = [task.status === "done" ? `✓ ${task.title}` : task.title];
  if (extraTags.length) parts.push(extraTags.join(" "));
  if (task.dueDate) parts.push(`due ${task.dueDate}${escalated ? " !" : ""}`);
  return parts.join("  ");
}
