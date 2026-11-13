// The Markdown file a task is edited in with $EDITOR (S11), and the one a new
// task is written in (S22, `a`). Pure: no
// @opentui and no bun:sqlite; app.ts writes the file, runs the editor and
// saves through the repository.
//
//   # {title}
//   due: YYYY-MM-DD        (only when set; empty or removed clears it)
//
//   {description}
import { mergeTags, parseTags } from "../domain/tags.ts";
import { isValidDate, type Task } from "../domain/task.ts";
import type { TaskChanges } from "../store/repository.ts";

export interface EditedTask {
  title: string;
  dueDate: string | null;
  description: string | null;
}

export type ParseResult = { ok: true; value: EditedTask } | { ok: false; error: string };

export function serializeTask(task: Pick<Task, "title" | "dueDate" | "description">): string {
  const due = task.dueDate ? `due: ${task.dueDate}\n` : "";
  const description = task.description ? `${task.description}\n` : "";
  return `# ${task.title}\n${due}\n${description}`;
}

const DUE = /^\s*due:(.*)$/i;

/**
 * Reads the file back. The title is the first non-blank line, as `# Title`;
 * a `due:` line may follow it directly; everything after is the description,
 * trimmed (empty → null).
 */
export function parseTaskFile(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() !== "");
  const heading = start < 0 ? "" : lines[start]!.trim();
  if (!/^#(\s|$)/.test(heading)) {
    return { ok: false, error: "Missing title: the first line must be '# Title'" };
  }
  const title = heading.slice(1).trim();
  if (!title) return { ok: false, error: "Empty title: the first line must be '# Title'" };

  let rest = start + 1;
  let dueDate: string | null = null;
  const due = DUE.exec(lines[rest] ?? "");
  if (due) {
    const value = due[1]!.trim();
    if (value && !isValidDate(value)) {
      return { ok: false, error: `Invalid due date "${value}": use YYYY-MM-DD` };
    }
    dueDate = value || null;
    rest++;
  }
  const description = lines.slice(rest).join("\n").trim();
  return { ok: true, value: { title, dueDate, description: description || null } };
}

const textTags = (title: string, description: string | null): string[] => parseTags(`${title}\n${description ?? ""}`);

/** The file `a` opens (S22): the edit format with an empty title and an empty `due:` line. */
export const NEW_TASK_FILE = "# \ndue: \n\n";

export type NewTaskResult =
  | { ok: true; value: EditedTask & { tags: string[] } }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

/**
 * Reads a new task's file back (S22). A blank file or an empty `#` title
 * (the template left as it was) cancels; any other file that does not parse
 * is an error. Tags are the `#tags` of the title and the description.
 */
export function parseNewTask(text: string): NewTaskResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.trim() !== "");
  // `o` on the template leaves the marker empty and puts the title on the next
  // line: drop the empty marker when a title (not the `due:` line) follows it
  // directly. After a blank line it is a description, and there is no title.
  if (index >= 0 && /^#\s*$/.test(lines[index]!.trim())) {
    const next = lines[index + 1];
    if (next !== undefined && next.trim() !== "" && !/^due:/i.test(next.trim())) lines.splice(index, 1);
  }
  const first = lines[index];
  if (first === undefined || /^#\s*$/.test(first.trim())) return { ok: false, cancelled: true };
  // A first line without the `# ` marker is still the title: nvim's `i` types
  // before the marker ("Buy milk# "), `cc` replaces it, or the title starts
  // with a tag ("#urgent fix"). Only the template's exact "# " leftover at the
  // end is removed; any other `#` belongs to the title.
  if (!/^#\s/.test(first.trimStart())) lines[index] = `# ${first.replace(/# $/, "").trim()}`;
  const parsed = parseTaskFile(lines.join("\n"));
  if (!parsed.ok) return { ok: false, cancelled: false, error: parsed.error };
  const { title, description } = parsed.value;
  return { ok: true, value: { ...parsed.value, tags: textTags(title, description) } };
}

/**
 * The task's tags after an edit: tags that did not come from its old title or
 * description (a section tag like `todo`, set by the importer) are kept, and
 * the `#tags` of the new text are added. A tag that was both a section tag and
 * written in the text goes away when the text drops it. When the set does not
 * change, the stored order is kept.
 */
export function editedTags(task: Pick<Task, "title" | "description" | "tags">, edited: Pick<EditedTask, "title" | "description">): string[] {
  const old = textTags(task.title, task.description);
  const kept = task.tags.filter((tag) => !old.includes(tag));
  const next = mergeTags(kept, textTags(edited.title, edited.description));
  return sameSet(next, task.tags) ? [...task.tags] : next;
}

/**
 * What to save, or null when the file says the same as the task. Fields are
 * compared with the task as the file showed it (parse of serialize), so a
 * description the file cannot hold verbatim (leading blank lines, trailing
 * spaces) is not a change by itself and stays untouched.
 */
export function editChanges(task: Task, edited: EditedTask): TaskChanges | null {
  const shown = parseTaskFile(serializeTask(task));
  const baseline: EditedTask = shown.ok ? shown.value : { title: task.title, dueDate: task.dueDate, description: task.description };
  const changes: TaskChanges = {};
  if (edited.title !== baseline.title) changes.title = edited.title;
  if (edited.dueDate !== baseline.dueDate) changes.dueDate = edited.dueDate;
  if (edited.description !== baseline.description) changes.description = edited.description;
  const tags = editedTags(task, edited);
  if (!sameSet(tags, task.tags)) changes.tags = tags;
  return Object.keys(changes).length === 0 ? null : changes;
}

/** `$VISUAL`, else `$EDITOR`, else `vi`, split on whitespace (`code --wait`). */
export function editorCommand(env: Record<string, string | undefined>): string[] {
  for (const value of [env.VISUAL, env.EDITOR]) {
    const parts = value?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (parts.length > 0) return parts;
  }
  return ["vi"];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
