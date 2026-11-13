import { DEFAULT_PRESET, headingFor, type PresetId } from "../domain/presets.ts";
import { bucketOf, QUADRANTS, type Bucket, type Task } from "../domain/task.ts";
import { parseTags } from "../domain/tags.ts";

/**
 * S13: Markdown grouped by quadrant, then Inbox, in the format `parseMarkdown`
 * reads back. Tags that the text does not carry and the due date go in an
 * HTML comment, so the file still renders as a plain checklist. Headings are
 * `# Q{n} · {label}` in the active preset (S20) and `# 📥 Inbox`; the importer
 * reads only the `Q{n}` prefix (and the slug `inbox`).
 */
export function exportMarkdown(tasks: readonly Task[], preset: PresetId = DEFAULT_PRESET): string {
  const order: Bucket[] = [...QUADRANTS, "inbox"];
  const sections: string[] = [];
  for (const bucket of order) {
    const inBucket = tasks
      .filter((t) => bucketOf(t) === bucket)
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.position - b.position || a.id - b.id);
    if (inBucket.length === 0) continue;
    sections.push(`# ${headingFor(preset, bucket)}\n\n${inBucket.map(taskBlock).join("\n\n")}`);
  }
  return sections.length ? `${sections.join("\n\n")}\n` : "";
}

function taskBlock(t: Task): string {
  const box = t.status === "done" ? "[x]" : "[ ]";
  const textTags = new Set([...parseTags(t.title), ...parseTags(t.description ?? "")]);
  const meta: string[] = [];
  if (t.dueDate) meta.push(`due=${t.dueDate}`);
  // Every tag, in order, when one is not in the text: order survives the round trip.
  if (t.tags.some((tag) => !textTags.has(tag))) meta.push(`tags=${t.tags.join(",")}`);
  const head = `- ${box} ${t.title}${meta.length ? ` <!-- eisen: ${meta.join(" ")} -->` : ""}`;
  const body = t.description ? t.description.split("\n").map((l) => `  > ${l}`.trimEnd()) : [];
  return [head, ...body].join("\n");
}
