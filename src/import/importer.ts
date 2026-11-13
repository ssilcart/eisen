import type { TaskRepository } from "../store/repository.ts";
import { parseMarkdown, type ImportWarning } from "./markdown.ts";

export interface ImportReport {
  created: number;
  /** Titles skipped because an open task with the same title exists (S16). */
  skipped: string[];
  warnings: ImportWarning[];
}

/** Imports a Markdown checklist in one transaction: all of it or nothing. */
export function importMarkdown(repo: TaskRepository, text: string): ImportReport {
  const { items, warnings } = parseMarkdown(text);
  const report: ImportReport = { created: 0, skipped: [], warnings };
  repo.transaction(() => {
    for (const item of items) {
      if (item.status === "open" && repo.findOpenByTitle(item.title)) {
        report.skipped.push(item.title);
        continue;
      }
      repo.create(item);
      report.created++;
    }
  });
  return report;
}
