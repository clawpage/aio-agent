import { describe, expect, it } from "vitest";
import { dateBucket, groupTasks } from "../../src/ui/src/taskGroups";
import { taskBucket } from "../../src/common/taskList";
import type { Task } from "../../src/ui/src/types";

const now = new Date(2026, 9, 4, 14, 30).getTime(); // Sunday
const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
let seq = 0;
const task = (status: string, time: number, extra: Partial<Task> = {}): Task => ({
  id: `t${++seq}`, title: `任务 ${seq}`, text: "", conversationId: "c", status, result: null, error: null, attachments: [],
  relatedTaskId: null, dependencies: [], approvals: 0, revision: 1, createdAt: time,
  completedAt: ["completed", "failed", "interrupted"].includes(status) ? time : null, ...extra,
});

describe("task list grouping", () => {
  it("buckets by local calendar day for a week, then by month", () => {
    expect(dateBucket(at(10, 4, 0), now).label).toBe("今天");
    expect(dateBucket(at(10, 3, 23), now).label).toBe("昨天");
    expect(dateBucket(at(10, 1), now).label).toBe("周四 · 10月1日");
    expect(dateBucket(at(9, 28), now).label).toBe("周一 · 9月28日");
    expect(dateBucket(at(9, 27), now).label).toBe("9月");
    expect(dateBucket(new Date(2025, 11, 30).getTime(), now).label).toBe("2025年12月");
  });

  it("classifies the person's turn, running work, done and stopped the same way the server does", () => {
    expect(taskBucket("needs_input")).toBe("attention");
    expect(taskBucket("unknown")).toBe("attention");
    expect(taskBucket("running", true)).toBe("attention");
    expect(taskBucket("steering")).toBe("working");
    expect(taskBucket("completed")).toBe("done");
    expect(taskBucket("interrupted")).toBe("stopped");
    expect(taskBucket("planning_failed")).toBe("stopped");
  });

  it("keeps the server's order and pins the person's turn and running work under all", () => {
    const asking = task("needs_input", at(10, 2));
    const running = task("running", at(9, 30));
    const failedToday = task("failed", at(10, 4, 11));
    const today = task("completed", at(10, 4, 9));
    const yesterday = task("completed", at(10, 3));
    const old = task("completed", at(9, 2));
    const order = [asking, running, failedToday, today, yesterday, old];
    expect(groupTasks(order, "all", now).map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ["轮到你", [asking.id]],
      ["进行中", [running.id]],
      ["今天", [failedToday.id, today.id]],
      ["昨天", [yesterday.id]],
      ["9月", [old.id]],
    ]);
    // Under a status filter every row is grouped by date.
    expect(groupTasks([asking], "attention", now).map((g) => g.label)).toEqual(["周五 · 10月2日"]);
  });
});
