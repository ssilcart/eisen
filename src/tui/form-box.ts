// The native form editor (S32): a floating box like the S22 editor's, with
// Title and Due (one line each) and Description (multi-line), all OpenTUI
// 0.8.4 TextareaRenderables. app.ts owns the keys: it hands every key to
// `handleKey` and prevents the default, so the focused field's own key
// handler never sees it (L11: a focused renderable does not stop the global
// keypress handler, and the global one runs first) and each key reaches the
// field exactly once. Pastes still go to the focused field through OpenTUI.
// What the form saves is decided by edit-form.ts.
import { BoxRenderable, TextRenderable, TextareaRenderable, bold, fg, StyledText, type CliRenderer, type KeyEvent } from "@opentui/core";
import { checkForm, formChanged, nextField, oneLine, type FormCheck, type FormField, type FormValues } from "./edit-form.ts";
import { fit, type Rect } from "./layout.ts";
import { COLOR, blend } from "./theme.ts";

/** What a closed form gives: the task to save, or null when cancelled. */
export type FormResult = Extract<FormCheck, { ok: true }>["value"] | null;

export interface FormMessage {
  text: string;
  kind: "error" | "confirm";
}

export interface FormBox {
  readonly box: BoxRenderable;
  /** `New task · ✅ Do` or `Edit · {title}`, before fitting it to the box. */
  readonly title: string;
  readonly color: string;
  /** Resolves once the form is saved (the task) or cancelled (null). */
  readonly result: Promise<FormResult>;
  /** The inline error or the discard question, if any. */
  readonly message: FormMessage | null;
  readonly field: FormField;
  /** One key, already kept from the matrix by the caller. */
  handleKey(key: KeyEvent): void;
  layout(rect: Rect): void;
  /** Closes it as cancelled (the app is going away). */
  cancel(): void;
  destroy(): void;
}

export const FORM_HINT = "Tab next field · Enter next / newline · Ctrl+S save · Esc cancel";
export const DISCARD_QUESTION = "Discard changes? Esc again";

const LABEL_WIDTH = 7;
const ENTER = new Set(["return", "linefeed", "kpenter"]);

export interface FormOptions {
  title: string;
  color: string;
  initial: FormValues;
  isNew: boolean;
}

/** Builds the form box (not yet added to the tree), its fields filled with `initial`, Title focused. */
export function createFormBox(renderer: CliRenderer, options: FormOptions): FormBox {
  const { color, initial, isNew } = options;
  let resolve!: (r: FormResult) => void;
  const result = new Promise<FormResult>((r) => (resolve = r));
  let closed = false;
  let field: FormField = "title";
  let message: FormMessage | null = null;

  const box = new BoxRenderable(renderer, {
    id: "eisen-form",
    position: "absolute",
    zIndex: 20,
    border: true,
    borderStyle: "rounded",
    borderColor: color,
    titleColor: color,
    backgroundColor: COLOR.panel,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    overflow: "hidden",
  });
  const fieldBg = COLOR.statusBg;
  const focusedBg = blend(color, COLOR.panel, 0.18);
  const area = (id: FormField, value: string, multiLine: boolean, placeholder?: string) =>
    new TextareaRenderable(renderer, {
      id: `eisen-form-${id}`,
      initialValue: value,
      placeholder: placeholder ?? null,
      placeholderColor: COLOR.muted,
      textColor: COLOR.text,
      focusedTextColor: COLOR.text,
      backgroundColor: fieldBg,
      focusedBackgroundColor: focusedBg,
      cursorColor: color,
      wrapMode: multiLine ? "word" : "none",
      flexGrow: 1,
      flexShrink: multiLine ? 1 : 0,
      height: multiLine ? undefined : 1,
      minHeight: 1,
    });
  const fields: Record<FormField, TextareaRenderable> = {
    title: area("title", oneLine(initial.title), false),
    due: area("due", initial.due, false, "YYYY-MM-DD"),
    description: area("description", initial.description, true),
  };
  // The cursor starts at the end of what the task already says.
  for (const f of Object.values(fields)) f.gotoBufferEnd();
  // A paste into a one-line field keeps it on one line.
  for (const id of ["title", "due"] as const) {
    const f = fields[id];
    f.onContentChange = () => {
      const text = f.plainText;
      if (/[\r\n]/.test(text)) {
        f.setText(oneLine(text));
        f.gotoBufferEnd();
      }
    };
  }
  const labels: Record<FormField, TextRenderable> = {
    title: new TextRenderable(renderer, { id: "eisen-form-title-label", content: "", width: LABEL_WIDTH, flexShrink: 0 }),
    due: new TextRenderable(renderer, { id: "eisen-form-due-label", content: "", width: LABEL_WIDTH, flexShrink: 0 }),
    description: new TextRenderable(renderer, { id: "eisen-form-description-label", content: "", height: 1, flexShrink: 0 }),
  };
  for (const id of ["title", "due"] as const) {
    const row = new BoxRenderable(renderer, { id: `eisen-form-${id}-row`, flexDirection: "row", height: 1, flexShrink: 0 });
    row.add(labels[id]);
    row.add(fields[id]);
    box.add(row);
  }
  box.add(labels.description);
  box.add(fields.description);
  const footer = new TextRenderable(renderer, { id: "eisen-form-footer", content: "", height: 1, flexShrink: 0, wrapMode: "none" });
  box.add(footer);
  let innerWidth = 0;

  function paint(): void {
    const names: Record<FormField, string> = { title: "Title", due: "Due", description: "Description" };
    for (const id of ["title", "due", "description"] as const) {
      const focused = id === field;
      const style = focused ? fg(color) : fg(COLOR.muted);
      labels[id].content = new StyledText([focused ? bold(style(names[id])) : style(names[id])]);
    }
    const text = message?.text ?? FORM_HINT;
    const style = message?.kind === "error" ? fg(COLOR.escalated) : message ? fg(COLOR.due) : fg(COLOR.muted);
    footer.content = new StyledText([style(innerWidth > 0 ? fit(text, innerWidth) : text)]);
  }

  function focus(next: FormField): void {
    fields[field].blur();
    field = next;
    fields[field].focus();
    paint();
  }

  const values = (): FormValues => ({
    title: fields.title.plainText,
    due: fields.due.plainText,
    description: fields.description.plainText,
  });

  function close(r: FormResult): void {
    if (closed) return;
    closed = true;
    resolve(r);
  }

  function save(): void {
    const check = checkForm(values(), isNew);
    if (check.ok) return close(check.value);
    if (check.cancelled) return close(null);
    message = { text: check.error, kind: "error" };
    focus(check.field);
  }

  fields.title.focus();
  paint();

  return {
    box,
    title: options.title,
    color,
    result,
    get message() {
      return message;
    },
    get field() {
      return field;
    },
    handleKey(key: KeyEvent): void {
      if (closed) return;
      if (key.name === "escape") {
        // Nothing to lose closes at once; otherwise the second Esc in a row discards.
        if (message?.kind === "confirm" || !formChanged(initial, values())) return close(null);
        message = { text: DISCARD_QUESTION, kind: "confirm" };
        paint();
        return;
      }
      if (message?.kind === "confirm") message = null;
      if (key.ctrl && !key.meta && key.name === "s") return save();
      if (key.name === "tab" && !key.ctrl && !key.meta) return focus(nextField(field, key.shift ? -1 : 1));
      if (ENTER.has(key.name) && field !== "description" && !key.meta) return focus(nextField(field, 1));
      fields[field].handleKeyPress(key);
      paint();
    },
    layout(rect: Rect): void {
      box.left = rect.left;
      box.top = rect.top;
      box.width = rect.width;
      box.height = rect.height;
      innerWidth = Math.max(0, rect.width - 4);
      paint();
    },
    cancel(): void {
      close(null);
    },
    destroy(): void {
      close(null);
      try {
        fields[field].blur();
      } catch {
        // Already gone.
      }
      if (!box.isDestroyed) {
        box.parent?.remove(box);
        box.destroyRecursively();
      }
    },
  };
}
