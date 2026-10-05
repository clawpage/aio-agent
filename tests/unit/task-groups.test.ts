import { describe, expect, it } from "vitest";
import { dateBucket, filterCounts, groupTasks, matchesQuery, taskFilterOf } from "../../src/ui/src/taskGroups";
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

  it("classifies the person's turn, running work, done and stopped", () => {
    expect(taskFilterOf(task("needs_input", now))).toBe("attention");
    expect(taskFilterOf(task("unknown", now))).toBe("attention");
    expect(taskFilterOf(task("running", now, { browser: { tabs: 1, request: "请登录", human: false } }))).toBe("attention");
    expect(taskFilterOf(task("steering", now))).toBe("working");
    expect(taskFilterOf(task("completed", now))).toBe("done");
    expect(taskFilterOf(task("interrupted", now))).toBe("stopped");
    expect(taskFilterOf(task("planning_failed", now))).toBe("stopped");
  });

  it("puts the person's turn and running work first under all, then dates newest first", () => {
    const old = task("completed", at(9, 2));
    const today = task("completed", at(10, 4, 9));
    const failedToday = task("failed", at(10, 4, 11));
    const yesterday = task("completed", at(10, 3));
    const running = task("running", at(9, 30));
    const asking = task("needs_input", at(10, 2));
    const groups = groupTasks([old, today, running, yesterday, asking, failedToday], "all", now);
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ["轮到你", [asking.id]],
      ["进行中", [running.id]],
      ["今天", [failedToday.id, today.id]],
      ["昨天", [yesterday.id]],
      ["9月", [old.id]],
    ]);
  });

  it("a status filter keeps only that status, still grouped by date", () => {
    const a = task("completed", at(10, 4)), b = task("failed", at(10, 4)), c = task("completed", at(9, 1));
    expect(groupTasks([a, b, c], "done", now).map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([["今天", [a.id]], ["9月", [c.id]]]);
    expect(groupTasks([a, c], "stopped", now)).toEqual([]);
    expect(filterCounts([a, b, c])).toEqual({ all: 3, attention: 0, working: 0, done: 2, stopped: 1 });
  });

  it("searches title, description, the request, the question and the schedule's name", () => {
    const t = task("completed", now, { title: "订机票", description: "东京往返", text: "帮我看 Reddit", clarification: "几号出发？",
      schedule: { id: "s", title: "每日账单检查", rule: "每天" } });
    for (const q of ["机票", "东京", "reddit", "几号", "账单", "  "]) expect(matchesQuery(t, q)).toBe(true);
    expect(matchesQuery(t, "酒店")).toBe(false);
  });
});
