import { isMember } from "../auth/policy.js";
import type { Jev } from "../jev.js";
import {readSoul} from '../soul.js';
import { JsonRpcResponseError } from "../codex/jsonrpc.js";
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import { randomId } from "../auth/passwords.js";
import { AgentManager, TurnConflictError, type AgentEvent, type CodexSessionLike, type TurnAttachment } from "../codex/manager.js";
import { normalizeResource, resolveResources, type ResourceSandbox } from "./resources.js";
import { applyTaskReference, parsePlan, parseSearch, planningPrompt, resourcesConflict, type DispatchHint, type PlanningTask, type PlanReport, type TaskPlan } from "./planning.js";
import { recordRecall, STEP_ANSWER_CHARS, STEP_PROMPT_CHARS, TaskRecall, type RecallEvent, type RecallSource } from "./recall.js";
import { formatTimeline, lastQuestion, routingQuestion, timeline } from "./context.js";
import { confident } from "../jev.js";
import { describeNow, describeSchedule, formatWhen, MAX_ACTIVE_SCHEDULES, nextRun, validateSchedule, type ScheduleSpec } from "./schedules.js";
import type { PlanningSchedule, ScheduleActionName } from "./planning.js";

/** The dispatcher may ask to search past tasks at most this many times per message. */
const MAX_SEARCH_ROUNDS = 2;
/** Today's tasks beyond the recent window, and context-driven recall, are kept small. */
const TODAY_EXTRA = 10;
const CONTEXT_RECALL = 3;
const SHORT_MESSAGE = 30;
/** Jev weighs the latest tasks and, beyond them, every task recall found for the message. */
const JEV_RECENT = 15;
const RECALLED = new Set<RecallSource>(["recall", "context"]);
interface TaskRow {
    revision: number;
    id: string;
    client_message_id: string;
    conversation_id: string;
    execution_conversation_id: string | null;
    turn_id: string | null;
    title: string;
    input_text: string;
    attachments_json: string;
    related_task_id: string | null;
    merged_into: string | null;
    status: string;
    plan_json: string | null;
    model: string | null;
    effort: string | null;
    result: string | null;
    error: string | null;
    created_at: number;
    completed_at: number | null;
    schedule_id: string | null;
}
interface ScheduleRow {
    id: string;
    owner_id: string;
    title: string;
    instruction: string;
    spec_json: string;
    timezone: string;
    resources_json: string;
    status: "active" | "paused" | "done";
    next_run_at: number | null;
    last_run_at: number | null;
    last_task_id: string | null;
    run_count: number;
    source_task_id: string | null;
    created_at: number;
    updated_at: number;
    builtin: string | null;
}
/** The built-in daily feed: a schedule every account gets. */
const DAILY_FEED = "daily_feed";
const FEED_SPEC: ScheduleSpec = { kind: "daily", at: "08:00" };
/** The machine-readable lines a feed run ends with; never shown to the person. */
const FEED_TOPICS = /<!--\s*feed-topics:\s*(\[[\s\S]*?\])\s*-->/;
const FEED_EMPTY = /<!--\s*feed-empty\s*-->/;
const FEED_MARKERS = /\s*<!--\s*feed-(?:topics:[\s\S]*?|empty\s*)-->\s*/g;
/** How often due schedules are checked; a run starts at most this late. */
const SCHEDULE_TICK_MS = 30_000;
/** A previous run in one of these states no longer holds the next one back. */
const RUN_SETTLED = new Set(["completed", "failed", "interrupted", "unknown", "needs_input", "planning_failed", "blocked", "merge_failed", "merge_unknown", "merged"]);
export interface TaskInput {
    userId?: string;
    text: string;
    clientMessageId: string;
    attachments?: TurnAttachment[];
    relatedTaskId?: string | null;
}
const TERMINAL = new Set(["completed", "failed", "interrupted", "unknown"]);
const DISPATCHED = new Set(["queued", "running", "stopping"]);
/** The main inbox owns delegation; manual continuations reuse the same executor thread. */
export class TaskService {
    #closed = false;
    #planning = false;
    #merging = false;
    #mergeAgain = false;
    #scheduled = false;
    #ticker: ReturnType<typeof setInterval> | null = null;
    /** Told when a task finishes, fails or needs an answer (phone notifications). */
    #notifier: ((task: ReturnType<TaskService["view"]>) => void) | null = null;
    readonly recall: TaskRecall;
    constructor(private db: Db, private cfg: Config, private agent: AgentManager, private codex: CodexSessionLike, private resourceSandbox?: ResourceSandbox, private jev?: Jev) { this.recall = new TaskRecall(db); }
    init(): void {
        // AgentManager reconciles in-flight turns before this runs. Never replay an
        // executor with uncertain side effects. Unsubmitted planning is safe to resume.
        this.db.prepare("UPDATE tasks SET status='merge_unknown',error=? WHERE status='steering'").run("重启前的补充消息是否送达无法确认，请核对任务结果，不会自动重发。");
        for (const row of this.rows()) {
            if (row.turn_id && !row.merged_into && !TERMINAL.has(row.status))
                this.syncTurn(row);
        }
        this.agent.events.on("event", this.onEvent);
        this.schedule();
        this.ensureDailyFeed();
        this.#ticker = setInterval(() => this.runDueSchedules(), SCHEDULE_TICK_MS);
        this.#ticker.unref?.();
        this.runDueSchedules();
    }
    close(): void { this.#closed = true; this.agent.events.off("event", this.onEvent); if (this.#ticker) clearInterval(this.#ticker); }
    private rows(): TaskRow[] { return this.db.prepare("SELECT * FROM tasks WHERE (? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE owner_id=?)) ORDER BY created_at, id").all(this.cfg.runtimeUserId ?? null, this.cfg.runtimeUserId ?? null) as unknown as TaskRow[]; }
    get(id: string): TaskRow | null { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow ?? null; }
    ownerId(row: TaskRow): string { return this.agent.getConversation(row.conversation_id)!.owner_id; }
    belongsTo(id: string, userId: string): boolean { const row = this.get(id); return !!row && this.ownerId(row) === userId; }
    private executor(row: TaskRow): string { return row.execution_conversation_id ?? row.conversation_id; }
    /** The identity a task's browser tabs are recorded under: its execution conversation. */
    browserKey(id: string): string | null { const row = this.get(id); return row ? this.executor(row) : null; }
    /** Referencing an old result while its resumed turn runs supplements that turn. */
    private referenceTarget(row: TaskRow): TaskRow | null {
        const ref = row.related_task_id ? this.get(row.related_task_id) : null;
        if (!ref) return null;
        const same = this.rows().filter(t => t.id !== row.id && t.created_at < row.created_at && !t.merged_into && this.executor(t) === this.executor(ref));
        return same.filter(t => ["planning", "needs_input", "waiting", "queued", "running", "stopping"].includes(t.status)).at(-1) ?? ref;
    }
    setNotifier(notifier: ((task: ReturnType<TaskService["view"]>) => void) | null): void { this.#notifier = notifier; }
    /** Tell the notifier about a status this task just reached, if it is news for the person. */
    private notifyChange(id: string, before: string): void {
        const row = this.get(id);
        if (!row || row.status === before || row.merged_into || !this.#notifier) return;
        // A daily feed with nothing to say stays silent on the phone.
        if (row.schedule_id && FEED_EMPTY.test(row.result ?? "") && this.scheduleRow(row.schedule_id)?.builtin === DAILY_FEED) return;
        if (["completed", "failed", "unknown", "needs_input"].includes(row.status)) {
            try { this.#notifier(this.view(row)); } catch { /* a notification never breaks the task flow */ }
        }
    }
    /** The task whose execution session this conversation is (the newest one sharing it). */
    taskForConversation(conversationId: string): { id: string; title: string } | null {
        const row = this.db.prepare("SELECT id,title FROM tasks WHERE COALESCE(execution_conversation_id,conversation_id)=? AND merged_into IS NULL ORDER BY created_at DESC LIMIT 1").get(conversationId) as { id: string; title: string } | undefined;
        return row ?? null;
    }
    hasRunning(): boolean { return this.rows().some(t => DISPATCHED.has(t.status)); }
    ownsConversation(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM tasks WHERE conversation_id=?").get(id); }
    view(row: TaskRow) {
        const plan = row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null;
        const turn = row.turn_id ? this.db.prepare("SELECT started_at FROM turns WHERE id=?").get(row.turn_id) as { started_at: number | null } | undefined : undefined;
        const parent = row.merged_into ? this.get(row.merged_into) : null;
        return {
            id: row.id, revision: row.revision, title: row.title, text: row.input_text, conversationId: this.executor(parent ?? row), mergedInto: row.merged_into, mergedTitle: parent?.title ?? null,
            status: row.status, result: TERMINAL.has(row.status) ? this.shownResult(row) : null, error: row.error,
            attachments: JSON.parse(row.attachments_json) as TurnAttachment[], relatedTaskId: row.related_task_id,
            relatedTaskTitle: row.related_task_id ? this.get(row.related_task_id)?.title ?? null : null,
            description: plan?.description ?? null,
            waitReason: this.waitReason(row),
            clarification: row.status === "needs_input" ? plan?.clarification ?? null : null,
            options: row.status === "needs_input" ? plan?.options ?? null : null,
            dependencies: plan?.dependencies ?? [], createdAt: row.created_at, startedAt: turn?.started_at ?? null, completedAt: row.completed_at,
            schedule: row.schedule_id ? this.scheduleLabel(row.schedule_id) ?? { id: row.schedule_id, title: row.title, rule: "定时任务已删除" } : null,
            approvals: TERMINAL.has(row.status) ? 0 : this.agent.listPendingRequests(this.executor(row)).length,
        };
    }
    private claims(row: TaskRow, plan?: TaskPlan): string[] {
        const p = plan ?? (row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null);
        if (!p) return ["all"];
        return [...new Set([...p.resources, `write:${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}`, ...(p.ownedResources ?? [])])];
    }
    private waitReason(row: TaskRow): { label: string; message: string } | null {
        if (!["waiting", "merging"].includes(row.status) || !row.plan_json) return null;
        const plan = JSON.parse(row.plan_json) as TaskPlan;
        const reference = this.referenceTarget(row);
        if (reference?.status === "stopping") return { label: "等待原任务停止", message: `“${reference.title}”停止后继续处理本次要求。` };
        const dependency = plan.dependencies.map(id => this.get(id)).find(t => t && t.status !== "completed");
        if (dependency) return { label: "等待前置任务", message: `等待“${dependency.title}”完成后继续。` };
        const parent = row.merged_into ? this.get(row.merged_into) : null;
        const claims = parent ? [...this.claims(parent), ...this.claims(row)] : this.claims(row);
        const active = this.rows().filter(t => DISPATCHED.has(t.status) && t.id !== parent?.id);
        const blocker = active.find(t => resourcesConflict(claims, this.claims(t)));
        if (blocker) {
            const browser = claims.includes("browser") && this.claims(blocker).includes("browser");
            return { label: browser ? "等待浏览器" : "等待文件操作", message: `${this.ownerId(blocker) === this.ownerId(row) ? `“${blocker.title}”` : "另一项任务"}正在使用${browser ? "共享浏览器" : "同一文件范围或共享环境"}，结束后自动继续。` };
        }
        if (!parent && active.length >= this.cfg.agent.maxConcurrentTurns) return { label: "等待执行空位", message: `已有 ${this.cfg.agent.maxConcurrentTurns} 个任务执行中，空位释放后自动开始。` };
        return { label: parent ? "正在追加" : "即将开始", message: parent ? "正在将补充交给原任务。" : "已满足执行条件，正在调度。" };
    }
    list(before = Number.MAX_SAFE_INTEGER, userId = "owner_1") {
        const rows = this.db.prepare("SELECT * FROM tasks WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) AND created_at < ? ORDER BY created_at DESC LIMIT 101").all(userId, before) as unknown as TaskRow[];
        const page = rows.slice(0, 100);
        const nextBefore = rows.length > 100 ? page.at(-1)!.created_at : null;
        // Polls must also update older unfinished work after a long burst of messages.
        const pending = before === Number.MAX_SAFE_INTEGER ? this.db.prepare("SELECT * FROM tasks WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) AND status NOT IN ('completed','failed','interrupted','unknown','merged')").all(userId) as unknown as TaskRow[] : [];
        // An old running task can finish outside the admission-time page. Keep
        // recent reports in the live feed too, so it never gets stuck at Working.
        const finished = before === Number.MAX_SAFE_INTEGER ? this.db.prepare("SELECT * FROM tasks WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 100").all(userId) as unknown as TaskRow[] : [];
        const merged = new Map([...page, ...pending, ...finished].map(r => [r.id, r]));
        return { tasks: [...merged.values()].sort((a, b) => a.created_at - b.created_at).map(r => this.view(r)), nextBefore };
    }
    submit(input: TaskInput) {
        const userId = input.userId ?? "owner_1";
        const text = input.text.trim();
        const attachments = input.attachments ?? [];
        const requestedRelated = input.relatedTaskId ? this.get(input.relatedTaskId) : null;
        const related = requestedRelated?.merged_into ?? input.relatedTaskId ?? null;
        if (!text && !attachments.length)
            throw new Error("消息不能为空");
        if (text.length > 64000 || attachments.length > 6 || !input.clientMessageId || input.clientMessageId.length > 200)
            throw new Error("消息或附件超出限制");
        const existing = this.db.prepare("SELECT * FROM tasks WHERE client_message_id = ?").get(input.clientMessageId) as unknown as TaskRow | undefined;
        if (existing) {
            if (this.ownerId(existing) !== userId) throw new TurnConflictError("消息 ID 已被使用");
            if (existing.input_text !== text || existing.attachments_json !== JSON.stringify(attachments) || existing.related_task_id !== related)
                throw new TurnConflictError("消息 ID 已对应另一项任务");
            return { task: this.view(existing), duplicate: true };
        }
        if (related && !this.belongsTo(related, userId))
            throw new Error("关联任务不存在");
        const frozen = isMember(this.db, userId) ? this.agent.memberSettings() : this.agent.resolveSubmitSettings({ conversationId: "main", text, clientMessageId: input.clientMessageId });
        const id = randomId("task");
        const title = [...(text || attachments.map(a => a.name ?? a.path).join("、"))].slice(0, 40).join("");
        // One transaction prevents a failed admission leaving an orphan child.
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const conv = this.agent.createConversation({ ownerId: userId, title: `任务：${title}`, model: frozen.model });
            const last = this.db.prepare("SELECT MAX(created_at) AS n FROM tasks").get() as {
                n: number | null;
            };
            const now = Math.max(Date.now(), (last.n ?? 0) + 1);
            this.db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,attachments_json,related_task_id,model,effort,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
                .run(id, input.clientMessageId, conv.id, title, text, JSON.stringify(attachments), related, frozen.model, frozen.effort, now);
            if (related) this.db.prepare("UPDATE tasks SET execution_conversation_id=? WHERE id=?").run(this.executor(this.get(related)!), id);
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
        this.schedule();
        return { task: this.view(this.get(id)!), duplicate: false };
    }
    async stop(id: string) {
        const row = this.get(id);
        if (!row)
            throw new Error("任务不存在");
        if (row.merged_into && row.status !== "merging") throw new Error("补充已经发送或送达状态待确认；如需停止执行，请停止原任务。");
        if (TERMINAL.has(row.status))
            return;
        if (!row.turn_id) {
            this.db.prepare("UPDATE tasks SET status='interrupted',completed_at=? WHERE id=?").run(Date.now(), id);
        }
        else {
            const result = await this.agent.interrupt(this.executor(row));
            if (!result.ok)
                throw new Error(result.message);
            // An interrupt may complete synchronously; never replace a settled result.
            if (!TERMINAL.has(this.get(id)!.status))
                this.db.prepare("UPDATE tasks SET status='stopping' WHERE id=?").run(id);
        }
        this.schedule();
    }
    retryPlanning(id: string) {
        const row = this.get(id);
        if (!row || row.status !== "planning_failed" || row.turn_id)
            throw new Error("只有尚未执行的派单失败任务可以重试");
        this.db.prepare("UPDATE tasks SET status='planning',error=NULL WHERE id=?").run(id);
        this.schedule();
    }
    private schedule() {
        if (this.#closed || this.#scheduled)
            return;
        this.#scheduled = true;
        queueMicrotask(() => {
            this.#scheduled = false;
            if (this.#closed)
                return;
            void this.deliverSupplements();
            this.dispatch();
            void this.planNext();
        });
    }
    private async planNext() {
        if (this.#closed || this.#planning)
            return;
        const row = this.rows().find(t => t.status === "planning");
        if (!row)
            return;
        this.#planning = true;
        const started = Date.now();
        let measured = false;
        const trace: RecallEvent = { taskId: row.id, ownerId: this.ownerId(row), candidates: [], searches: [], rounds: 0, chosen: { related: [], appendTo: null }, gold: null, latencyMs: 0, promptChars: 0, failed: true, steps: [] };
        const steps = trace.steps!;
        try {
            // A tapped answer to a pending question needs no dispatch: it goes straight back to that task.
            const asked = row.related_task_id ? this.get(row.related_task_id) : null;
            const askedPlan = asked?.status === "needs_input" && asked.plan_json ? JSON.parse(asked.plan_json) as TaskPlan : null;
            if (asked && askedPlan?.options?.includes(row.input_text.trim()) && !(JSON.parse(row.attachments_json) as unknown[]).length) {
                const plan: TaskPlan = { title: [...row.input_text.trim()].slice(0, 40).join(""), description: `回答“${askedPlan.clarification ?? asked.title}”`, related: [asked.id], dependencies: [], resources: [], appendTo: asked.id, resume: null, clarification: null };
                this.db.prepare("UPDATE tasks SET title=?,plan_json=?,merged_into=?,status='merging',error=NULL WHERE id=?").run(plan.title, JSON.stringify(plan), asked.id, row.id);
                return;
            }
            const everything = this.rows().filter(t => this.ownerId(t) === this.ownerId(row));
            const all = everything.filter(t => !t.merged_into && t.created_at < row.created_at).map(t => ({...t,input_text:this.taskContext(t),clarification:t.status === "needs_input" && t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).clarification ?? null : null}));
            const byId = new Map(all.map(t => [t.id, t]));
            const candidates = new Map<string, PlanningTask & { source: RecallSource; rank?: number; score?: number }>();
            const add = (t: PlanningTask, source: RecallSource, hit?: { rank: number; score: number }) => {
                if (!candidates.has(t.id)) candidates.set(t.id, { ...t, source, ...(hit ? { rank: hit.rank, score: Math.round(hit.score * 100) / 100 } : {}) });
            };
            // Keep unresolved questions and active work visible even after a
            // burst of unrelated messages; free-text replies have no task picker.
            for (const t of all.filter(t => t.status === "needs_input" || DISPATCHED.has(t.status)).slice(-24)) add(t, "active");
            for (const t of all.slice(-12)) add(t, "recent");
            const windowIds = new Set(candidates.keys());
            const explicit = row.related_task_id ? this.get(row.related_task_id) : null;
            const inputContext = this.taskContext(row);
            this.recall.forget(everything.filter(t => t.merged_into).map(t => t.id));
            this.recall.sync(all.map(t => ({ id: t.id, ownerId: trace.ownerId, title: t.title, body: t.input_text, result: t.result })));
            // Recall before the dispatcher asks, and its own searches, each add at most `cap` tasks in total.
            const cap = this.recall.cap();
            const budget = { pre: cap, search: cap };
            const recalled = (query: string, source: RecallSource, pool: keyof typeof budget, limit = budget[pool]) => {
                const take = Math.min(limit, budget[pool]);
                if (take <= 0) return;
                for (const hit of this.recall.search(trace.ownerId, query, { exclude: new Set([row.id, ...candidates.keys()]), cap: take })) {
                    const t = byId.get(hit.id);
                    if (t) { add(t, source, hit); budget[pool] -= 1; }
                }
            };
            if (explicit) {
                if (!candidates.has(explicit.id)) add({...explicit,input_text:this.taskContext(explicit),clarification:explicit.status === "needs_input" && explicit.plan_json ? (JSON.parse(explicit.plan_json) as TaskPlan).clarification ?? null : null}, "explicit");
                // A task pointed at by hand is the answer search should have found: measure where it ranks.
                const rank = this.recall.rank(trace.ownerId, inputContext).find(h => h.id === explicit.id)?.rank ?? null;
                trace.gold = { id: explicit.id, rank, inWindow: windowIds.has(explicit.id) };
            } else {
                // Today's work is the likeliest context of a new message: inject what the window missed.
                const today = new Date(row.created_at).toDateString();
                for (const t of all.filter(t => new Date(t.created_at).toDateString() === today).slice(-(12 + TODAY_EXTRA))) add(t, "today");
                // Recall by the message itself, before the dispatcher has to ask.
                recalled(inputContext, "recall", "pre");
                // A terse follow-up ("改一下那个") says little on its own: recall by today's latest topics too.
                const latestToday = all.filter(t => new Date(t.created_at).toDateString() === today).slice(-3);
                if (inputContext.trim().length < SHORT_MESSAGE && latestToday.length)
                    recalled(`${inputContext}\n${latestToday.map(t => t.title).join("\n")}`, "context", "pre", CONTEXT_RECALL);
            }
            const files = [row,...this.rows().filter(t=>t.merged_into===row.id && t.status==='merged')]
                .flatMap(t=>JSON.parse(t.attachments_json) as TurnAttachment[]);
            const planningInput = [inputContext, ...(files.length ? [`已有附件（执行者可以读取其中资料）：${JSON.stringify(files)}`] : [])].filter(Boolean).join("\n\n");
            const soul = readSoul(this.cfg).content;
            // The dispatcher runs on the provider the task was submitted for: a
            // member on its assigned model, and an owner who picked a bridge model
            // is dispatched on that model too, not on the ChatGPT account.
            const bridgeModel = this.agent.usesBridgeModel(row.model) ? row.model : null;
            const ask = (prompt: string) => isMember(this.db, this.ownerId(row))
                ? this.codex.planTask?.(prompt, soul, this.agent.memberSettings().model)
                : bridgeModel
                    ? this.codex.planTask?.(prompt, soul, bridgeModel)
                    : this.codex.planTask?.(prompt, soul);
            // The conversation in order, and Jev's second opinion on which task this message continues.
            const timelineText = formatTimeline(timeline(everything, row), row.created_at);
            const scheduling = { now: Date.now(), timezone: this.cfg.browser.timezone, schedules: this.planningSchedules(trace.ownerId) };
            steps.push({ kind: "context", at: Date.now(), timeline: timelineText, candidates: candidates.size });
            let hint: DispatchHint | null = null;
            if (!explicit && candidates.size && this.jev?.enabled) {
                // The latest tasks, plus the older ones recalled by what the message says: a message
                // that names an old task's subject must be able to land on it.
                const byTime = [...candidates.values()].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
                const pool = [...byTime.filter(t => !RECALLED.has(t.source)).slice(0, JEV_RECENT), ...byTime.filter(t => RECALLED.has(t.source))]
                    .map(t => ({ ...byId.get(t.id)!, ...t, input_text: t.input_text, recalled: RECALLED.has(t.source) }));
                const q = routingQuestion(inputContext, pool, timeline(everything, row), row.created_at);
                const criteria = q.questions.target!.criteria;
                try {
                    const r = await this.jev.decide(q.state, q.questions, { timeoutMs: this.cfg.jev.dispatchTimeoutMs });
                    const a = r.answers.target!;
                    hint = { choice: a.choice, probability: a.probabilities[a.choice] ?? 0, confident: confident(a) };
                    trace.jev = { ...hint, latencyMs: r.latencyMs };
                    steps.push({ kind: "jev", at: Date.now(), criteria, result: { choice: a.choice, probabilities: a.probabilities, confident: hint.confident, latencyMs: r.latencyMs } });
                } catch (err) {
                    trace.jev = { error: err instanceof Error ? err.message : String(err) };
                    steps.push({ kind: "jev", at: Date.now(), criteria, error: trace.jev.error });
                }
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
            }
            let raw: string | null | undefined;
            let previous: PlanningTask[] = [];
            // Agentic recall: the dispatcher may answer with keywords to search all past
            // tasks; it is asked again with the hits, a bounded number of times.
            for (;;) {
                trace.rounds += 1;
                const canSearch = !explicit && trace.rounds <= MAX_SEARCH_ROUNDS;
                previous = [...candidates.values()];
                const prompt = planningPrompt(planningInput, explicit ? previous.filter(t => t.id === explicit.id) : previous, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir, { canSearch, searched: trace.searches }, { timeline: timelineText, hint, now: describeNow(scheduling.now, scheduling.timezone), timezone: scheduling.timezone, schedules: scheduling.schedules });
                trace.promptChars += prompt.length;
                // The dispatcher runs on the sandbox Codex: a container stopped for idleness starts first.
                await this.agent.ensureSandbox();
                raw = await ask(prompt);
                if (this.#closed || this.get(row.id)?.status !== "planning")
                    return;
                // A supplement may arrive while the classifier is in flight. Replan
                // with the latest input rather than dispatching an outdated decision.
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
                const queries = canSearch ? parseSearch(raw ?? null) : null;
                steps.push({ kind: "ask", at: Date.now(), round: trace.rounds, prompt: prompt.slice(0, STEP_PROMPT_CHARS), answer: raw?.slice(0, STEP_ANSWER_CHARS) ?? null, ...(queries ? { searched: queries } : {}) });
                if (!queries) break;
                trace.searches.push(...queries);
                for (const query of queries) recalled(query, "search", "search", Math.ceil(cap / queries.length));
            }
            const report: PlanReport = { repairs: [] };
            let plan = parsePlan(raw ?? null, previous, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir, report, scheduling);
            // One more chance with the reason, instead of failing the message outright.
            if (!plan) {
                trace.rounds += 1;
                const prompt = planningPrompt(planningInput, explicit ? previous.filter(t => t.id === explicit.id) : previous, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir, { canSearch: false, searched: trace.searches, correction: report.error ?? "格式不符合要求" }, { timeline: timelineText, hint, now: describeNow(scheduling.now, scheduling.timezone), timezone: scheduling.timezone, schedules: scheduling.schedules });
                trace.promptChars += prompt.length;
                raw = await ask(prompt);
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
                const first = report.error;
                steps.push({ kind: "ask", at: Date.now(), round: trace.rounds, prompt: prompt.slice(0, STEP_PROMPT_CHARS), answer: raw?.slice(0, STEP_ANSWER_CHARS) ?? null, correction: first ?? "格式不符合要求" });
                report.error = undefined;
                plan = parsePlan(raw ?? null, previous, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir, report, scheduling);
                report.repairs.unshift(`第一次回答无法使用：${first ?? "格式不符合要求"}，已重问一次`);
            }
            trace.candidates = [...candidates.values()].map(c => ({ id: c.id, source: c.source, ...(c.rank ? { rank: c.rank, score: c.score } : {}) }));
            trace.repairs = report.repairs;
            trace.failReason = report.error ?? null;
            measured = true;
            trace.latencyMs = Date.now() - started;
            if (plan) { trace.failed = false; trace.chosen = { related: plan.related, appendTo: plan.appendTo ?? null, resume: plan.resume ?? null }; steps.push({ kind: "plan", at: Date.now(), plan, repairs: report.repairs }); }
            if (!plan)
                throw new Error(`任务分配暂时失败，尚未执行。请重试分配。（派单结果无法使用：${report.error ?? "格式不符合要求"}）`);
            if (explicit) applyTaskReference(plan, this.referenceTarget(row)!);
            // Setting up or changing a schedule needs no executor: answer right here.
            if (plan.scheduleAction || (plan.schedule && !plan.schedule.runNow)) {
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
                const answer = plan.scheduleAction ? this.applyScheduleAction(trace.ownerId, plan.scheduleAction.id, plan.scheduleAction.action) : this.createSchedule(row, plan);
                this.db.prepare("UPDATE tasks SET title=?,plan_json=?,status='completed',result=?,completed_at=? WHERE id=?").run(plan.title, JSON.stringify(plan), answer, Date.now(), row.id);
                this.agent.renameConversation(row.conversation_id, plan.title);
                return;
            }
            const ownerId = plan.appendTo ?? row.id;
            const root = this.cfg.sandbox.containerWorkspaceDir;
            const owned = [`write:${root}/tasks/${ownerId}`, ...files.map(f => normalizeResource(`read:${f.path}`, root) ?? "workspace")];
            // A resumed executor may update the outputs it already created. Keep
            // those directories locked too; unrelated task directories stay isolated.
            // A message that continues a finished task (picked by hand or by the dispatcher) runs in that task's session.
            const continued = explicit ?? (plan.resume ? this.get(plan.resume) : null);
            if (continued) owned.push(...this.rows().filter(t => !t.merged_into && t.created_at < row.created_at && this.executor(t) === this.executor(continued)).map(t => `write:${root}/tasks/${t.id}`));
            // Resolve aliases in the sandbox, never against the Mac filesystem.
            if (this.resourceSandbox) {
                plan.resources = await resolveResources(plan.resources, root, this.resourceSandbox);
                plan.ownedResources = await resolveResources(owned, root, this.resourceSandbox);
            } else plan.ownedResources = owned;
            if (this.#closed || this.get(row.id)?.status !== "planning") return;
            if (this.taskContext(this.get(row.id)!) !== inputContext) return;
            if (explicit) applyTaskReference(plan, this.referenceTarget(row)!);
            if (plan.appendTo) {
                this.db.prepare("UPDATE tasks SET title=?,plan_json=?,merged_into=?,status='merging',error=NULL WHERE id=?").run(plan.title,JSON.stringify(plan),plan.appendTo,row.id);
                return;
            }
            if (!explicit && continued) this.db.prepare("UPDATE tasks SET related_task_id=?,execution_conversation_id=? WHERE id=?").run(continued.id, this.executor(continued), row.id);
            // "Do it now, and every day from now on": the schedule, then this run.
            if (plan.schedule) plan.description = this.createSchedule(row, plan, true);
            this.db.prepare("UPDATE tasks SET title=?,plan_json=?,status=?,error=NULL WHERE id=?").run(plan.title, JSON.stringify(plan), plan.clarification ? "needs_input" : "waiting", row.id);
            this.agent.renameConversation(row.conversation_id, plan.title);
            this.notifyChange(row.id, "planning");
        }
        catch (err) {
            if (!this.#closed && this.get(row.id)?.status === "planning") {
                this.db.prepare("UPDATE tasks SET status='planning_failed',error=? WHERE id=?").run(err instanceof Error ? err.message : "任务分配失败", row.id);
                if (!measured) { measured = true; trace.latencyMs = Date.now() - started; trace.failReason = err instanceof Error ? err.message : "任务分配失败"; }
                steps.push({ kind: "failed", at: Date.now(), reason: err instanceof Error ? err.message : "任务分配失败" });
            }
        }
        finally {
            this.#planning = false;
            // Only a dispatch that reached a decision (or failed to) is measured; a superseded one is not.
            if (measured) {
                try { recordRecall(this.db, trace); } catch { /* monitoring never blocks dispatch */ }
            }
            this.schedule();
        }
    }
    private taskContext(row: TaskRow): string {
        const supplements = this.db.prepare("SELECT input_text FROM tasks WHERE merged_into=? AND status='merged' ORDER BY created_at").all(row.id) as {input_text:string}[];
        const question = row.plan_json ? (JSON.parse(row.plan_json) as TaskPlan).clarification : null;
        return [row.input_text, ...(question ? [`本任务此前的问题：${question}`] : []),...supplements.map(r=>`用户补充：${r.input_text}`)].join("\n\n");
    }
    private fallbackSupplement(row: TaskRow) {
        const plan=JSON.parse(row.plan_json!) as TaskPlan;
        plan.appendTo=null;
        this.db.prepare("UPDATE tasks SET merged_into=NULL,status='waiting',plan_json=?,error=NULL WHERE id=?").run(JSON.stringify(plan),row.id);
    }
    private async deliverSupplements() {
        if(this.#closed) return;
        if(this.#merging) { this.#mergeAgain=true; return; }
        this.#merging=true;
        try {
            for(const candidate of this.rows().filter(t=>t.status==='merging')) {
                if(this.#closed) return;
                const row = this.get(candidate.id);
                if (!row || row.status !== 'merging') continue;
                const parent=row.merged_into ? this.get(row.merged_into) : null;
                if(!parent || TERMINAL.has(parent.status) || ['blocked','planning_failed'].includes(parent.status)) {
                    this.fallbackSupplement(row); this.schedule(); continue;
                }
                if(parent.status==='stopping' || !parent.plan_json) continue;
                // Answering a preflight question does not need executor slots or
                // shared resources. Persist the answer and re-evaluate the SAME task.
                if (!parent.turn_id && (parent.status === 'needs_input' ||
                    (parent.status === 'planning' && (JSON.parse(parent.plan_json) as TaskPlan).clarification))) {
                    this.db.exec('BEGIN IMMEDIATE');
                    try {
                        this.db.prepare("UPDATE tasks SET status='merged',completed_at=? WHERE id=?").run(Date.now(),row.id);
                        this.db.prepare("UPDATE tasks SET status='planning',error=NULL WHERE id=?").run(parent.id);
                        this.db.exec('COMMIT');
                    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
                    this.schedule();
                    continue;
                }
                const plan=JSON.parse(row.plan_json!) as TaskPlan;
                const dependencies = plan.dependencies.map(id => this.get(id));
                if (dependencies.some(t => !t || ['blocked','planning_failed'].includes(t.status) || (TERMINAL.has(t.status) && t.status !== 'completed'))) {
                    this.db.prepare("UPDATE tasks SET status='merge_failed',error=? WHERE id=?").run('补充所需的前置结果尚未成功，请核对后继续。', row.id);
                    continue;
                }
                if (dependencies.some(t => t!.status !== 'completed')) continue;
                const parentPlan=JSON.parse(parent.plan_json) as TaskPlan;
                const resources=[...new Set([...parentPlan.resources,...plan.resources])];
                const otherActive=this.rows().filter(t=>t.id!==parent.id && DISPATCHED.has(t.status));
                if(otherActive.some(t=>resourcesConflict([...this.claims(parent, parentPlan), ...this.claims(row, plan)],this.claims(t)))) continue;
                // Reserve the expanded resource set before sending the update.
                parentPlan.resources=resources;
                parentPlan.ownedResources=[...new Set([...(parentPlan.ownedResources ?? []),...(plan.ownedResources ?? [])])];
                parentPlan.related=[...new Set([...parentPlan.related,...plan.related.filter(id=>id!==parent.id)])];
                this.db.prepare('UPDATE tasks SET plan_json=? WHERE id=?').run(JSON.stringify(parentPlan),parent.id);
                if(!parent.turn_id) {
                    this.db.prepare("UPDATE tasks SET status='merged',completed_at=? WHERE id=?").run(Date.now(),row.id);
                    continue;
                }
                this.db.prepare("UPDATE tasks SET status='steering' WHERE id=?").run(row.id);
                try {
                    const result=await this.agent.appendTurnInput(this.executor(parent),parent.turn_id,
                        `这是用户在 ${new Date(row.created_at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })} 对当前任务的补充，请合并处理并在最终结果中覆盖，不要当作独立任务。可协作使用的资源更新为：${this.claims(parent, parentPlan).join(',')}。\n\n主会话最近的对话（按时间先后，▶ 是这条补充）：\n${formatTimeline(timeline(this.rows().filter(t => this.ownerId(t) === this.ownerId(row)), row, 6))}\n\n${row.input_text}${dependencies.length ? `\n\n补充所需的已完成任务资料：${JSON.stringify(dependencies.map(t => ({id:t!.id,result:t!.result?.slice(0,16000)})))}` : ''}`,
                        JSON.parse(row.attachments_json),resources.includes("browser"));
                    if(this.#closed) return;
                    if(result==='browser_unavailable') this.db.prepare("UPDATE tasks SET status='merge_failed',error=? WHERE id=?").run('此补充需要浏览器，但浏览器暂未恢复；原任务仍可继续，请恢复浏览器后重新补充。',row.id);
                    else if(result==='not_active') { this.fallbackSupplement(row); this.schedule(); }
                    else this.db.prepare('UPDATE tasks SET status=?,completed_at=? WHERE id=?').run(result==='accepted'?'merged':'merging',result==='accepted'?Date.now():null,row.id);
                } catch(err) {
                    if(this.#closed) return;
                    // Only an explicit RPC rejection proves that it was not delivered.
                    if(err instanceof JsonRpcResponseError && TERMINAL.has(this.get(parent.id)!.status)) { this.fallbackSupplement(row); this.schedule(); }
                    else this.db.prepare('UPDATE tasks SET status=?,error=? WHERE id=?').run(err instanceof JsonRpcResponseError?'merge_failed':'merge_unknown',
                        err instanceof JsonRpcResponseError ? `补充未被接收：${err.message}` : '补充消息的送达状态待核对，不会自动重复发送。',row.id);
                }
            }
        } finally { this.#merging=false; if(this.#mergeAgain) { this.#mergeAgain=false; this.schedule(); } }
    }
    private dispatch() {
        const rows = this.rows();
        const active = rows.filter(t => DISPATCHED.has(t.status));
        for (const row of rows.filter(t => t.status === "waiting")) {
            const reference = this.referenceTarget(row);
            if (reference?.status === "stopping") continue;
            if (reference && ["planning", "needs_input", "waiting", "queued", "running"].includes(reference.status)) {
                const supplement = JSON.parse(row.plan_json!) as TaskPlan;
                applyTaskReference(supplement, reference);
                this.db.prepare("UPDATE tasks SET merged_into=?,plan_json=?,status='merging' WHERE id=?").run(reference.id, JSON.stringify(supplement), row.id);
                this.schedule(); continue;
            }
            if (active.length >= this.cfg.agent.maxConcurrentTurns)
                break;
            const plan = JSON.parse(row.plan_json!) as TaskPlan;
            if (row.related_task_id && this.get(row.related_task_id)?.status === "stopping") continue;
            const deps = plan.dependencies.map(id => this.get(id));
            if (deps.some(d => !d || ["blocked", "planning_failed"].includes(d.status) || (TERMINAL.has(d.status) && d.status !== "completed"))) {
                this.db.prepare("UPDATE tasks SET status='blocked',error=? WHERE id=?").run("前置任务没有成功完成。请核对结果后补充一个关联任务，不会自动继续执行。", row.id);
                continue;
            }
            if (deps.some(d => d!.status !== "completed"))
                continue;
            if (active.some(t => resourcesConflict(this.claims(row, plan), this.claims(t))))
                continue;
            if (active.some(t => this.executor(t) === this.executor(row))) continue;
            const related = plan.related.map(id => this.get(id)).filter((t): t is TaskRow => !!t);
            const clock = (ts: number) => new Date(ts).toLocaleString("sv-SE", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
            const context = related.map(t => ({ id: t.id, createdAt: clock(t.created_at), message: t.input_text.slice(0, 6000), status: t.status, lastQuestionToUser: lastQuestion(t), result: t.result?.slice(0, 16000) }));
            // What this message answers: the session it continues and the question that session left open.
            const continued = row.related_task_id && row.execution_conversation_id ? this.get(row.related_task_id) : null;
            const ask = continued ? lastQuestion(continued) : null;
            const continuation = continued ? `本次消息接续任务 ${continued.id}（${clock(continued.created_at)} 创建）${ask ? `；该任务最后问用户：「${ask}」，用户这次的回复针对的就是这个问题` : "的工作"}。` : null;
            const prompt = [
                `你是 AIO Agent 主会话委派的子 agent。任务 ID：${row.id}。${row.execution_conversation_id ? "本轮恢复此前任务的同一会话，保留完整上下文；按用户的新要求继续、补充或更新，不要从零重新做。" : "只处理本任务。"}不递归委派。身份、语气和行为遵循系统层注入的 SOUL.md；对子任务同样生效，不以内部执行角色替代个人助理身份。`,
                "按请求实际需要控制工作量：普通聊天、问候、身份介绍、概念解释和可直接回答的问题，直接在消息中回答即可。不要为了完成任务而创建目录、制作文件、检查运行环境或截图验收；仅在回答确实需要外部事实、附件或既有资料时调用相关工具。身份与风格以已注入的 SOUL.md 为准，不为自我介绍额外检索记忆或寻找 SOUL.md 文件。需要依据用户过往信息时才有针对性地查相关记录。用户要求实际操作或文件交付时，仍须执行并做与风险相称的验证，不得用口头回答代替。",
                `只有确实需要写文件时才创建任务目录。新文件放在 ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/（按需创建），不要散落工作区根目录。共享工作区里可能有其他子 agent；不得覆盖无关文件，只能在本次明确授权的路径内更新已有任务产物。`,
                `本次获准使用的资源范围：${this.claims(row, plan).join(",")}。read: 只读；write: 可修改该路径及后代；workspace 表示共享环境操作。没有 browser 不操作共享浏览器；没有 workspace 不安装全局依赖或改变共享运行环境。只在声明路径内操作，不修改符号链接或通过链接越过声明范围。需要额外范围时停止并说明，不擅自扩大。沙盒命令无需审批不代表可以越过本任务范围。`,
                `如需运行工具生成临时文件、渲染输出、缓存或工具配置，放在 ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/.tmp/，设置 TMPDIR 指向该目录；LibreOffice 使用该目录下独立的 UserInstallation。不要复用或清理 /tmp/verify、/tmp/lo-final 等公共路径。结束前等待本任务的写入子进程完成，不留后台写入。`,
                "你以用户的个人助理身份交付：最终回复直接回答用户要的结论、建议、安排和交付物，先给最有用的结果，不要只说准备做。保留必要的事实来源、未完成事项与会影响用户决策的限制（如尚未预订、日期待确认）。",
                "用户明确不关心实现过程：最终回复不汇报使用了哪些 skill、工具、命令、API、子 agent 或文件创建/检查步骤；除非用户专门询问这些技术细节。需要说明的执行与验证细节放在 commentary 过程里，不要放进最终回报或交付文档。不要删掉有用的依据、链接或不确定性来假装结果更确定。",
                "默认在对话中直接给出完整回答，可使用 Markdown 排版，无需保存文件。只有用户要求文件、可下载交付物，或内容确实需要独立文档/页面承载时，才制作文件；不要仅因内容是说明、清单或计划就自动建文档。需要文件时按表达需要选择格式：普通文字、清单和简单表格可用结构清晰的 Markdown（.md）；攻略、计划、说明若需要复杂排版、图表、多栏卡片或交互，优先制作 HTML（.html）页面，不要一律用 Markdown。HTML 尽量自包含、适配手机，交付前验证实际展示；检查通过即交付，只有具体缺陷才继续修改复验。链接用有意义的中文标题，例如[完整三天行程](绝对文件路径)，不要只写下载文件或暴露冗长文件名。用户指定 Word、Excel、PPT 等格式时遵循其格式。交付文件时，最终消息给简要要点和文件链接；无文件需求时直接给出答案。",
                "主会话消息在手机上读，要像图文卡片，不要长篇纯文字：先一两句结论，再用卡片、图片和短段落展开；少用宽表格（手机上要横向滑动），只在少量数字并排对比时用。需要展示图片或视频时用 Markdown 图片语法 ![说明](绝对路径)，工作区里的 png/jpg/webp/gif/svg 图片和 mp4 视频会按所在位置嵌入消息、点开可放大；网上的图片用 ![说明](https://…)（系统经沙箱取回显示），更稳妥的是先存进本任务目录再引用。示意图、图表也可以直接写成 ```svg 代码块（完整的 <svg> 文档），消息里会显示为图片。把图片放在正文中与它相关的文字旁边，穿插说明，不要全部堆在末尾。普通文件用 [有意义的标题](绝对路径)，显示为可预览和下载的文件卡片；分享页链接会显示为可一键复制的分享卡片，直接给出链接即可。",
                "推荐、比较或汇报具体商品（也包括酒店、餐厅这类可比较、可购买或预订的条目）时，用商品卡片代替表格或纯文字，每件一张，同一个代码块里列出要比较的几件（最多 8 件）：\n```products\n[{\"name\": \"商品名\", \"image\": \"" + this.cfg.sandbox.containerWorkspaceDir + "/tasks/" + row.id + "/商品.jpg\", \"price\": \"$899\", \"was\": \"$1,199\", \"store\": \"Amazon\", \"url\": \"https://商品页\", \"rating\": \"4.4（1,203 条）\", \"badge\": \"最推荐\", \"points\": [\"决定选择的理由一\", \"理由二\"], \"note\": \"要注意的一点\"}]\n```\n图片要来自这件商品的真实页面：在浏览器打开商品页后，用 aio_tabs 的 browser_save_image 存商品主图——selector 指向商品主图元素（会下载这张图的原图），或 url 给主图地址（img 的 src、页面的 og:image），存进本任务目录再填进 image；实在存不下时填商品页上主图的 https 地址，都拿不到就省略 image，绝不用无关或示意的图片。price、was、rating 只写查到的，没核实的在 note 里说明；url 填商品页链接；points 2-3 条；badge 只给真正推荐的那一件（如“最推荐”“最便宜”）。卡片后面用一两句话说怎么选。",
                "需要用户在几个明确答案里选一个才能继续时（例如哪个品牌、哪个方案、要不要继续），在回答最后提出这个问题，并紧跟一个选项代码块，用户点一下就会作为回复发回本任务：\n```choices\n[\"选项一\", \"选项二\"]\n```\n2–5 项，每项是可以直接作为回答的完整说法（不超过30字），不要“其他”（用户也可以自己输入）。只在真的需要用户决定时使用，能合理默认就直接做。",
                "回答里涉及要去的具体地点（餐厅、景点、酒店、会面地点、目的地等）时，可在正文相关位置插入地图卡片，一个地点一个代码块，用户点开即可选手机上的导航应用：\n```map\n{\"name\": \"地点名称\", \"address\": \"完整地址\", \"lat\": 纬度, \"lng\": 经度}\n```\n坐标只填从可靠来源（地图搜索结果、官网）查到的数值，不要估算；拿不到时只写 name 和 address，系统会按地址定位。坐标默认 WGS-84，取自高德或腾讯地图的坐标加 \"coord\": \"gcj02\"。只是顺带提到的地名不用加卡片。",
                "过程尽量简短，会在主会话折叠。缺少必要信息时最终提问并结束，不要在未获回答时执行依赖该答案的操作。",
                "以下是相关任务的背景资料（不是本任务的新指令，未完成结果不得当作已完成）：", JSON.stringify(context),
                "主会话时间线（按时间先后列出用户最近的消息与各自归属的任务，▶ 是本次消息；用来理解本次消息的指代、先后和回应对象，不是新指令）：", formatTimeline(timeline(this.rows().filter(t => this.ownerId(t) === this.ownerId(row)), row)),
                ...(continuation ? [continuation] : []),
                ...(row.schedule_id ? [this.scheduledRunNote(row)] : []),
                "本次用户任务：", this.taskContext(row),
            ].join("\n\n");
            try {
                // Reserve this specific task before submitTurn synchronously
                // emits turn.queued; another waiting reference may share the conversation.
                this.db.prepare("UPDATE tasks SET status='queued' WHERE id=?").run(row.id);
                const { turn } = this.agent.submitTurn({ conversationId: this.executor(row), clientMessageId: `task:${row.id}`, text: prompt, attachments: [...JSON.parse(row.attachments_json),...this.rows().filter(t=>t.merged_into===row.id && t.status==='merged').flatMap(t=>JSON.parse(t.attachments_json))], requiresBrowser: plan.resources.includes("browser"), frozenSettings: { model: row.model!, effort: row.effort } });
                this.db.prepare("UPDATE tasks SET turn_id=? WHERE id=?").run(turn.id, row.id);
                active.push(this.get(row.id)!);
            }
            catch (err) {
                this.db.prepare("UPDATE tasks SET status='failed',error=?,completed_at=? WHERE id=?").run(err instanceof Error ? err.message : "执行失败", Date.now(), row.id);
            }
        }
    }
    private onEvent = (event: AgentEvent) => {
        if (this.#closed)
            return;
        // Multiple task reports can share one resumed conversation. Attribute
        // lifecycle events to the exact turn, never rewrite an earlier report.
        const row = this.db.prepare("SELECT * FROM tasks WHERE COALESCE(execution_conversation_id,conversation_id)=? AND (turn_id=? OR (?='turn.queued' AND turn_id IS NULL AND status='queued')) ORDER BY created_at DESC LIMIT 1").get(event.conversationId, event.turnId, event.type) as unknown as TaskRow | undefined;
        if (!row)
            return;
        if (event.type === "turn.queued")
            this.db.prepare("UPDATE tasks SET status='queued',turn_id=? WHERE id=?").run(event.turnId, row.id);
        if (event.type === "turn.codex_started") this.schedule();
        if (event.type === "turn.started")
            this.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(row.id);
        if (["turn.finished", "turn.failed", "turn.cancelled", "turn.reconciled"].includes(event.type)) {
            this.syncTurn(this.get(row.id)!);
            this.schedule();
        }
    };
    private syncTurn(row: TaskRow) {
        const turn = this.db.prepare("SELECT status,error,completed_at FROM turns WHERE id=?").get(row.turn_id) as {
            status: string;
            error: string | null;
            completed_at: number | null;
        } | undefined;
        if (!turn)
            return;
        const messages = this.db.prepare("SELECT payload FROM events WHERE turn_id=? AND type='item/completed' ORDER BY id").all(row.turn_id) as {
            payload: string;
        }[];
        const items = messages.map(m => JSON.parse(m.payload).item).filter(i => i?.type === "agentMessage" && typeof i.text === "string" && i.text.trim());
        const last = items.filter(i => i.phase === "final_answer").at(-1) ?? items.at(-1);
        this.db.prepare("UPDATE tasks SET status=?,result=?,error=?,completed_at=? WHERE id=?").run(turn.status, last?.text ?? null, turn.error, turn.completed_at, row.id);
        if (turn.status === "completed") this.recordFeed(this.get(row.id)!);
        this.notifyChange(row.id, row.status);
    }

    // ------------------------------------------------------------- schedules

    private scheduleRow(id: string): ScheduleRow | null {
        return (this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as unknown as ScheduleRow | undefined) ?? null;
    }
    private planningSchedules(ownerId: string): PlanningSchedule[] {
        return (this.db.prepare("SELECT * FROM schedules WHERE owner_id=? AND status IN ('active','paused') ORDER BY created_at").all(ownerId) as unknown as ScheduleRow[])
            .map(s => ({ id: s.id, title: s.title, rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), status: s.status }));
    }
    private scheduleLabel(id: string): { id: string; title: string; rule: string; builtin?: string } | null {
        const s = this.scheduleRow(id);
        return s ? { id: s.id, title: s.title, rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), ...(s.builtin ? { builtin: s.builtin } : {}) } : null;
    }
    /** A feed run's machine lines (topics, nothing-today) stay out of what the person reads. */
    private shownResult(row: TaskRow): string | null {
        if (!row.result || !row.schedule_id || this.scheduleRow(row.schedule_id)?.builtin !== DAILY_FEED) return row.result;
        return row.result.replace(FEED_MARKERS, "\n").trim();
    }
    /** Every account gets the daily feed once; afterwards it is the person's to pause or resume. */
    private ensureDailyFeed(): void {
        if (!this.cfg.agent.dailyFeed) return;
        const ownerId = this.cfg.runtimeUserId ?? "owner_1";
        if (!this.db.prepare("SELECT 1 FROM owners WHERE id=?").get(ownerId)) return;
        if (this.db.prepare("SELECT 1 FROM schedules WHERE owner_id=? AND builtin=?").get(ownerId, DAILY_FEED)) return;
        const tz = this.cfg.browser.timezone;
        const now = Date.now();
        this.db.prepare("INSERT INTO schedules (id,owner_id,title,instruction,spec_json,timezone,resources_json,status,next_run_at,created_at,updated_at,builtin) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)")
            .run(randomId("sched"), ownerId, "每日推送", "根据你过往的任务，整理今天你可能感兴趣的内容和需要的提醒", JSON.stringify(FEED_SPEC), tz, JSON.stringify(["browser"]), nextRun(FEED_SPEC, now, tz), now, now, DAILY_FEED);
    }
    /** Did the person send anything (not a scheduled run) since `since`? */
    private spokeSince(ownerId: string, since: number): boolean {
        return !!this.db.prepare("SELECT 1 FROM tasks WHERE schedule_id IS NULL AND created_at>=? AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) LIMIT 1").get(since, ownerId);
    }
    /** Remember what a finished feed run covered. */
    private recordFeed(row: TaskRow): void {
        if (!row.schedule_id || this.scheduleRow(row.schedule_id)?.builtin !== DAILY_FEED) return;
        let topics: string[] = [];
        try {
            const match = FEED_TOPICS.exec(row.result ?? "");
            const parsed = match ? JSON.parse(match[1]!) as unknown : [];
            topics = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string" && !!t.trim()).map(t => t.trim().slice(0, 60)).slice(0, 10) : [];
        } catch { topics = []; }
        this.db.prepare("INSERT INTO feed_history (task_id,owner_id,created_at,topics_json,empty) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET topics_json=excluded.topics_json,empty=excluded.empty")
            .run(row.id, this.ownerId(row), row.created_at, JSON.stringify(topics), FEED_EMPTY.test(row.result ?? "") ? 1 : 0);
    }
    /** What a feed run works from: every earlier task of the person, and what recent feeds said and whether anything followed. */
    private feedBrief(row: TaskRow): string {
        const ownerId = this.ownerId(row);
        const tz = this.cfg.browser.timezone;
        const date = (ts: number) => describeNow(ts, tz);
        const cut = (text: string | null, n: number) => { const c = [...(text ?? "").replace(/\s+/g, " ").trim()]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : c.join(""); };
        const mine = this.db.prepare("SELECT * FROM tasks WHERE schedule_id IS NULL AND merged_into IS NULL AND created_at<? AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) ORDER BY created_at DESC LIMIT 150").all(row.created_at, ownerId) as unknown as TaskRow[];
        const tasks = mine.map(t => ({ date: date(t.created_at), title: t.title, request: cut(t.input_text, 160), status: t.status, result: cut(t.result, 200) }));
        const feeds = this.db.prepare("SELECT * FROM feed_history WHERE owner_id=? AND created_at<? ORDER BY created_at DESC LIMIT 14").all(ownerId, row.created_at) as Array<{ created_at: number; topics_json: string; empty: number }>;
        const feedHistory = feeds.map((f, i) => {
            const until = i === 0 ? row.created_at : feeds[i - 1]!.created_at;
            const after = mine.filter(t => t.created_at > f.created_at && t.created_at < until).map(t => t.title).slice(0, 8);
            return { date: date(f.created_at), topics: JSON.parse(f.topics_json) as string[], nothingToday: !!f.empty, userTasksAfter: after };
        });
        return [
            `这是内置的「每日推送」（每天 08:00）在 ${date(row.created_at)} 的自动运行。用户此刻不在对话中。你的工作：根据用户过往的全部任务记录，挑出今天他最可能感兴趣、或需要提醒的 1-5 件事，像贴心的私人助理一样简短告诉他。`,
            "从任务记录里找线索：关注过的商品和价格（例如某款电脑、婴儿用品）、在比价或犹豫要不要买的东西、临近的日期和预约（证件、疫苗、账单、出行）、做了一半或说过以后再看的事、长期关心的话题。记录不限于最近一天，越早的兴趣越要核实是否仍然相关。",
            "需要最新信息时（价格、库存、天气、新闻）用浏览器或网络查证，只报告查到的事实并附来源链接；查不到就不写，不编造。只写有实际变化或与今天相关的事，例如“你关注的 Mac Studio 在 Best Buy 降到 $1,799，比上周低 $200”；没有变化的例行信息不写。",
            "避免打扰：参考 feedHistory（最近几次推送的话题，以及之后用户的新任务 userTasksAfter）。同一话题最近已连续推过 3 次、而之后用户没有任何相关的新任务，说明他已不再关注，停止推送这个话题，除非出现重大新变化；用户最近新任务里体现的新兴趣优先；昨天说过且没有变化的不再重复。",
            "格式：第一行“今日为你留意”，下面每件事一条，每条一两句话，必要时附链接或地图卡片，说到具体商品降价时用商品卡片（带商品图）；适合在手机上点开快速读完。今天确实没有值得说的，只回复一句“今天没有需要特别提醒的事”，并在末尾单独一行写 <!--feed-empty-->。",
            "最后单独一行写 <!--feed-topics: [\"话题1\", \"话题2\"]-->，列出本次写到的话题（简短中文，例如“Mac Studio 降价”“Roy 疫苗预约”）；系统用它调整之后的推送，用户看不到这一行。不要提问后等待，不要创建定时任务。",
            "用户的任务记录（新到旧）：", JSON.stringify(tasks),
            "推送记录 feedHistory（新到旧）：", JSON.stringify(feedHistory),
        ].join("\n\n");
    }
    /** Store one schedule for the account (the cap applies however it was asked for); its id, or why not. */
    private insertSchedule(ownerId: string, s: { title: string; instruction: string; spec: ScheduleSpec; nextRunAt: number; resources: string[]; sourceTaskId: string | null }): { id: string } | { refused: string } {
        const active = (this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE owner_id=? AND status='active' AND builtin IS NULL").get(ownerId) as { n: number }).n;
        if (active >= MAX_ACTIVE_SCHEDULES)
            return { refused: `没有创建定时任务：已有 ${active} 个进行中的定时任务（上限 ${MAX_ACTIVE_SCHEDULES} 个）。请先在「定时任务」页暂停或删除不需要的。` };
        const id = randomId("sched");
        const now = Date.now();
        this.db.prepare("INSERT INTO schedules (id,owner_id,title,instruction,spec_json,timezone,resources_json,status,next_run_at,source_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)")
            .run(id, ownerId, s.title, s.instruction, JSON.stringify(s.spec), this.cfg.browser.timezone, JSON.stringify(s.resources), s.nextRunAt, s.sourceTaskId, now, now);
        return { id };
    }
    /** What was set up, for the person. */
    private scheduleCreated(title: string, instruction: string, spec: ScheduleSpec, nextRunAt: number): string {
        const tz = this.cfg.browser.timezone;
        return [
            `已创建定时任务「${title}」：${describeSchedule(spec)}（按 ${tz} 时间），下次运行 ${formatWhen(nextRunAt, tz)}。`,
            `每次会做：${instruction}`,
            "可以在「定时任务」页暂停、立即运行或删除，也可以直接告诉我。",
        ].join("\n\n");
    }
    /** Store the schedule a plan asked for; the sentence that tells the person what was set up. */
    private createSchedule(row: TaskRow, plan: TaskPlan, runningNow = false): string {
        const planned = plan.schedule!;
        const stored = this.insertSchedule(this.ownerId(row), { title: plan.title, instruction: planned.instruction, spec: planned.spec, nextRunAt: planned.nextRunAt, resources: plan.resources, sourceTaskId: row.id });
        if ("refused" in stored) return stored.refused;
        if (runningNow) return `已创建定时任务（${describeSchedule(planned.spec)}，下次 ${formatWhen(planned.nextRunAt, this.cfg.browser.timezone)}），现在先运行一次。`;
        return this.scheduleCreated(plan.title, planned.instruction, planned.spec, planned.nextRunAt);
    }
    /**
     * An executor's schedule tool (scheduleTool.ts): set up a schedule for the account,
     * kept here and run as new tasks whatever conversation asked for it.
     */
    createScheduleFor(userId: string, input: { title?: unknown; instruction?: unknown; schedule?: unknown; needsBrowser?: unknown }): { ok: true; message: string; schedule: ReturnType<TaskService["viewSchedule"]> } | { ok: false; error: string } {
        const title = typeof input.title === "string" ? [...input.title.trim()].slice(0, 40).join("") : "";
        const instruction = typeof input.instruction === "string" ? input.instruction.trim().slice(0, 2000) : "";
        if (!title) return { ok: false, error: "title 不能为空" };
        if (!instruction) return { ok: false, error: "instruction 不能为空：写每次运行要做的事" };
        const checked = validateSchedule(input.schedule, Date.now(), this.cfg.browser.timezone);
        if ("error" in checked) return { ok: false, error: checked.error };
        const stored = this.insertSchedule(userId, { title, instruction, spec: checked.spec, nextRunAt: checked.next, resources: input.needsBrowser === false ? [] : ["browser"], sourceTaskId: null });
        if ("refused" in stored) return { ok: false, error: stored.refused };
        return { ok: true, message: this.scheduleCreated(title, instruction, checked.spec, checked.next), schedule: this.viewSchedule(this.scheduleRow(stored.id)!) };
    }
    /** Pause, resume or cancel one of the owner's schedules; the sentence that says what happened. */
    private applyScheduleAction(ownerId: string, id: string, action: ScheduleActionName): string {
        const s = this.scheduleRow(id);
        if (!s || s.owner_id !== ownerId) return "没有找到这个定时任务，可能已经删除了。";
        const now = Date.now();
        if (action === "cancel" && s.builtin) {
            this.db.prepare("UPDATE schedules SET status='paused',updated_at=? WHERE id=?").run(now, id);
            return `「${s.title}」是内置的定时任务，已为你关闭。想恢复时告诉我，或在「定时任务」页重新开启。`;
        }
        if (action === "cancel") {
            this.db.prepare("DELETE FROM schedules WHERE id=?").run(id);
            return `已取消定时任务「${s.title}」，之后不会再运行。`;
        }
        if (action === "pause") {
            this.db.prepare("UPDATE schedules SET status='paused',updated_at=? WHERE id=?").run(now, id);
            return `已暂停定时任务「${s.title}」。需要时告诉我，或在「定时任务」页恢复。`;
        }
        const next = nextRun(JSON.parse(s.spec_json) as ScheduleSpec, now, s.timezone);
        if (next === null) {
            this.db.prepare("UPDATE schedules SET status='done',next_run_at=NULL,updated_at=? WHERE id=?").run(now, id);
            return `定时任务「${s.title}」已经没有下一次运行（时间或结束日期已过），没有恢复。`;
        }
        this.db.prepare("UPDATE schedules SET status='active',next_run_at=?,updated_at=? WHERE id=?").run(next, now, id);
        return `已恢复定时任务「${s.title}」，下次运行 ${formatWhen(next, s.timezone)}。`;
    }
    /** Start every run that is due; a run missed while the service was down is made up once. */
    private runDueSchedules(): void {
        if (this.#closed) return;
        const now = Date.now();
        const due = this.db.prepare("SELECT * FROM schedules WHERE owner_id=? AND status='active' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at")
            .all(this.cfg.runtimeUserId ?? "owner_1", now) as unknown as ScheduleRow[];
        for (const s of due) {
            try { this.fireSchedule(s, now); }
            catch {
                // A run that cannot start (the model is unavailable, say) waits for the next beat.
                const next = nextRun(JSON.parse(s.spec_json) as ScheduleSpec, now, s.timezone);
                this.db.prepare("UPDATE schedules SET next_run_at=?,status=?,updated_at=? WHERE id=?").run(next, next === null ? "done" : s.status, now, s.id);
            }
        }
        if (due.length) this.schedule();
    }
    /** Start one run of a schedule (unless the previous one is still going) and move it on. */
    private fireSchedule(s: ScheduleRow, now: number, manual = false): string | null {
        const spec = JSON.parse(s.spec_json) as ScheduleSpec;
        const previous = s.last_task_id ? this.get(s.last_task_id) : null;
        // The daily feed stays quiet unless the person sent something in the past day.
        const quiet = s.builtin === DAILY_FEED && !manual && !this.spokeSince(s.owner_id, now - 24 * 3600_000);
        const busy = quiet || (!!previous && !RUN_SETTLED.has(previous.status));
        const taskId = busy ? null : this.startScheduledRun(s, previous, manual ? `manual:${now}` : String(s.next_run_at));
        const runs = s.run_count + (taskId ? 1 : 0);
        const next = manual ? s.next_run_at : nextRun(spec, now, s.timezone);
        const done = next === null || (spec.maxRuns != null && runs >= spec.maxRuns);
        this.db.prepare("UPDATE schedules SET run_count=?,last_run_at=?,last_task_id=?,next_run_at=?,status=?,updated_at=? WHERE id=?")
            .run(runs, taskId ? now : s.last_run_at, taskId ?? s.last_task_id, done ? null : next, done ? "done" : s.status, now, s.id);
        return taskId;
    }
    /** A scheduled run is already planned: the schedule's instruction, resources and the previous run as background. */
    private startScheduledRun(s: ScheduleRow, previous: TaskRow | null, key: string): string | null {
        const clientMessageId = `schedule:${s.id}:${key}`;
        if (this.db.prepare("SELECT 1 FROM tasks WHERE client_message_id=?").get(clientMessageId)) return null;
        const frozen = isMember(this.db, s.owner_id) ? this.agent.memberSettings() : this.agent.resolveSubmitSettings({ conversationId: "main", text: s.instruction, clientMessageId });
        const id = randomId("task");
        const plan: TaskPlan = {
            title: s.title, description: `定时任务（${describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec)}）的自动运行。`,
            related: previous && s.builtin !== DAILY_FEED ? [previous.id] : [], dependencies: [], resources: JSON.parse(s.resources_json) as string[],
            appendTo: null, resume: null, clarification: null, ownedResources: [`write:${this.cfg.sandbox.containerWorkspaceDir}/tasks/${id}`],
        };
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const conv = this.agent.createConversation({ ownerId: s.owner_id, title: `定时：${s.title}`, model: frozen.model });
            const last = this.db.prepare("SELECT MAX(created_at) AS n FROM tasks").get() as { n: number | null };
            const now = Math.max(Date.now(), (last.n ?? 0) + 1);
            this.db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,attachments_json,model,effort,created_at,status,plan_json,schedule_id) VALUES (?,?,?,?,?,'[]',?,?,?,'waiting',?,?)")
                .run(id, clientMessageId, conv.id, s.title, s.instruction, frozen.model, frozen.effort, now, JSON.stringify(plan), s.id);
            this.db.exec("COMMIT");
        } catch (err) { this.db.exec("ROLLBACK"); throw err; }
        return id;
    }
    private scheduledRunNote(row: TaskRow): string {
        const s = row.schedule_id ? this.scheduleRow(row.schedule_id) : null;
        if (s?.builtin === DAILY_FEED) return this.feedBrief(row);
        const n = (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE schedule_id=? AND created_at<=?").get(row.schedule_id, row.created_at) as { n: number }).n;
        const rule = s ? `（${describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec)}）` : "";
        const plan = JSON.parse(row.plan_json!) as TaskPlan;
        return `这是定时任务「${row.title}」${rule}的第 ${n} 次自动运行，${formatWhen(row.created_at, s?.timezone ?? this.cfg.browser.timezone)} 开始。用户此刻不在对话中：直接完成并汇报结果，需要用户决定或确认的事写进结果里，不要提问后等待，也不要再创建定时任务。${plan.related.length ? "背景资料里有上一次运行的结果，可以说明和上次相比的变化。" : ""}`;
    }
    private viewSchedule(s: ScheduleRow) {
        const last = s.last_task_id ? this.get(s.last_task_id) : null;
        return {
            id: s.id, title: s.title, instruction: s.instruction, rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), status: s.status,
            timezone: s.timezone, nextRunAt: s.next_run_at, nextRunText: s.next_run_at ? formatWhen(s.next_run_at, s.timezone) : null,
            lastRunAt: s.last_run_at, lastTask: last ? { id: last.id, status: last.status } : null, runCount: s.run_count, createdAt: s.created_at,
            builtin: s.builtin,
        };
    }
    listSchedules(userId: string) {
        return (this.db.prepare("SELECT * FROM schedules WHERE owner_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, next_run_at, created_at DESC").all(userId) as unknown as ScheduleRow[]).map(s => this.viewSchedule(s));
    }
    /** Pause, resume or cancel from the schedules page. */
    changeSchedule(id: string, userId: string, action: ScheduleActionName) {
        const s = this.scheduleRow(id);
        if (!s || s.owner_id !== userId) throw new Error("定时任务不存在");
        const message = this.applyScheduleAction(userId, id, action);
        const after = this.scheduleRow(id);
        return { message, schedule: after ? this.viewSchedule(after) : null };
    }
    /** One extra run right now; the regular rhythm is unchanged. */
    runScheduleNow(id: string, userId: string) {
        const s = this.scheduleRow(id);
        if (!s || s.owner_id !== userId) throw new Error("定时任务不存在");
        if (s.status === "done") throw new Error("这个定时任务已经结束");
        const taskId = this.fireSchedule(s, Date.now(), true);
        if (!taskId) throw new Error("上一次运行还没结束，结束后再试");
        this.schedule();
        return { task: this.view(this.get(taskId)!), schedule: this.viewSchedule(this.scheduleRow(id)!) };
    }
}
