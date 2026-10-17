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
  /** An earlier turn of the session `taskId` now leads (that task resumed this one's session). */
  session?: boolean;
}

/** How a session that several tasks continued in turn began; its latest task stands for it in dispatch. */
export interface SessionInfo {
  turns: number;
  /** The first task's title and request. */
  title: string;
  request: string;
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
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/**
 * The timeline as lines an executor can read: when, what the user said, which task, what it last asked,
 * and, given Jev's reading of this message, how likely it continues that task.
 */
export function formatTimeline(entries: TimelineEntry[], now = Date.now(), relevance?: JevRelevance | null): string {
  const likely = new Map(relevance?.ranked.map((r) => [r.id, r.p]));
  return entries
    .map((e) => {
      // A scheduled run's instruction is labelled as such: the user did not type it.
      const head = `${e.current ? "▶ " : "  "}[${time(e.at, now)}] ${e.scheduled ? "Scheduled run" : "User"}: "${e.text}"`;
      if (e.current) return `${head}  ← this ${e.scheduled ? "run" : "message"}`;
      const where = e.session ? `an earlier turn of the session task ${e.taskId} "${clip(e.title, 30)}" (${e.status}) continues`
        : e.taskId === e.id ? `task ${e.taskId} "${clip(e.title, 30)}" (${e.status})` : `supplement to task ${e.taskId} "${clip(e.title, 30)}" (${e.status})`;
      const p = likely.get(e.taskId);
      return `${head} → ${where}${e.ask ? `; the assistant last asked: "${e.ask}"` : ""}${p === undefined ? "" : ` [Jev: relevance ${percent(p)}]`}`;
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
  /** Jev's advice; the dispatcher still makes the final routing decision. */
  suggestion?: { kind: "new" | "steer" | "resume"; taskId: string | null; probability: number };
  /** Full model answers supplied to the dispatcher and the executor for auditability. */
  answers?: Record<string, JevAnswer>;
}

/**
 * Jev's reading as lines for the executor: each likely task with its time, status and what it left
 * (its open question, or the start of its result), so the executor can build on it instead of redoing it.
 */
export function formatRelevance(relevance: JevRelevance, get: (id: string) => ContextTask | null | undefined, now = Date.now()): string | null {
  const suggestion = relevance.suggestion;
  const lines = [
    ...(suggestion ? [`- Jev suggests: ${suggestion.kind === "new" ? "a new task" : `${suggestion.kind === "steer" ? "append to" : "resume"} task ${suggestion.taskId}`} (${percent(suggestion.probability)}, ${relevance.confident ? "high confidence" : "uncertain"}); the dispatcher decides.`] : []),
    ...relevance.ranked.flatMap(({ id, p }) => {
    const mark = id === relevance.choice ? `, Jev's first choice${relevance.confident ? " (high confidence)" : ""}` : "";
    if (id === NEW_TASK) return [`- A separate new request: ${percent(p)}${mark}`];
    const t = get(id);
    if (!t) return [];
    const ask = lastQuestion(t);
    const left = ask ? `; the assistant last asked: "${ask}"` : t.result ? `; result begins: ${clip(t.result, 120)}` : "";
    return [`- Task ${t.id} "${clip(t.title, 30)}" (${t.status}, ${time(t.created_at, now)}): ${percent(p)}${mark}${left}`];
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
export function routingQuestion(message: string, candidates: Array<ContextTask & { clarification?: string | null; recalled?: boolean; turn_id?: string | null; latestMessage?: string | null; session?: SessionInfo }>, entries: TimelineEntry[], now = Date.now()): { state: Record<string, unknown>; questions: Record<string, JevQuestion> } {
  const byTime = [...candidates].sort((a, b) => b.created_at - a.created_at);
  // The latest tasks by rank, then the older ones recall found by what the message says.
  const ordered = [...byTime.filter((t) => !t.recalled), ...byTime.filter((t) => t.recalled)];
  const criteria: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};
  ordered.forEach((t, i) => {
    const ask = lastQuestion(t);
    const description = [
      `${t.recalled ? "Earlier task recalled by content" : `${ordinal(i + 1)} most recent`} (${time(t.created_at, now)}) "${clip(t.title, 40)}", status ${t.status}`,
      t.session ? `Latest turn of one execution session (${t.session.turns} turns so far), which began with "${clip(t.session.title, 40)}": ${clip(t.session.request, 160)}` : "",
      `User's words: ${clip(t.input_text, 200)}`,
      ask ? `The assistant last asked the user: ${ask}` : "",
      t.result ? `Result summary: ${clip(t.result, 200)}` : "",
      t.latestMessage && t.latestMessage !== t.result ? `Latest assistant message: ${clip(t.latestMessage, 200)}` : "",
    ].filter(Boolean).join("; ");
    const mode = ["planning", "waiting", "queued", "running"].includes(t.status) ? "steer"
      : ["completed", "failed", "interrupted", "unknown"].includes(t.status) || (t.status === "needs_input" && !!t.turn_id) ? "resume" : null;
    if (mode) criteria[`${mode}:${t.id}`] = description;
    questions[`relevance:${t.id}`] = {
      criteria: { related: "This message is directly related to the task's user message, result or latest progress", unrelated: "Only superficial word overlap, or a separate new matter" },
      instructions: { goal: `Assess the semantic relevance of this message to task ${t.id} on its own, without normalizing against other tasks' scores.`, task: description },
    };
  });
  criteria[NEW_TASK] = "Handle as a new task; it may draw on an earlier task's background or results, but this time it has its own goal and deliverable";
  return {
    state: { now: new Date(now).toISOString(), main_session_timeline: formatTimeline(entries, now), message: clip(message, 2000) },
    questions: {
      ...questions,
      route: {
        criteria,
        instructions: {
          goal: "Suggest whether this message should be handled as a separate new task or continue an existing piece of work. steer means appending to a task that is still running; resume means starting a new turn in the same execution session. Only suggest; the dispatcher makes the final decision.",
          rules: [
            "Read the main-session timeline in order: the closer a conversation is to this message, the more likely it is what the message is about.",
            "A short confirmation or reply (e.g. \"已授权\" (authorized), \"可以\" (OK), \"好的\" (sure), \"就这个\" (this one), \"第二个\" (the second), \"改成周六\" (make it Saturday)) answers the task that most recently asked the user a question or for confirmation.",
            "When the message explicitly names an entity from a task (a person, place, product, file or website), the named one wins even if it is not the most recent (including earlier tasks recalled by content).",
            "When it only shares keywords with an earlier task, or draws on an earlier result for a separate new goal, choose NEW.",
          ],
        },
      },
    },
  };
}
