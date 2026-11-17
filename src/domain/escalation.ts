import { bucketOf, type Task } from "./task.ts";

export const DEFAULT_URGENT_WITHIN_DAYS = 2;

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Today's date in local time, as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * S7: an open, triaged, not-urgent task due within `withinDays` (overdue
 * included) is marked as due soon (`!`, red due date). It stays in its own
 * quadrant and the stored flag does not change.
 */
export function isEscalated(task: Task, today: string, withinDays = DEFAULT_URGENT_WITHIN_DAYS): boolean {
  if (task.status !== "open" || task.dueDate === null) return false;
  if (bucketOf(task) === "inbox" || task.urgent) return false;
  return daysBetween(today, task.dueDate) <= withinDays;
}
