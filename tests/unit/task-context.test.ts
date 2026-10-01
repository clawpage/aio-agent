import { describe, expect, it } from "vitest";
import { formatTimeline, lastQuestion, routingQuestion, timeline, type ContextTask } from "../../src/server/tasks/context.js";

const at = (h: number, m: number) => new Date(2026, 8, 30, h, m).getTime();
const task = (id: string, created: number, extra: Partial<ContextTask> = {}): ContextTask => ({ id, title: id, input_text: id, status: "completed", result: null, merged_into: null, plan_json: null, created_at: created, ...extra });

describe("main-session context", () => {
  it("finds the question a task left for the user, and nothing when it did not ask", () => {
    expect(lastQuestion({ status: "completed", plan_json: null, result: "找到了，$499。需要你授权我用已保存的卡付款吗？" })).toBe("需要你授权我用已保存的卡付款吗？");
    expect(lastQuestion({ status: "completed", plan_json: null, result: "已经订好了。祝旅途愉快！" })).toBeNull();
    // A question far from the end is not what the task is waiting on.
    expect(lastQuestion({ status: "completed", plan_json: null, result: `要不要看看别的？${"后面是很长的总结。".repeat(20)}` })).toBeNull();
    expect(lastQuestion({ status: "needs_input", plan_json: JSON.stringify({ clarification: "去哪个城市？" }), result: null })).toBe("去哪个城市？");
  });
  it("lists the latest messages oldest first, attributes supplements and marks the current one", () => {
    const now = at(15, 0);
    const tasks = [
      task("t1", at(14, 0), { input_text: "订机票", result: "要靠窗还是过道？" }),
      task("s1", at(14, 5), { input_text: "靠窗", merged_into: "t1", status: "merged" }),
      task("t2", at(14, 30), { input_text: "讲个笑话", result: "好的，笑话是……" }),
      task("t3", at(14, 40), { input_text: "已授权", status: "planning" }),
      task("t4", at(14, 50), { input_text: "以后的消息" }),
    ];
    const entries = timeline(tasks, tasks[3]!);
    expect(entries.map(e => e.id)).toEqual(["t1", "s1", "t2", "t3"]);
    expect(entries[1]).toMatchObject({ taskId: "t1" });
    const text = formatTimeline(entries, now);
    expect(text.split("\n")).toEqual([
      "  [14:00] 用户：「订机票」 → 任务 t1「t1」（completed）；助理最后问：「要靠窗还是过道？」",
      "  [14:05] 用户：「靠窗」 → 补充给任务 t1「t1」（completed）；助理最后问：「要靠窗还是过道？」",
      "  [14:30] 用户：「讲个笑话」 → 任务 t2「t2」（completed）",
      "▶ [14:40] 用户：「已授权」  ← 本次消息",
    ]);
    expect(timeline(tasks, tasks[3]!, 2).map(e => e.id)).toEqual(["t2", "t3"]);
  });
  it("asks Jev to choose among candidates newest first, with their open questions, or NEW", () => {
    const tasks = [task("t1", at(14, 0), { result: "要授权吗？" }), task("t2", at(14, 30))];
    const q = routingQuestion("已授权", tasks, timeline([...tasks, task("t3", at(14, 40), { input_text: "已授权" })], task("t3", at(14, 40))), at(15, 0));
    const criteria = q.questions.target!.criteria;
    expect(Object.keys(criteria)).toEqual(["t2", "t1", "NEW"]);
    expect(criteria.t1).toContain("助理最后问用户：要授权吗？");
    expect(criteria.t2).toMatch(/^第1近（14:30）/);
    expect(q.state.message).toBe("已授权");
    expect(String(q.state.main_session_timeline)).toContain("▶ [14:40]");
  });
});
