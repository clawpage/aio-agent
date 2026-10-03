import { describe, expect, it } from "vitest";
import { formatRelevance, formatTimeline, jevRelevance, lastQuestion, routingQuestion, timeline, type ContextTask } from "../../src/control/tasks/context.js";

const at = (h: number, m: number) => new Date(2026, 8, 30, h, m).getTime();
const task = (id: string, created: number, extra: Partial<ContextTask> = {}): ContextTask => ({ id, title: id, input_text: id, status: "completed", result: null, merged_into: null, plan_json: null, created_at: created, ...extra });

describe("main-session context", () => {
  it("finds the question a task left for the user, and nothing when it did not ask", () => {
    expect(lastQuestion({ status: "completed", plan_json: null, result: "找到了，$499。需要你授权我用已保存的卡付款吗？" })).toBe("需要你授权我用已保存的卡付款吗？");
    expect(lastQuestion({ status: "completed", plan_json: null, result: "已经订好了。祝旅途愉快！" })).toBeNull();
    // A question far from the end is not what the task is waiting on.
    expect(lastQuestion({ status: "completed", plan_json: null, result: `要不要看看别的？${"后面是很长的总结。".repeat(20)}` })).toBeNull();
    expect(lastQuestion({ status: "needs_input", plan_json: JSON.stringify({ clarification: "去哪个城市？" }), result: null })).toBe("去哪个城市？");
    // Tappable answers after the question do not hide it.
    expect(lastQuestion({ status: "completed", plan_json: null, result: `两家都有货。你要哪种规格？\n\n\`\`\`choices\n${JSON.stringify(["32 盎司 6 瓶装（$19.99）", "2 盎司 48 瓶装（$42.50）", "两种都要比价，帮我算单价"])}\n\`\`\`` })).toBe("你要哪种规格？");
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
  it("keeps Jev's likeliest tasks for the executor and marks them in the timeline and its own lines", () => {
    const now = at(15, 0);
    const tasks = [
      task("t1", at(14, 0), { title: "买 Pixel", input_text: "帮我买那台 Pixel", result: "找到了，$499。需要你授权我付款吗？" }),
      task("t2", at(14, 30), { title: "讲笑话", input_text: "讲个笑话", result: "好的，笑话是……" }),
      task("t3", at(14, 40), { input_text: "已授权", status: "planning" }),
    ];
    const relevance = jevRelevance({ choice: "t1", confidence: 0.9, probabilities: { t1: 0.82, t2: 0.03, NEW: 0.15 } });
    // Below one in ten is noise: it is not passed on.
    expect(relevance).toEqual({ choice: "t1", confident: true, ranked: [{ id: "t1", p: 0.82 }, { id: "NEW", p: 0.15 }] });
    const lines = formatTimeline(timeline(tasks, tasks[2]!), now, relevance).split("\n");
    expect(lines[0]).toMatch(/任务 t1「买 Pixel」.*〔Jev：本次消息接续它 82%〕$/);
    expect(lines[1]).not.toContain("Jev");
    expect(lines[2]).toMatch(/^▶ .*← 本次消息$/);
    const byId = new Map(tasks.map(t => [t.id, t]));
    expect(formatRelevance(relevance, id => byId.get(id), now)!.split("\n")).toEqual([
      "- 任务 t1「买 Pixel」（completed，14:00）：82%，Jev 首选（高置信）；助理最后问：「需要你授权我付款吗？」",
      "- 独立的新请求：15%",
    ]);
    // An unsure reading says so; a task that no longer exists is left out.
    const unsure = jevRelevance({ choice: "t2", confidence: 0.5, probabilities: { t1: 0.4, t2: 0.45, NEW: 0.15 } });
    expect(unsure.confident).toBe(false);
    expect(formatRelevance(unsure, id => (id === "t1" ? undefined : byId.get(id)), now)!.split("\n")).toEqual([
      "- 任务 t2「讲笑话」（completed，14:30）：45%，Jev 首选；结果开头：好的，笑话是……",
      "- 独立的新请求：15%",
    ]);
    expect(formatRelevance({ choice: "gone", confident: true, ranked: [{ id: "gone", p: 1 }] }, () => undefined, now)).toBeNull();
    // Without a reading the timeline is unchanged.
    expect(formatTimeline(timeline(tasks, tasks[2]!), now)).not.toContain("Jev");
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
