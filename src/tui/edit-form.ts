// The native form editor (S32) as data: its fields and their order, the
// values a task shows in it, and what a filled-in form saves. Pure: no
// @opentui and no bun:sqlite; form-box.ts draws it and app.ts saves through
// the repository, with the same results as the file editors (edit-file.ts).
// Also which editor command the `auto` and `command` modes run.
import type { EditorSettings } from "../config.ts";
import { isValidDate, type Task } from "../domain/task.ts";
import { editorCommand, textTags, type EditedTask } from "./edit-file.ts";

export type FormField = "title" | "due" | "description";

/** Tab order (S32). */
export const FORM_FIELDS: readonly FormField[] = ["title", "due", "description"];

/** The form's fields as typed. */
export interface FormValues {
  title: string;
  due: string;
  description: string;
}

/** The field after (`1`) or before (`-1`) `field`, wrapping around. */
export function nextField(field: FormField, dir: 1 | -1): FormField {
  const i = FORM_FIELDS.indexOf(field);
  return FORM_FIELDS[(i + dir + FORM_FIELDS.length) % FORM_FIELDS.length]!;
}

/** What the form shows for a task, or a blank form for a new one. */
export function formValues(task: Pick<Task, "title" | "dueDate" | "description"> | null): FormValues {
  return { title: task?.title ?? "", due: task?.dueDate ?? "", description: task?.description ?? "" };
}

/** A one-line field's text: pasted line breaks become spaces. */
export function oneLine(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, " ");
}

export function formChanged(initial: FormValues, current: FormValues): boolean {
  return initial.title !== current.title || initial.due !== current.due || initial.description !== current.description;
}

export type FormCheck =
  | { ok: true; value: EditedTask & { tags: string[] } }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; field: FormField; error: string };

/**
 * What saving the form gives, like reading the edit file back (S11, S22):
 * trimmed title and description (empty description → null), the due date
 * `YYYY-MM-DD` or null when empty, and the `#tags` of title and description.
 * An empty title cancels a new task and is an error on an edit; an invalid
 * due date is an error on the Due field.
 */
export function checkForm(values: FormValues, isNew: boolean): FormCheck {
  const title = oneLine(values.title).trim();
  if (!title) {
    return isNew ? { ok: false, cancelled: true } : { ok: false, cancelled: false, field: "title", error: "Empty title: type a title" };
  }
  const due = values.due.trim();
  if (due && !isValidDate(due)) {
    return { ok: false, cancelled: false, field: "due", error: `Invalid due date "${due}": use YYYY-MM-DD` };
  }
  const description = values.description.replace(/\r\n?/g, "\n").trim() || null;
  return { ok: true, value: { title, dueDate: due || null, description, tags: textTags(title, description) } };
}

/**
 * The editor command for `auto` ($VISUAL, $EDITOR, vi) and `command` (its
 * command line split on whitespace, L15; a blank one falls back to auto).
 */
export function editorCommandFor(editor: EditorSettings, env: Record<string, string | undefined>): string[] {
  if (editor.mode === "command") {
    const parts = editor.command.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) return parts;
  }
  return editorCommand(env);
}
