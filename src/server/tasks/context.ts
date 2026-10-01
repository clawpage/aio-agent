import type { JevQuestion } from "../jev.js";

/**
 * Chronological context of the main session. The user talks to one input box;
 * what a short message ("已授权", "第二个", "改成周六") refers to is decided by
 * what came just before it, so both the dispatcher's second opinion and the
 * executor see the conversation in the order it happened.
 */

export interface ContextTask {
  id: string;
  title: string;
  input_text: string;
  status: string;
  result: string | null;
  merged_into: string | null;
  plan_json: string | null;
  created_at: number;
}

export interface TimelineEntry {
  id: string;
  at: number;
  text: string;
  /** The task the message belongs to (a supplement belongs to its parent). */
  taskId: string;
  title: string;
  status: string;
  /** What the assistant last asked the user on that task, if anything. */
  ask: string | null;
  current: boolean;
}

const clip = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

/** The question a task left for the user: its preflight question, or a final answer that ends asking one. */
export function lastQuestion(task: Pick<ContextTask, "plan_json" | "result" | "status">): string | null {
  if (task.plan_json) {
    try {
      const q = (JSON.parse(task.plan_json) as { clarification?: string | null }).clarification;
      if (task.status === "needs_input" && q) return clip(q, 200);
    } catch { /* an unreadable plan has no question */ }
  }
  const result = task.result?.trim();
  if (!result) return null;
  const tail = result.slice(-400);
  const at = Math.max(tail.lastIndexOf("？"), tail.lastIndexOf("?"));
  if (at < 0 || tail.length - at > 120) return null;
  const start = Math.max(...["。", "！", "\n", "!"].map((m) => tail.lastIndexOf(m, at - 1))) + 1;
  return clip(tail.slice(start, at + 1), 200);
}

/** The last `max` user messages up to and including `current`, oldest first. */
export function timeline(tasks: ContextTask[], current: ContextTask, max = 10): TimelineEntry[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks
    .filter((t) => t.created_at <= current.created_at)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-max)
    .map((t) => {
      const owner = (t.merged_into && byId.get(t.merged_into)) || t;
      return { id: t.id, at: t.created_at, text: clip(t.input_text, 160), taskId: owner.id, title: owner.title, status: owner.status, ask: owner.id === current.id ? null : lastQuestion(owner), current: t.id === current.id };
    });
}

const time = (ts: number, now: number) => {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString("sv-SE")} ${hm}`;
};

/** The timeline as lines an executor can read: when, what the user said, which task, what it last asked. */
export function formatTimeline(entries: TimelineEntry[], now = Date.now()): string {
  return entries
    .map((e) => {
      const head = `${e.current ? "▶ " : "  "}[${time(e.at, now)}] 用户：「${e.text}」`;
      if (e.current) return `${head}  ← 本次消息`;
      const where = e.taskId === e.id ? `任务 ${e.taskId}「${clip(e.title, 30)}」（${e.status}）` : `补充给任务 ${e.taskId}「${clip(e.title, 30)}」（${e.status}）`;
      return `${head} → ${where}${e.ask ? `；助理最后问：「${e.ask}」` : ""}`;
    })
    .join("\n");
}

export const NEW_TASK = "NEW";

/**
 * Jev's question for the dispatcher: which candidate does this message continue,
 * or is it new. Candidates carry their order, time, status and open question so
 * a terse reply lands on the task that is actually waiting for it.
 */
export function routingQuestion(message: string, candidates: Array<ContextTask & { clarification?: string | null }>, entries: TimelineEntry[], now = Date.now()): { state: Record<string, unknown>; questions: Record<string, JevQuestion> } {
  const ordered = [...candidates].sort((a, b) => b.created_at - a.created_at);
  const criteria: Record<string, string> = {};
  ordered.forEach((t, i) => {
    const ask = lastQuestion(t);
    criteria[t.id] = [
      `第${i + 1}近（${time(t.created_at, now)}）「${clip(t.title, 40)}」状态 ${t.status}`,
      `用户原话：${clip(t.input_text, 200)}`,
      ask ? `助理最后问用户：${ask}` : t.result ? `结果摘要：${clip(t.result, 200)}` : "",
    ].filter(Boolean).join("；");
  });
  criteria[NEW_TASK] = "与以上任务都无关的独立新请求";
  return {
    state: { now: new Date(now).toISOString(), main_session_timeline: formatTimeline(entries, now), message: clip(message, 2000) },
    questions: {
      target: {
        criteria,
        instructions: {
          goal: "判断用户在主会话里发的这条新消息，是在接续哪个已有任务（回答它的问题、补充或修改它），还是独立的新请求。",
          rules: [
            "按主会话时间线的先后理解：越接近本消息的对话越可能是它的对象。",
            "简短的确认或回复（如“已授权”“可以”“好的”“就这个”“第二个”“改成周六”）回应的是时间上最近一次向用户提问或请求确认的任务。",
            "消息明确点名了某个任务里的实体（人名、地点、商品、文件、网站）时，以点名的为准，即使它不是最近的。",
            "只是关键词与旧任务重合、语义上是新的请求时，选 NEW。",
          ],
        },
      },
    },
  };
}
