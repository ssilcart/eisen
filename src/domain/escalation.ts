import { bucketOf, quadrantOf, type Bucket, type Task } from "./task.ts";

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
 * included) is shown as urgent. The stored flag does not change.
 */
export function isEscalated(task: Task, today: string, withinDays = DEFAULT_URGENT_WITHIN_DAYS): boolean {
  if (task.status !== "open" || task.dueDate === null) return false;
  if (bucketOf(task) === "inbox" || task.urgent) return false;
  return daysBetween(today, task.dueDate) <= withinDays;
}

/** Where the task is shown: its quadrant, with escalation applied. */
export function displayBucket(task: Task, today: string, withinDays = DEFAULT_URGENT_WITHIN_DAYS): Bucket {
  if (isEscalated(task, today, withinDays)) return quadrantOf(task.important, true);
  return bucketOf(task);
}
