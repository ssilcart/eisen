export type Quadrant = 1 | 2 | 3 | 4;
export type Bucket = Quadrant | "inbox";
export type Status = "open" | "done";

export interface Task {
  id: number;
  title: string;
  description: string | null;
  important: boolean | null;
  urgent: boolean | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  tags: string[];
  status: Status;
  position: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  1: "Do",
  2: "Schedule",
  3: "Delegate",
  4: "Delete",
};

export const QUADRANTS: readonly Quadrant[] = [1, 2, 3, 4];

/** S6: the quadrant is derived, never stored. Any NULL flag means Inbox. */
export function quadrantOf(important: boolean | null, urgent: boolean | null): Bucket {
  if (important === null || urgent === null) return "inbox";
  if (important) return urgent ? 1 : 2;
  return urgent ? 3 : 4;
}

export function flagsFor(q: Quadrant): { important: boolean; urgent: boolean } {
  return { important: q === 1 || q === 2, urgent: q === 1 || q === 3 };
}

export function bucketOf(task: Pick<Task, "important" | "urgent">): Bucket {
  return quadrantOf(task.important, task.urgent);
}

export function isQuadrant(value: unknown): value is Quadrant {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when the string is a real calendar date in YYYY-MM-DD. */
export function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
