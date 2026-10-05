/**
 * The task list's status filters. The control plane counts, filters and orders
 * tasks with them in SQL; the UI only uses them to place loaded rows in groups.
 * No Node APIs: the UI bundle imports this.
 */
export type TaskFilter = "all" | "attention" | "working" | "done" | "stopped";
export type TaskBucket = Exclude<TaskFilter, "all">;
export type TaskCounts = Record<TaskFilter, number>;

export const TASK_FILTERS: readonly TaskFilter[] = ["all", "attention", "working", "done", "stopped"];
/** Waiting on the person. A task whose browser asks for them counts too. */
export const ATTENTION_STATUSES: readonly string[] = ["needs_input", "blocked", "unknown", "merge_unknown"];
export const WORKING_STATUSES: readonly string[] = ["planning", "waiting", "queued", "running", "stopping", "merging", "steering"];
export const DONE_STATUSES: readonly string[] = ["completed", "merged"];

export function taskBucket(status: string, browserAsks = false): TaskBucket {
  if (browserAsks || ATTENTION_STATUSES.includes(status)) return "attention";
  if (WORKING_STATUSES.includes(status)) return "working";
  return DONE_STATUSES.includes(status) ? "done" : "stopped";
}

/** GET /api/tasks: counts over every task (narrowed only by the search), one page of the filtered list. */
export interface TaskListPage<T> {
  counts: TaskCounts;
  tasks: T[];
  nextCursor: string | null;
}
