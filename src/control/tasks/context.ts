import { confident, type JevAnswer, type JevQuestion } from "../jev.js";

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
  /** Set on a run a schedule started (the daily feed included): nobody typed it. */
  schedule_id?: string | null;
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
  /** A scheduled run's instruction, not something the user said. */
  scheduled?: boolean;
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
  // Tappable answers (a ```choices block) follow the question; the question is what is asked.
  const result = task.result?.replace(/```choices[ \t]*\r?\n[\s\S]*?```\s*$/, "").trim();
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
      return { id: t.id, at: t.created_at, text: clip(t.input_text, 160), taskId: owner.id, title: owner.title, status: owner.status, ask: owner.id === current.id ? null : lastQuestion(owner), current: t.id === current.id, ...(t.schedule_id ? { scheduled: true } : {}) };
    });
}

const time = (ts: number, now: number) => {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString("sv-SE")} ${hm}`;
};

const percent = (p: number) => `${Math.round(p * 100)}%`;

/**
 * The timeline as lines an executor can read: when, what the user said, which task, what it last asked,
 * and, given Jev's reading of this message, how likely it continues that task.
 */
export function formatTimeline(entries: TimelineEntry[], now = Date.now(), relevance?: JevRelevance | null): string {
  const likely = new Map(relevance?.ranked.map((r) => [r.id, r.p]));
  return entries
    .map((e) => {
      // A scheduled run's instruction is labelled as such: the user did not type it.
      const head = `${e.current ? "▶ " : "  "}[${time(e.at, now)}] ${e.scheduled ? "定时运行" : "用户"}：「${e.text}」`;
      if (e.current) return `${head}  ← 本次${e.scheduled ? "运行" : "消息"}`;
      const where = e.taskId === e.id ? `任务 ${e.taskId}「${clip(e.title, 30)}」（${e.status}）` : `补充给任务 ${e.taskId}「${clip(e.title, 30)}」（${e.status}）`;
      const p = likely.get(e.taskId);
      return `${head} → ${where}${e.ask ? `；助理最后问：「${e.ask}」` : ""}${p === undefined ? "" : `〔Jev：相关性 ${percent(p)}〕`}`;
    })
    .join("\n");
}

/** Jev's reading of which earlier task a message continues: the likeliest few, kept with the plan for the executor. */
export interface JevRelevance {
  choice: string;
  confident: boolean;
  /** Probability per task id (or `NEW`), likeliest first. */
  ranked: Array<{ id: string; p: number }>;
  /** Independent probability that each recalled task is relevant to this message. */
  scores?: Record<string, number>;
  /** Jev's advice; Luna still makes the final routing decision. */
  suggestion?: { kind: "new" | "steer" | "resume"; taskId: string | null; probability: number };
  /** Full model answers supplied to Luna and the executor for auditability. */
  answers?: Record<string, JevAnswer>;
}

export function jevRelevance(answer: JevAnswer, max = 3, min = 0.1): JevRelevance {
  const ranked = Object.entries(answer.probabilities)
    .filter(([, p]) => p >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([id, p]) => ({ id, p: Math.round(p * 100) / 100 }));
  return { choice: answer.choice, confident: confident(answer), ranked };
}

/**
 * Jev's reading as lines for the executor: each likely task with its time, status and what it left
 * (its open question, or the start of its result), so the executor can build on it instead of redoing it.
 */
export function formatRelevance(relevance: JevRelevance, get: (id: string) => ContextTask | null | undefined, now = Date.now()): string | null {
  const suggestion = relevance.suggestion;
  const lines = [
    ...(suggestion ? [`- Jev 建议：${suggestion.kind === "new" ? "新任务" : `${suggestion.kind === "steer" ? "追加" : "续接"}任务 ${suggestion.taskId}`}（${percent(suggestion.probability)}，${relevance.confident ? "高置信" : "不确定"}）；最终由 Luna 决定。`] : []),
    ...relevance.ranked.flatMap(({ id, p }) => {
    const mark = id === relevance.choice ? `，Jev 首选${relevance.confident ? "（高置信）" : ""}` : "";
    if (id === NEW_TASK) return [`- 独立的新请求：${percent(p)}${mark}`];
    const t = get(id);
    if (!t) return [];
    const ask = lastQuestion(t);
    const left = ask ? `；助理最后问：「${ask}」` : t.result ? `；结果开头：${clip(t.result, 120)}` : "";
    return [`- 任务 ${t.id}「${clip(t.title, 30)}」（${t.status}，${time(t.created_at, now)}）：${percent(p)}${mark}${left}`];
  }),
  ];
  return lines.length ? lines.join("\n") : null;
}

export const NEW_TASK = "NEW";

export function dispatchAdvice(answers: Record<string, JevAnswer>, candidates: Array<{ id: string }>): JevRelevance {
  const route = answers.route!;
  const [kind, id] = route.choice === NEW_TASK ? ["new", null] : route.choice.split(":", 2);
  const taskId = id && candidates.some(t => t.id === id) ? id : null;
  const scores = Object.fromEntries(candidates.map(t => [t.id, Math.round((answers[`relevance:${t.id}`]?.probabilities.related ?? 0) * 100) / 100]));
  const ranked = Object.entries(scores).map(([taskId, p]) => ({ id: taskId, p }))
    .filter(item => item.p >= 0.1).sort((a, b) => b.p - a.p).slice(0, 6);
  return {
    choice: taskId ?? NEW_TASK,
    confident: confident(route),
    ranked,
    scores,
    suggestion: { kind: taskId && kind === "steer" ? "steer" : taskId && kind === "resume" ? "resume" : "new", taskId, probability: Math.round((route.probabilities[route.choice] ?? 0) * 100) / 100 },
    answers,
  };
}

/**
 * Jev's question for the dispatcher: which candidate does this message continue,
 * or is it new. Candidates carry their order, time, status and open question so
 * a terse reply lands on the task that is actually waiting for it.
 */
export function routingQuestion(message: string, candidates: Array<ContextTask & { clarification?: string | null; recalled?: boolean; turn_id?: string | null; latestMessage?: string | null }>, entries: TimelineEntry[], now = Date.now()): { state: Record<string, unknown>; questions: Record<string, JevQuestion> } {
  const byTime = [...candidates].sort((a, b) => b.created_at - a.created_at);
  // The latest tasks by rank, then the older ones recall found by what the message says.
  const ordered = [...byTime.filter((t) => !t.recalled), ...byTime.filter((t) => t.recalled)];
  const criteria: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};
  ordered.forEach((t, i) => {
    const ask = lastQuestion(t);
    const description = [
      `${t.recalled ? "按内容召回的较早任务" : `第${i + 1}近`}（${time(t.created_at, now)}）「${clip(t.title, 40)}」状态 ${t.status}`,
      `用户原话：${clip(t.input_text, 200)}`,
      ask ? `助理最后问用户：${ask}` : "",
      t.result ? `结果摘要：${clip(t.result, 200)}` : "",
      t.latestMessage && t.latestMessage !== t.result ? `最新助理消息：${clip(t.latestMessage, 200)}` : "",
    ].filter(Boolean).join("；");
    const mode = ["planning", "waiting", "queued", "running"].includes(t.status) ? "steer"
      : ["completed", "failed", "interrupted", "unknown"].includes(t.status) || (t.status === "needs_input" && !!t.turn_id) ? "resume" : null;
    if (mode) criteria[`${mode}:${t.id}`] = description;
    questions[`relevance:${t.id}`] = {
      criteria: { related: "这条消息与该任务的用户消息、结果或最新进展直接相关", unrelated: "仅有表面词汇重合，或是独立的新事项" },
      instructions: { goal: `单独评估本条消息与任务 ${t.id} 的语义相关性，不与其他任务的分数做归一化。`, task: description },
    };
  });
  criteria[NEW_TASK] = "作为新任务处理；可以参考旧任务的背景或结果，但本次有独立目标和交付物";
  return {
    state: { now: new Date(now).toISOString(), main_session_timeline: formatTimeline(entries, now), message: clip(message, 2000) },
    questions: {
      ...questions,
      route: {
        criteria,
        instructions: {
          goal: "建议本消息按独立新任务处理，还是继续某个存量业务。steer 表示追加到仍在执行的任务；resume 表示开启同一执行会话的新轮次。只给建议，由 Luna 最终决定。",
          rules: [
            "按主会话时间线的先后理解：越接近本消息的对话越可能是它的对象。",
            "简短的确认或回复（如“已授权”“可以”“好的”“就这个”“第二个”“改成周六”）回应的是时间上最近一次向用户提问或请求确认的任务。",
            "消息明确点名了某个任务里的实体（人名、地点、商品、文件、网站）时，以点名的为准，即使它不是最近的（包括按内容召回的较早任务）。",
            "只是关键词与旧任务重合，或虽借鉴旧结果但要做独立新目标时，选 NEW。",
          ],
        },
      },
    },
  };
}
