import { isQuadrant, isValidDate, type Quadrant, type Status } from "../domain/task.ts";
import { mergeTags, parseTags, slug } from "../domain/tags.ts";

export interface ImportItem {
  title: string;
  description: string | null;
  tags: string[];
  status: Status;
  /** null: Inbox */
  quadrant: Quadrant | null;
  dueDate: string | null;
}

export interface ImportWarning {
  line: number;
  message: string;
}

/** Headings written by `eisen export`: "# Q2 · Schedule" and "# Inbox". */
const QUADRANT_HEADING = /^q([1-4])\b/i;
const HEADING = /^#{1,6}\s+(.*)$/;
const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
/** Metadata `eisen export` appends to a task line, invisible when rendered. */
const META = /\s*<!--\s*eisen:(.*?)-->\s*$/;

type Section = { kind: "tag"; tag: string | null } | { kind: "quadrant"; quadrant: Quadrant | null };

interface Draft {
  title: string;
  status: Status;
  section: Section;
  description: string[];
  metaTags: string[];
  dueDate: string | null;
}

/**
 * S14: parses a Markdown checklist. Headings are sections (their slug becomes a
 * tag) unless they are export headings, which give the quadrant. Never throws:
 * unknown lines become warnings.
 */
export function parseMarkdown(text: string): { items: ImportItem[]; warnings: ImportWarning[] } {
  const items: ImportItem[] = [];
  const warnings: ImportWarning[] = [];
  let section: Section = { kind: "tag", tag: null };
  let current: Draft | null = null;

  const flush = () => {
    if (current) items.push(finish(current));
    current = null;
  };

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "" || RULE.test(raw)) return;

    const heading = HEADING.exec(raw);
    if (heading) {
      flush();
      section = sectionFor(heading[1]!.trim());
      return;
    }

    const task = TASK.exec(raw);
    if (task) {
      flush();
      const { title, metaTags, dueDate, metaWarning } = splitMeta(task[2]!);
      if (metaWarning) warnings.push({ line, message: metaWarning });
      if (title === "") {
        warnings.push({ line, message: "Task without a title ignored" });
        return;
      }
      current = { title, status: task[1] === " " ? "open" : "done", section, description: [], metaTags, dueDate };
      return;
    }

    const quote = QUOTE.exec(raw);
    if (quote) {
      if (current) (current as Draft).description.push(quote[1]!.trimEnd());
      else warnings.push({ line, message: `Description without a task ignored: "${raw.trim()}"` });
      return;
    }

    warnings.push({ line, message: `Unrecognised line ignored: "${raw.trim()}"` });
  });
  flush();
  return { items, warnings };
}

function sectionFor(heading: string): Section {
  const q = QUADRANT_HEADING.exec(heading.trim());
  if (q) return { kind: "quadrant", quadrant: Number(q[1]) as Quadrant };
  if (slug(heading) === "inbox") return { kind: "quadrant", quadrant: null };
  return { kind: "tag", tag: slug(heading) || null };
}

function splitMeta(text: string): { title: string; metaTags: string[]; dueDate: string | null; metaWarning?: string } {
  const meta = META.exec(text);
  const title = (meta ? text.slice(0, meta.index) : text).trim();
  if (!meta) return { title, metaTags: [], dueDate: null };
  let metaTags: string[] = [];
  let dueDate: string | null = null;
  let metaWarning: string | undefined;
  for (const pair of meta[1]!.trim().split(/\s+/)) {
    const [key, value = ""] = pair.split("=", 2);
    if (key === "tags") metaTags = value.split(",").filter(Boolean);
    else if (key === "due" && isValidDate(value)) dueDate = value;
    else metaWarning = `Unknown metadata ignored: "${pair}"`;
  }
  return { title, metaTags, dueDate, metaWarning };
}

function finish(d: Draft): ImportItem {
  const description = d.description.length > 0 ? d.description.join("\n").trim() || null : null;
  const sectionTag = d.section.kind === "tag" && d.section.tag ? [d.section.tag] : [];
  return {
    title: d.title,
    description,
    // Metadata from `eisen export` lists every tag in order, so it goes first.
    tags: mergeTags(d.metaTags, sectionTag, parseTags(d.title), parseTags(description ?? "")),
    status: d.status,
    quadrant: d.section.kind === "quadrant" && isQuadrant(d.section.quadrant) ? d.section.quadrant : null,
    dueDate: d.dueDate,
  };
}
