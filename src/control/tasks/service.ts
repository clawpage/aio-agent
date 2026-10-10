import { createHash } from "node:crypto";
import { isMember } from "../auth/policy.js";
import type { Jev } from "../jev.js";
import {readSoul} from '../soul.js';
import { JsonRpcResponseError } from "../codex/jsonrpc.js";
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import { randomId } from "../auth/passwords.js";
import { AgentManager, TurnConflictError, type AgentEvent, type CodexSessionLike, type TurnAttachment } from "../codex/manager.js";
import { claimsConflict, resolveResources, type Claims, type ResourceSandbox } from "./resources.js";
import { applyTaskReference, parsePlan, planningPrompt, type PlanningTask, type PlanReport, type TaskPlan } from "./planning.js";
import { executorQuestion } from "./executorQuestion.js";
import { RECALL_CAP, recordRecall, STEP_ANSWER_CHARS, STEP_PROMPT_CHARS, TaskRecall, tokenize, type RecallEvent, type RecallSource } from "./recall.js";
import { processSteps, standingAgreements } from "./history.js";
import type { DispatchTimingSink } from "../codex/dispatchTiming.js";
import { dispatchAdvice, formatRelevance, formatTimeline, lastQuestion, routingQuestion, timeline, type JevRelevance } from "./context.js";
import { describeNow, describeSchedule, formatWhen, MAX_ACTIVE_SCHEDULES, nextRun, validateSchedule, type ScheduleSpec } from "./schedules.js";
import type { PlanningSchedule, ScheduleActionName } from "./planning.js";
import { ATTENTION_STATUSES, DONE_STATUSES, WORKING_STATUSES, type TaskBucket, type TaskCounts, type TaskFilter, type TaskListPage } from "../../common/taskList.js";

/** Bounded context keeps both live work and older matches in one Jev call. */
const ACTIVE_CANDIDATES = 5;
const RECENT_CANDIDATES = 5;
/** Scheduled runs (the daily feed, reminders) may take at most this many of the recent slots. */
const RECENT_SCHEDULED_CANDIDATES = 1;
const MAX_CANDIDATES = 14;
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
const FEED_AT = "08:00";
const FEED_SPEC: ScheduleSpec = { kind: "daily", at: FEED_AT };
/** Minutes between accounts' feeds: member n runs n of these after the owner's 08:00. */
const FEED_STAGGER_MINUTES = 4;
/** The feed time of an account's slot (0 is the owner's 08:00). */
export function feedTimeFor(slot: number): string {
    const minutes = 8 * 60 + slot * FEED_STAGGER_MINUTES;
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
const clockMinutes = (at: string) => { const [h, m] = at.split(":").map(Number); return h! * 60 + m!; };
/** The feed's own instruction until the person words it themselves. */
const FEED_INSTRUCTION = "根据你过往的任务，整理今天你可能感兴趣的内容和需要的提醒";
/** What the feed keeps in mind: what the person cares about, what to stop pushing, what their reactions taught it. */
type FeedMemoryKind = "care" | "avoid" | "note";
const FEED_MEMORY_KINDS: FeedMemoryKind[] = ["care", "avoid", "note"];
const FEED_MEMORY_LABEL: Record<FeedMemoryKind, string> = { care: "关心", avoid: "不再推", note: "记住" };
/** Per kind; past it the oldest have to be removed first. */
const FEED_MEMORY_MAX = 30;
const FEED_INSTRUCTION_MAX = 1500;
/** The feed reads the person's tasks of this many days, at most this many, the newest in detail. */
const FEED_TASK_DAYS = 7;
const FEED_TASK_MAX = 800;
const FEED_TASK_DETAILED = 60;
const FEED_MEMORY_TEXT_MAX = 200;
interface FeedMemoryRow { id: string; owner_id: string; kind: FeedMemoryKind; text: string; source: "user" | "feed"; created_at: number }
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
/** The task list's keyset cursor: [rank, time, id] of the last row a page held. */
const encodeCursor = (key: [number, number, string]) => Buffer.from(JSON.stringify(key)).toString("base64url");
export class TaskCursorError extends Error {}
function decodeCursor(cursor: string): [number, number, string] {
    try {
        const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
        if (Array.isArray(key) && key.length === 3 && Number.isInteger(key[0]) && Number.isFinite(key[1]) && typeof key[2] === "string") return key as [number, number, string];
    } catch { /* falls through */ }
    throw new TaskCursorError("分页位置无效");
}
/** client_message_id prefix of messages from the voice gadget (submitGadget). */
const GADGET_PREFIX = "gadget:";
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
    #releaseHumanTabs: ((key: string) => Promise<number>) | null = null;
    /** How to hand a task's browser tabs back from the person to its agent (set where the tab server lives). */
    setHumanTabRelease(release: (key: string) => Promise<number>): void { this.#releaseHumanTabs = release; }
    /**
     * A message to a task means the person is back with its agent: tabs they took over
     * are handed back, or the agent would keep waiting for a hand-back nobody gives.
     */
    private async handBackTabs(key: string): Promise<number> {
        try { return (await this.#releaseHumanTabs?.(key)) ?? 0; }
        catch { return 0; }
    }
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
        // The gadget speaks its own answers; the phone stays quiet.
        if (row.client_message_id.startsWith(GADGET_PREFIX)) return;
        if (["completed", "failed", "unknown", "needs_input"].includes(row.status)) {
            try { this.#notifier(this.view(row)); } catch { /* a notification never breaks the task flow */ }
        }
    }
    /** The task whose execution session this conversation is (the newest one sharing it). */
    taskForConversation(conversationId: string): { id: string; title: string } | null {
        const row = this.db.prepare("SELECT id,title FROM tasks WHERE COALESCE(execution_conversation_id,conversation_id)=? AND merged_into IS NULL ORDER BY created_at DESC LIMIT 1").get(conversationId) as { id: string; title: string } | undefined;
        return row ?? null;
    }
    /** Polled every few seconds (vault autofill, push): one indexed lookup, not the whole table. */
    hasRunning(): boolean {
        const owner = this.cfg.runtimeUserId ?? null;
        return !!this.db.prepare(`SELECT 1 FROM tasks WHERE status IN (${[...DISPATCHED].map(() => "?").join(",")}) AND (? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE owner_id=?)) LIMIT 1`).get(...DISPATCHED, owner, owner);
    }
    ownsConversation(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM tasks WHERE conversation_id=?").get(id); }
    view(row: TaskRow) {
        const plan = row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null;
        const turn = row.turn_id ? this.db.prepare("SELECT started_at FROM turns WHERE id=?").get(row.turn_id) as { started_at: number | null } | undefined : undefined;
        const parent = row.merged_into ? this.get(row.merged_into) : null;
        return {
            id: row.id, revision: row.revision, title: row.title, text: row.input_text, conversationId: this.executor(parent ?? row), mergedInto: row.merged_into, mergedTitle: parent?.title ?? null,
            // The id the console sent it under: a message shown before the server answered is matched by it.
            clientMessageId: row.client_message_id,
            // A task waiting for the person carries what its executor wrote before the question (the draft it asks about).
            status: row.status, result: TERMINAL.has(row.status) || row.status === "needs_input" ? this.shownResult(row) : null, error: row.error,
            attachments: JSON.parse(row.attachments_json) as TurnAttachment[], relatedTaskId: row.related_task_id,
            relatedTaskTitle: row.related_task_id ? this.get(row.related_task_id)?.title ?? null : null,
            description: plan?.description ?? null,
            // What its executor has said so far in this run: the card shows it while the task works.
            messages: ["running", "stopping"].includes(row.status) && row.turn_id ? this.interimMessages(row.turn_id) : [],
            waitReason: this.waitReason(row),
            clarification: row.status === "needs_input" ? plan?.clarification ?? null : null,
            options: row.status === "needs_input" ? plan?.options ?? null : null,
            form: row.status === "needs_input" ? plan?.form ?? null : null,
            dependencies: plan?.dependencies ?? [], createdAt: row.created_at, startedAt: turn?.started_at ?? null, completedAt: row.completed_at,
            schedule: row.schedule_id ? this.scheduleLabel(row.schedule_id) ?? { id: row.schedule_id, title: row.title, rule: "定时任务已删除" } : null,
            approvals: TERMINAL.has(row.status) ? 0 : this.agent.listPendingRequests(this.executor(row)).length,
        };
    }
    private claims(row: TaskRow, plan?: TaskPlan): string[] {
        const { declared, own } = this.held(row, plan);
        return [...new Set([...declared, ...own])];
    }
    /** The dispatcher's claims, apart from what the server reserves for the task alone. */
    private held(row: TaskRow, plan?: TaskPlan): Claims {
        const p = plan ?? (row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null);
        if (!p) return { declared: ["all"], own: [] };
        return { declared: p.resources ?? [], own: [`write:${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}`] };
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
        const blocker = active.find(t => (parent ? [parent, row] : [row]).some(mine => claimsConflict(this.held(mine), this.held(t))));
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
    /**
     * The task list: counts over all of the account's tasks (narrowed only by the
     * search) and one page of the filtered list. Under "all", the person's turn and
     * running work come first; everything else is newest first by when it finished,
     * else when it was asked. `asking` names the task conversations whose browser
     * waits on the person (that state lives in the tab record, not in this table).
     */
    page(opts: { userId: string; filter: TaskFilter; query?: string; cursor?: string | null; limit?: number; asking?: string[] }): TaskListPage<ReturnType<TaskService["view"]>> {
        const quoted = (statuses: readonly string[]) => statuses.map(s => `'${s}'`).join(",");
        const query = (opts.query ?? "").trim();
        const params: Record<string, string | number> = { user: opts.userId, asking: JSON.stringify(opts.asking ?? []) };
        let search = "";
        if (query) {
            params.like = `%${query.replace(/[\\%_]/g, c => `\\${c}`)}%`;
            search = ` AND (${["t.title", "t.input_text", "t.result", "json_extract(t.plan_json,'$.description')", "json_extract(t.plan_json,'$.clarification')", "s.title"].map(c => `${c} LIKE @like ESCAPE '\\'`).join(" OR ")})`;
        }
        const base = `SELECT t.*, COALESCE(t.completed_at, t.created_at) AS at,
            CASE WHEN t.status IN (${quoted(ATTENTION_STATUSES)}) OR COALESCE(t.execution_conversation_id, t.conversation_id) IN (SELECT value FROM json_each(@asking)) THEN 'attention'
                 WHEN t.status IN (${quoted(WORKING_STATUSES)}) THEN 'working'
                 WHEN t.status IN (${quoted(DONE_STATUSES)}) THEN 'done' ELSE 'stopped' END AS bucket
            FROM tasks t LEFT JOIN schedules s ON s.id = t.schedule_id
            WHERE t.merged_into IS NULL AND t.conversation_id IN (SELECT id FROM conversations WHERE owner_id = @user)${search}`;
        const counts: TaskCounts = { all: 0, attention: 0, working: 0, done: 0, stopped: 0 };
        for (const row of this.db.prepare(`SELECT bucket, COUNT(*) AS n FROM (${base}) GROUP BY bucket`).all(params) as { bucket: TaskBucket; n: number }[]) {
            counts[row.bucket] = row.n;
            counts.all += row.n;
        }
        const rank = opts.filter === "all" ? "CASE bucket WHEN 'attention' THEN 0 WHEN 'working' THEN 1 ELSE 2 END" : "0";
        let where = opts.filter === "all" ? "1" : "bucket = @filter";
        if (opts.filter !== "all") params.filter = opts.filter;
        if (opts.cursor) {
            const [rk, at, id] = decodeCursor(opts.cursor);
            Object.assign(params, { rk, at, id });
            where += " AND (rk > @rk OR (rk = @rk AND (at < @at OR (at = @at AND id < @id))))";
        }
        const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 30), 1), 200);
        params.limit = limit + 1;
        const rows = this.db.prepare(`SELECT * FROM (SELECT b.*, ${rank} AS rk FROM (${base}) b) WHERE ${where} ORDER BY rk, at DESC, id DESC LIMIT @limit`)
            .all(params) as unknown as (TaskRow & { rk: number; at: number })[];
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return { counts, tasks: page.map(r => this.view(r)), nextCursor: rows.length > limit && last ? encodeCursor([last.rk, last.at, last.id]) : null };
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
    /**
     * A message from the voice gadget (the desk device): no dispatcher, straight to
     * the account's one gadget session (the owner's at medium effort, a member's at
     * its assigned model and effort), answered briefly in plain text.
     */
    submitGadget(input: { userId: string; text: string; clientMessageId: string }) {
        const text = input.text.trim();
        if (!text) throw new Error("消息不能为空");
        if (text.length > 4000 || !input.clientMessageId || input.clientMessageId.length > 200) throw new Error("消息超出限制");
        const clientMessageId = GADGET_PREFIX + input.clientMessageId;
        const existing = this.db.prepare("SELECT * FROM tasks WHERE client_message_id = ?").get(clientMessageId) as unknown as TaskRow | undefined;
        if (existing) {
            if (this.ownerId(existing) !== input.userId || existing.input_text !== text) throw new TurnConflictError("消息 ID 已对应另一项任务");
            return existing;
        }
        const frozen = isMember(this.db, input.userId) ? this.agent.memberSettings() : this.agent.resolveSubmitSettings({ conversationId: "main", text, clientMessageId, effort: "medium" });
        const previous = this.db.prepare("SELECT * FROM tasks WHERE client_message_id LIKE 'gadget:%' AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) ORDER BY created_at DESC LIMIT 1").get(input.userId) as unknown as TaskRow | undefined;
        const id = randomId("task");
        const title = [...text].slice(0, 40).join("");
        const plan: TaskPlan = { title, description: "来自语音配件，直接执行。", related: [], dependencies: [], resources: [], appendTo: null, resume: null, clarification: null };
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const conv = this.agent.createConversation({ ownerId: input.userId, title: `配件：${title}`, model: frozen.model });
            const last = this.db.prepare("SELECT MAX(created_at) AS n FROM tasks").get() as { n: number | null };
            const now = Math.max(Date.now(), (last.n ?? 0) + 1);
            this.db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,execution_conversation_id,title,input_text,attachments_json,model,effort,created_at,status,plan_json) VALUES (?,?,?,?,?,?,'[]',?,?,?,'waiting',?)")
                .run(id, clientMessageId, conv.id, previous ? this.executor(previous) : null, title, text, frozen.model, frozen.effort, now, JSON.stringify(plan));
            this.db.exec("COMMIT");
        } catch (err) { this.db.exec("ROLLBACK"); throw err; }
        this.schedule();
        return this.get(id)!;
    }
    /** The account's gadget exchanges, newest first, older than `before` (for the owner's read-only view). */
    gadgetHistory(userId: string, before: number | null, limit: number) {
        const rows = this.db.prepare("SELECT * FROM tasks WHERE client_message_id LIKE 'gadget:%' AND (? IS NULL OR created_at < ?) AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) ORDER BY created_at DESC LIMIT ?")
            .all(before, before, userId, limit + 1) as unknown as TaskRow[];
        return {
            messages: rows.slice(0, limit).map(row => ({ ...this.gadgetReply(row.id, userId)!, text: row.input_text, createdAt: row.created_at, completedAt: row.completed_at })),
            more: rows.length > limit,
        };
    }
    /** What the gadget polls: whether its message is answered, and the answer. */
    gadgetReply(id: string, userId: string) {
        const row = this.get(id);
        if (!row || !row.client_message_id.startsWith(GADGET_PREFIX) || this.ownerId(row) !== userId) return null;
        const plan = row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null;
        const done = TERMINAL.has(row.status) || row.status === "needs_input";
        return { id: row.id, status: row.status, done, reply: done ? row.result ?? plan?.clarification ?? null : null, error: row.error };
    }
    async stop(id: string) {
        const row = this.get(id);
        if (!row)
            throw new Error("任务不存在");
        if (row.merged_into && row.status !== "merging") throw new Error("补充已经发送或送达状态待确认；如需停止执行，请停止原任务。");
        if (TERMINAL.has(row.status))
            return;
        if (!row.turn_id || row.status === "needs_input") {
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
    /**
     * The person sets aside a task whose result was never confirmed (`unknown`): it moves to
     * the stopped ones, saying so. Nothing is replayed; only a task left unconfirmed can be archived.
     */
    archive(id: string) {
        const row = this.get(id);
        if (!row || row.merged_into)
            throw new Error("任务不存在");
        if (row.status !== "unknown")
            throw new Error("只有结果待核对的任务可以归档；进行中的任务请停止");
        const note = "结果没有核对，已由你归档。";
        this.db.prepare("UPDATE tasks SET status='interrupted',error=?,completed_at=COALESCE(completed_at,?) WHERE id=? AND status='unknown'").run(row.error ? `${row.error}\n${note}` : note, Date.now(), id);
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
            const everything = this.rows().filter(t => this.ownerId(t) === this.ownerId(row));
            const all = everything.filter(t => !t.merged_into && t.created_at < row.created_at).map(t => ({
                ...t,
                input_text: this.taskContext(t),
                clarification: t.status === "needs_input" && t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).clarification ?? null : null,
                latestMessage: t.result ?? (t.turn_id && DISPATCHED.has(t.status) ? this.latestAgentMessage(t.turn_id) : null),
            }));
            const byId = new Map(all.map(t => [t.id, t]));
            const candidates = new Map<string, PlanningTask & { source: RecallSource; rank?: number; score?: number }>();
            const add = (t: PlanningTask, source: RecallSource, hit?: { rank: number; score: number }) => {
                if (!candidates.has(t.id)) candidates.set(t.id, { ...t, source, ...(hit ? { rank: hit.rank, score: Math.round(hit.score * 100) / 100 } : {}) });
            };
            // Separate live work from finished work before inverted-document
            // search, so a burst in one group cannot evict the other.
            const activeTasks = all.filter(t => ["planning", "needs_input", "waiting", "blocked"].includes(t.status) || DISPATCHED.has(t.status));
            const finishedTasks = all.filter(t => !activeTasks.includes(t));
            for (const t of activeTasks.slice(-ACTIVE_CANDIDATES)) add(t, "active");
            // Newest first; a daily run must not push the person's own recent work out of view.
            // It stays reachable through recall and an explicit reference (a reply to a push).
            let recent = 0, scheduledRecent = 0;
            for (const t of [...finishedTasks].reverse()) {
                if (recent >= RECENT_CANDIDATES) break;
                if (byId.get(t.id)?.schedule_id && ++scheduledRecent > RECENT_SCHEDULED_CANDIDATES) continue;
                add(t, "recent"); recent += 1;
            }
            const windowIds = new Set(candidates.keys());
            const explicit = row.related_task_id ? this.get(row.related_task_id) : null;
            const inputContext = this.taskContext(row);
            this.recall.forget(everything.filter(t => t.merged_into).map(t => t.id));
            this.recall.sync(all.map(t => ({ id: t.id, ownerId: trace.ownerId, title: t.title, body: t.input_text, result: t.result, latestMessage: t.latestMessage })));
            const recalled = (query: string, source: RecallSource) => {
                const take = Math.min(RECALL_CAP, MAX_CANDIDATES - candidates.size);
                if (take <= 0) return;
                trace.searches.push(query);
                for (const hit of this.recall.search(trace.ownerId, query, { exclude: new Set([row.id, ...candidates.keys()]), cap: take })) {
                    const t = byId.get(hit.id);
                    if (t) add(t, source, hit);
                }
            };
            if (explicit) {
                candidates.clear();
                if (!candidates.has(explicit.id)) add({...explicit,input_text:this.taskContext(explicit),clarification:explicit.status === "needs_input" && explicit.plan_json ? (JSON.parse(explicit.plan_json) as TaskPlan).clarification ?? null : null}, "explicit");
                // A task pointed at by hand is the answer search should have found: measure where it ranks.
                const rank = this.recall.rank(trace.ownerId, inputContext).find(h => h.id === explicit.id)?.rank ?? null;
                trace.gold = { id: explicit.id, rank, inWindow: windowIds.has(explicit.id) };
            } else {
                recalled(inputContext, "recall");
                // Terse follow-ups can omit the entity; query the inverted index
                // once more with the adjacent task titles, still before Jev.
                if (inputContext.trim().length < 30 && candidates.size < MAX_CANDIDATES)
                    recalled(`${inputContext}\n${all.filter(t => !t.schedule_id).slice(-3).map(t => t.title).join("\n")}`, "context");
            }
            const files = [row,...this.rows().filter(t=>t.merged_into===row.id && t.status==='merged')]
                .flatMap(t=>JSON.parse(t.attachments_json) as TurnAttachment[]);
            const planningInput = [inputContext, ...(files.length ? [`已有附件（执行者可以读取其中资料）：${JSON.stringify(files)}`] : [])].filter(Boolean).join("\n\n");
            const soul = readSoul(this.cfg).content;
            // A member's dispatcher runs on its assigned model; the owner's on the default dispatch model.
            const ask = (prompt: string, onTiming: DispatchTimingSink) => isMember(this.db, this.ownerId(row))
                ? this.codex.planTask?.(prompt, soul, this.agent.memberSettings().model, onTiming)
                : this.codex.planTask?.(prompt, soul, undefined, onTiming);
            const askWithTiming = async (prompt: string, round: number) => {
                const phaseStarted = Date.now();
                const contextAt = steps.find(s => s.kind === "context")?.at;
                const jevAt = steps.find(s => s.kind === "jev")?.at;
                const step: Extract<(typeof steps)[number], { kind: "timing" }> = {
                    kind: "timing", at: phaseStarted, round,
                    timing: {
                        queueMs: Math.max(0, Number(started - row.created_at)),
                        ...(contextAt ? { contextMs: contextAt - started } : {}),
                        ...(contextAt && jevAt ? { jevMs: jevAt - contextAt } : {}),
                    },
                };
                steps.push(step);
                try {
                    // A parked sandbox must wake before the classifier starts.
                    await this.agent.ensureSandbox();
                    step.timing.sandboxMs = Date.now() - phaseStarted;
                    return await ask(prompt, timing => Object.assign(step.timing, timing));
                } finally {
                    step.timing.totalMs = Date.now() - phaseStarted;
                }
            };
            // The conversation in order, and Jev's second opinion on which task this message continues.
            const timelineText = formatTimeline(timeline(everything, row), row.created_at);
            const scheduling = { now: Date.now(), timezone: this.cfg.browser.timezone, schedules: this.planningSchedules(trace.ownerId) };
            steps.push({ kind: "context", at: Date.now(), timeline: timelineText, candidates: candidates.size });
            let relevance: JevRelevance | null = null;
            // A referenced message's route is fixed: no second opinion is needed.
            if (!explicit && candidates.size && this.jev?.enabled) {
                const pool = [...candidates.values()].map(t => ({ ...byId.get(t.id)!, ...t, recalled: RECALLED.has(t.source) }));
                const q = routingQuestion(inputContext, pool, timeline(everything, row), row.created_at);
                const criteria = q.questions.route!.criteria;
                try {
                    const r = await this.jev.decide(q.state, q.questions, { timeoutMs: this.cfg.jev.dispatchTimeoutMs });
                    relevance = dispatchAdvice(r.answers, pool);
                    const advice = relevance.suggestion!;
                    trace.jev = { choice: relevance.choice, probability: advice.probability, confident: relevance.confident, latencyMs: r.latencyMs, scores: relevance.scores!, suggestion: advice, answers: r.answers };
                    const probabilities = Object.fromEntries(Object.entries(r.answers.route!.probabilities).map(([key, p]) => [key === "NEW" ? "NEW" : key.split(":", 2)[1]!, p]));
                    steps.push({ kind: "jev", at: Date.now(), criteria, result: { choice: relevance.choice, probabilities, confident: relevance.confident, latencyMs: r.latencyMs, scores: relevance.scores!, suggestion: advice, answers: r.answers } });
                } catch (err) {
                    trace.jev = { error: err instanceof Error ? err.message : String(err) };
                    steps.push({ kind: "jev", at: Date.now(), criteria, error: trace.jev.error });
                }
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
            }
            const previous: PlanningTask[] = [...candidates.values()];
            // Jev's displayed 0% means the task cannot help the dispatcher classify this
            // message. Keep the full candidate set in the dispatch log, but do
            // not send that task's input/result/latest message (or its timeline
            // excerpt) to the dispatcher. An explicit user reference always wins.
            const zeroIds = new Set(previous.filter(t => t.id !== explicit?.id && relevance?.scores?.[t.id] === 0).map(t => t.id));
            const lunaCandidates = previous.filter(t => !zeroIds.has(t.id));
            const lunaTimeline = zeroIds.size
                ? formatTimeline(timeline(everything, row).filter(entry => entry.current || !zeroIds.has(entry.taskId)), row.created_at)
                : timelineText;
            trace.rounds = 1;
            const prompt = planningPrompt(planningInput, lunaCandidates, row.related_task_id, { timeline: lunaTimeline, jev: relevance, now: describeNow(scheduling.now, scheduling.timezone), timezone: scheduling.timezone, schedules: scheduling.schedules });
            trace.promptChars += prompt.length;
            let raw = await askWithTiming(prompt, 1);
            if (this.#closed || this.get(row.id)?.status !== "planning") return;
            if (this.taskContext(this.get(row.id)!) !== inputContext) return;
            steps.push({ kind: "ask", at: Date.now(), round: 1, prompt: prompt.slice(0, STEP_PROMPT_CHARS), answer: raw?.slice(0, STEP_ANSWER_CHARS) ?? null });
            const report: PlanReport = { repairs: [] };
            let plan = parsePlan(raw ?? null, lunaCandidates, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir, report, scheduling);
            // One more chance with the reason, instead of failing the message outright.
            // (A dispatcher that gave no answer in time throws instead: re-asking would only wait again.)
            if (!plan) {
                trace.rounds += 1;
                const prompt = planningPrompt(planningInput, lunaCandidates, row.related_task_id, { correction: report.error ?? "格式不符合要求", timeline: lunaTimeline, jev: relevance, now: describeNow(scheduling.now, scheduling.timezone), timezone: scheduling.timezone, schedules: scheduling.schedules });
                trace.promptChars += prompt.length;
                raw = await askWithTiming(prompt, trace.rounds);
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
                const first = report.error;
                steps.push({ kind: "ask", at: Date.now(), round: trace.rounds, prompt: prompt.slice(0, STEP_PROMPT_CHARS), answer: raw?.slice(0, STEP_ANSWER_CHARS) ?? null, correction: first ?? "格式不符合要求" });
                report.error = undefined;
                plan = parsePlan(raw ?? null, lunaCandidates, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir, report, scheduling);
                report.repairs.unshift(`第一次回答无法使用：${first ?? "格式不符合要求"}，已重问一次`);
            }
            // Old model output may still contain a preflight question. The
            // executor has the tools and history needed to decide whether to ask.
            if (plan) {
                plan.clarification = null; delete plan.options;
                // An executor's finished turn cannot accept a steer. The answer
                // must resume that same thread as a new turn.
                const target = plan.appendTo ? this.get(plan.appendTo) : null;
                if (target?.status === "needs_input" && target.turn_id) {
                    plan.appendTo = null;
                    plan.resume = target.id;
                    plan.decision = { kind: "resume", taskId: target.id };
                    plan.related = [...new Set([...plan.related, target.id])];
                    plan.dependencies = plan.dependencies.filter(id => id !== target.id);
                }
                if (relevance) plan.jev = relevance;
            }
            trace.candidates = [...candidates.values()].map(c => ({ id: c.id, source: c.source, ...(c.rank ? { rank: c.rank, score: c.score } : {}) }));
            trace.repairs = report.repairs;
            trace.failReason = report.error ?? null;
            measured = true;
            trace.latencyMs = Date.now() - started;
            if (plan) { trace.failed = false; trace.chosen = { related: plan.related, appendTo: plan.appendTo ?? null, resume: plan.resume ?? null }; steps.push({ kind: "plan", at: Date.now(), plan, repairs: report.repairs }); }
            if (!plan)
                throw new Error(`任务分配暂时失败，尚未执行。请重试分配。（派单结果无法使用：${report.error ?? "格式不符合要求"}）`);
            // The executor sees Jev's reading and the dispatcher's final normalized plan.
            if (explicit && !plan.resume) applyTaskReference(plan, this.referenceTarget(row)!);
            // Setting up or changing a schedule needs no executor: answer right here.
            if (plan.scheduleAction || (plan.schedule && !plan.schedule.runNow)) {
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
                let answer: string;
                if (plan.scheduleAction?.action === "update") {
                    const changed = this.updateScheduleFor(trace.ownerId, { id: plan.scheduleAction.id, title: plan.title, instruction: plan.schedule!.instruction, schedule: plan.schedule!.spec });
                    answer = changed.ok ? changed.message : `没有修改定时任务：${changed.error}`;
                } else {
                    // Cancelling one schedule and setting up another in the same message does both.
                    const action = plan.scheduleAction?.action;
                    answer = [action ? this.applyScheduleAction(trace.ownerId, plan.scheduleAction!.id, action) : null, plan.schedule ? this.createSchedule(row, plan) : null].filter(Boolean).join("\n\n");
                }
                this.db.prepare("UPDATE tasks SET title=?,plan_json=?,status='completed',result=?,completed_at=? WHERE id=?").run(plan.title, JSON.stringify(plan), answer, Date.now(), row.id);
                this.agent.renameConversation(row.conversation_id, plan.title);
                return;
            }
            const root = this.cfg.sandbox.containerWorkspaceDir;
            // Historical resource hints only coordinate queueing/prewarming;
            // they are not an authorization boundary for the executor.
            if (this.resourceSandbox && plan.resources.length)
                plan.resources = await resolveResources(plan.resources, root, this.resourceSandbox);
            if (this.#closed || this.get(row.id)?.status !== "planning") return;
            if (this.taskContext(this.get(row.id)!) !== inputContext) return;
            if (explicit && !plan.resume) applyTaskReference(plan, this.referenceTarget(row)!);
            if (plan.appendTo) {
                this.db.prepare("UPDATE tasks SET title=?,plan_json=?,merged_into=?,status='merging',error=NULL WHERE id=?").run(plan.title,JSON.stringify(plan),plan.appendTo,row.id);
                return;
            }
            const finalContinued = plan.resume ? this.get(plan.resume) : null;
            if (finalContinued) this.db.prepare("UPDATE tasks SET related_task_id=?,execution_conversation_id=? WHERE id=?").run(finalContinued.id, this.executor(finalContinued), row.id);
            else if (row.execution_conversation_id) this.db.prepare("UPDATE tasks SET execution_conversation_id=NULL WHERE id=?").run(row.id);
            // "Do it now, and every day from now on": the schedule, then this run.
            if (plan.schedule) plan.description = this.createSchedule(row, plan, true);
            this.db.prepare("UPDATE tasks SET title=?,plan_json=?,status=?,error=NULL WHERE id=?").run(plan.title, JSON.stringify(plan), "waiting", row.id);
            if (finalContinued?.status === "needs_input" && finalContinued.turn_id) {
                const answeredPlan = JSON.parse(finalContinued.plan_json!) as TaskPlan;
                answeredPlan.answeredBy = row.id;
                const acknowledgement = "已收到补充，结果请看后续任务。";
                this.db.prepare("UPDATE tasks SET status='completed',result=?,plan_json=? WHERE id=? AND status='needs_input'")
                    .run([finalContinued.result, acknowledgement].filter(Boolean).join("\n\n"), JSON.stringify(answeredPlan), finalContinued.id);
            }
            this.agent.renameConversation(row.conversation_id, plan.title);
            this.notifyChange(row.id, "planning");
        }
        catch (err) {
            if (!this.#closed && this.get(row.id)?.status === "planning") {
                const reason = err instanceof Error ? err.message : "任务分配失败";
                this.db.prepare("UPDATE tasks SET status='planning_failed',error=? WHERE id=?").run(reason, row.id);
                measured = true; trace.failed = true; trace.failReason ??= reason;
                steps.push({ kind: "failed", at: Date.now(), reason });
            }
        }
        finally {
            this.#planning = false;
            // Only a dispatch that reached a decision (or failed to) is measured; a superseded one is not.
            if (measured) {
                trace.latencyMs = Date.now() - started;
                const finalPlan = steps.findLast(s => s.kind === "plan");
                if (!trace.failed && finalPlan?.kind === "plan") {
                    const plan = finalPlan.plan as TaskPlan;
                    trace.chosen = { related: plan.related, appendTo: plan.appendTo ?? null, resume: plan.resume ?? null };
                }
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
    /** The text messages an executor wrote during a turn, before its final answer (the last few). */
    private interimMessages(turnId: string): string[] {
        const events = this.db.prepare("SELECT payload FROM events WHERE turn_id=? AND type='item/completed' AND payload LIKE '%\"agentMessage\"%' ORDER BY id DESC LIMIT 3").all(turnId) as Array<{payload:string}>;
        const texts: string[] = [];
        for (const event of events) {
            try {
                const item = JSON.parse(event.payload).item as {type?:string;text?:string;phase?:string};
                if (item.type === "agentMessage" && item.phase !== "final_answer" && typeof item.text === "string" && item.text.trim()) texts.unshift(item.text.trim().slice(0, 1000));
            } catch { /* a malformed historical event is skipped */ }
        }
        return texts;
    }
    private latestAgentMessage(turnId: string): string | null {
        const events = this.db.prepare("SELECT payload FROM events WHERE turn_id=? AND type='item/completed' ORDER BY id DESC LIMIT 20").all(turnId) as Array<{payload:string}>;
        for (const event of events) {
            try {
                const item = JSON.parse(event.payload).item as {type?:string;text?:string};
                if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) return item.text.trim().slice(-4000);
            } catch { /* malformed historical event is not a recall document */ }
        }
        return null;
    }
    private fallbackSupplement(row: TaskRow) {
        const plan=JSON.parse(row.plan_json!) as TaskPlan;
        plan.appendTo=null;
        plan.decision={kind:"new",taskId:null};
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
                if(otherActive.some(t=>claimsConflict(this.held(parent, parentPlan),this.held(t)) || claimsConflict(this.held(row, plan),this.held(t)))) continue;
                // Reserve the expanded resource set before sending the update.
                parentPlan.resources=resources;
                parentPlan.related=[...new Set([...parentPlan.related,...plan.related.filter(id=>id!==parent.id)])];
                this.db.prepare('UPDATE tasks SET plan_json=? WHERE id=?').run(JSON.stringify(parentPlan),parent.id);
                if(!parent.turn_id) {
                    this.db.prepare("UPDATE tasks SET status='merged',completed_at=? WHERE id=?").run(Date.now(),row.id);
                    continue;
                }
                this.db.prepare("UPDATE tasks SET status='steering' WHERE id=?").run(row.id);
                try {
                    const handed=await this.handBackTabs(this.executor(parent));
                    if(this.#closed) return;
                    const result=await this.agent.appendTurnInput(this.executor(parent),parent.turn_id,
                        `${handed ? `用户发这条补充时，你请他接管的浏览器标签页（${handed} 个）还在他手里，现已自动交还给你，可以直接继续操作；确实还需要他亲手操作时再请求接管。\n\n` : ""}这是用户在 ${new Date(row.created_at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })} 对当前任务的补充（同一件事，不是新任务）。先弄清他的意思再接着做：纠正或改了条件（日期、地点、对象、数量等），就按新要求调整，基于旧条件的做法和结论作废；追加了要求或信息，就并进来一起完成；要你停下或改做别的，就照办。已经做好且仍然有效的部分不用重做。最终回复以最新要求为准、给出完整结果：之前发过且仍然有效的内容在最终回复里带上，已被推翻的不要再出现。按用户要求自行使用所需的文件、浏览器和工具，不受派单资源提示限制。\n\n主会话最近的对话（按时间先后，▶ 是这条补充）：\n${formatTimeline(timeline(this.rows().filter(t => this.ownerId(t) === this.ownerId(row)), row, 6), Date.now(), plan.jev)}${plan.jev ? `\n\nJev 的逐任务相关性与路由建议（仅作背景）：\n${formatRelevance(plan.jev, id => this.get(id)) ?? "无"}` : ''}\n\n派单器的判断（仅作背景）：${JSON.stringify({title:plan.title,description:plan.description,decision:plan.decision})}${dependencies.length ? `\n\n补充所需的已完成任务资料：${JSON.stringify(dependencies.map(t => ({id:t!.id,result:t!.result?.slice(0,16000)})))}` : ''}\n\n本次用户补充：\n\n${row.input_text}`,
                        JSON.parse(row.attachments_json),resources.includes("browser"));
                    if(this.#closed) return;
                    if(result==='browser_unavailable') this.db.prepare("UPDATE tasks SET status='merge_failed',error=? WHERE id=?").run('此补充需要浏览器，但浏览器暂未恢复；原任务仍可继续，请恢复浏览器后重新补充。',row.id);
                    else if(result==='not_active') { this.fallbackSupplement(row); this.schedule(); }
                    else {
                        // The task keeps its own title: a supplement adds to it, it does not take it over.
                        this.db.prepare('UPDATE tasks SET status=?,completed_at=? WHERE id=?').run(result==='accepted'?'merged':'merging',result==='accepted'?Date.now():null,row.id);
                    }
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
    /** The fixed rules every delegated executor turn runs under; `taskId` names its own directory. */
    private executorRules(taskId: string): string[] {
        const dir = `${this.cfg.sandbox.containerWorkspaceDir}/tasks/${taskId}`;
        const tz = this.cfg.browser.timezone;
        return [
            "【工作方式】",
            "按请求实际需要控制工作量：普通聊天、问候、身份介绍、概念解释和能直接回答的问题，直接在消息里回答，不建目录、不做文件、不检查运行环境、不截图验收。只有回答需要外部事实、附件或已有资料时才用工具；需要用户过往信息时有针对性地查相关记录。身份与风格以已注入的 SOUL.md 为准，不为自我介绍去检索记忆或寻找 SOUL.md。用户要求实际操作或交付文件时，必须真的执行，并做与风险相称的验证，不能用口头回答代替。",
            "按任务需要使用文件、浏览器和其他工具，派单器的资源提示不限制你；aio_tabs 会按需恢复浏览器并管理标签页归属。沙箱命令无需审批，不等于用户授权了这些操作：只做用户要求和授权的事。",
            `时间按用户所在时区（${tz}）理解和表述：沙箱系统时钟是 UTC，不要把它当成用户的时间，也不要说“我的时区是 UTC”。“今天”“明天”“几点”都按用户时区换算，本轮开头会给出用户的当前时间。`,
            "【文件与目录】",
            `只在确实要写文件时创建任务目录 ${dir}/，新文件都放这里，不散落在工作区根目录。工作区与其他子 agent 共享：不覆盖无关文件，只在本次授权的路径内更新已有产物；发现并发修改先核对即时状态。`,
            `运行工具产生的临时文件、渲染输出、缓存和工具配置放在 ${dir}/.tmp/，并把 TMPDIR 指向它；LibreOffice 使用该目录下独立的 UserInstallation。不复用或清理 /tmp/verify、/tmp/lo-final 等公共路径。结束前等本任务的写入子进程完成，不留后台写入。`,
            "默认直接在消息里回答，不建文件。只有用户要文件或可下载的交付物，或内容确实需要独立的文档、页面承载时才做文件；内容是说明、清单或计划本身不是建文档的理由。格式按表达需要选：普通文字、清单和简单表格用结构清晰的 Markdown（.md）；攻略、计划、说明需要复杂排版、图表、多栏卡片或交互时，做自包含、适配手机的 HTML（.html），交付前看实际展示效果，检查通过就交付，只有发现具体缺陷才继续修改复验。用户指定 Word、Excel、PPT 等格式时照办。交付文件时，消息里给简要要点和文件链接，链接用有意义的中文标题，例如 [完整三天行程](绝对文件路径)，不只写“下载文件”，也不暴露冗长的文件名。",
            "【最终回复】",
            "你以用户的个人助理身份交付：最终回复先给最有用的结论、建议、安排或交付物，不要只说准备去做。保留必要的事实来源、未完成事项和会影响用户决策的限制（如尚未预订、日期待确认）；不要删掉有用的依据、链接或不确定性来让结果显得更确定。",
            "用户不关心实现过程：最终回复不汇报用了哪些 skill、工具、命令、API、子 agent 或文件创建、检查步骤，除非用户专门问这些技术细节；需要记下的执行与验证细节放在 commentary 过程里，也不写进交付文档。过程尽量简短，它会在主会话里折叠。",
            "【消息排版：手机上的图文卡片】",
            "主会话消息在手机上读，要像图文卡片，不写长篇纯文字：先一两句结论，再用卡片、图片和短段落展开。表格只用于少量数据并排对比（列多时要横向滑动）。按内容选用下面的卡片，放在正文中与它相关的文字旁边，不要全部堆在末尾：\n- 具体商品，以及酒店、餐厅这类可比较、可购买或预订的条目 → ```products 商品卡片\n- 要去的具体地点 → ```map 地图卡片\n- 有分支、汇合、循环的流程，或几方之间的关系 → ```mermaid 流程图（直线走完的几步不用画）\n- 其他示意图、简单图表 → ```svg\n- 图片、视频、音频 → ![说明](路径)；文件 → [有意义的标题](路径)\n- 任务已完成、给用户可选的后续：点选一项 → ```choices；要填几项信息 → ```form\n- 缺了用户的回答就无法继续 → ```ask_user\n各种卡片的写法见下。代码块里的 JSON 或语法写错时，消息里会原样显示成代码。",
            `图片和文件：用 Markdown 图片语法 ![说明](绝对路径) 嵌入，工作区里的 png/jpg/webp/gif/svg 图片、mp4/mov/webm 视频和 mp3/m4a/wav/ogg/flac 音频会在所在位置显示（音视频是播放器），点开可放大。网上的图片可以写 ![说明](https://…)（系统经沙箱取回显示），更稳妥的是先存进 ${dir}/ 再引用；生成的图片也存在这里：~/.codex 等工作区以外的文件在消息里显示不出来。普通文件写成 [有意义的标题](绝对路径)，显示为可预览、可下载的文件卡片；分享页链接直接给出，会显示为可一键复制的分享卡片。`,
            "流程图（```mermaid，Mermaid 语法，消息里画成图片，可放大、可下载）。先判断值不值得画：只有分支、汇合、循环或几方关系用图比文字清楚时才画；一条直线走完的 3–5 步写成编号步骤或一行“A → B → C”，时间线写成带日期的列表，都不画图。要画时按手机屏幕来：\n- 方向：只有 3–4 个节点的短链用 flowchart LR（横向一行排开）；有分支或步骤更多时用 flowchart TD（自上而下），每一层并排不超过 3 个节点。\n- 文字：节点里只写动作或结果，10 个字以内，细节放在图下面的正文里；中文或带标点的文字用双引号包起来。\n- 形状：起点和终点用胶囊 A([\"出发\"])，步骤用 B[\"填写表格\"]，判断用六边形 C{{\"护照够半年？\"}}，不要用菱形 {}（菱形会随文字撑得很大）；判断的出口在连线上写短词：C -->|是| D。\n- 几方协作时用 subgraph 按角色分组（只分一层），组名写角色。\n- 一张图 12 个节点以内，更多就拆成几张，每张前面用一句话说明看点。\n- 只写图本身，不加 %%{init}%%、classDef、style 或 click：配色、字号和圆角由系统统一处理。\n其他示意图、简单图表写成 ```svg 代码块（完整的 <svg> 文档），显示为图片。",
            "商品卡片：每件一张，要比较的几件写在同一个代码块里（最多 8 件）：\n```products\n[{\"name\": \"商品名\", \"image\": \"" + dir + "/商品.jpg\", \"price\": \"$899\", \"was\": \"$1,199\", \"store\": \"Amazon\", \"url\": \"https://商品页\", \"rating\": \"4.4（1,203 条）\", \"badge\": \"最推荐\", \"points\": [\"决定选择的理由一\", \"理由二\"], \"note\": \"要注意的一点\"}]\n```\n每张卡片都要有这件商品的真实图片：用 aio_tabs 的 browser_save_image 存进任务目录，把返回的路径填进 image。在商品页上只给 path（自动存这页的商品主图）；在搜索结果等列表页上加 selector 指向那件商品的图片元素。不要手抄图片网址填进 image：网址里的版本、签名参数一删一改就打不开（实测缺参数直接 404）。只有页面上确实没有这件商品的图时才省略 image，绝不用无关或示意的图片。price、was、rating 只写查到的，没核实的在 note 里说明；url 填商品页链接；points 写 2–3 条；badge 只给真正推荐的那一件（如“最推荐”“最便宜”）。卡片后面用一两句话说怎么选。",
            "地图卡片：回答涉及要去的具体地点（餐厅、景点、酒店、会面地点、目的地等）时，在正文相关位置插入，一个地点一个代码块，用户点一下就能在手机地图里查看：\n```map\n{\"name\": \"地点名称\", \"address\": \"完整地址\", \"lat\": 纬度, \"lng\": 经度}\n```\n坐标只填从可靠来源（地图搜索结果、官网）查到的数值，不要估算；拿不到时只写 name 和 address，系统会按地址定位。坐标默认 WGS-84，取自高德或腾讯地图的坐标加 \"coord\": \"gcj02\"。只是顺带提到的地名不用加卡片。",
            "【向用户提问】",
            "先利用已知上下文、记忆和必要工具自己查；能合理默认就直接做，并用半句话说明假设。按情况三选一：\n1. 任务已经完成，只是给可选的后续：在回答最后提出问题，紧跟选项代码块\n```choices\n[\"选项一\", \"选项二\"]\n```\n选项写 2–5 个，每个都是可以直接作为回答的完整说法（不超过 30 字），不要“其他”（用户也可以自己输入）。\n2. 任务已经完成，可选的后续要用户一次填几项信息（日期、人数、地点、偏好等）：用表单代码块\n```form\n{\"title\": \"表单标题\", \"fields\": [{\"name\": \"date\", \"label\": \"日期\", \"type\": \"date\", \"required\": true}, {\"name\": \"people\", \"label\": \"人数\", \"type\": \"number\", \"min\": 1, \"default\": 2}, {\"name\": \"area\", \"label\": \"区域\", \"type\": \"select\", \"options\": [\"选项一\", \"选项二\"]}], \"submit\": \"提交\"}\n```\ntype 可选 text、textarea、number、date、time、select、radio（单选）、checkbox（多选）；select、radio、checkbox 带 2–10 个 options；最多 8 个字段，label 不超过 30 字。只问一件事时不要用表单。\n3. 缺少用户独有、无法合理默认的信息，确实不能继续：先简述已完成的部分，然后在回复最后单独写一个 ask_user 代码块\n```ask_user\n{\"question\": \"要用户回答的一个具体问题\", \"options\": [\"选项一\", \"选项二\"]}\n```\n没有合适选项时省略 options；需要用户一次补充几项信息时，改用 fields（格式同上面表单的 fields，可带 submit），question 写一句说明，主会话会显示成表单。系统会把任务标为等待用户，用户的回复会续接本执行会话。不要在得到回答前执行依赖这个答案的操作；不要只用普通问句结束，也不要声称任务已完成。\n用户点选或提交的内容都会作为回复续接本任务。已经能完成任务时，直接给结果，不写 ask_user。",
        ];
    }
    private executorRulesVersion(): string {
        return createHash("sha256").update(this.executorRules("<任务ID>").join("\n\n")).digest("hex").slice(0, 8);
    }
    /** The voice gadget's executor prompt: spoken, brief and plain; the account's other tasks are looked up on demand. */
    private gadgetPrompt(row: TaskRow): string {
        return [
            `你是 AIO Agent 的语音配件会话。任务 ID：${row.id}。用户正对着桌上的语音配件（小屏加喇叭）说话：这句话由语音识别转写，可能有同音错字，按最合理的意思理解；你的回答会显示在小屏上并朗读出来。身份和语气遵循系统层注入的 SOUL.md。不递归委派。`,
            "这是一个持续的配件会话，同一会话里保留着之前的配件对话；用户说“刚才”“那个”时先从这里找指代。用户在主会话里的其他任务不在这里：问到以前的某件事、某个任务的进展或结果、最近做了什么时，用 aio_history 的 history_search 找（几个关键词），再用 history_get 读完整内容，不要凭印象回答；用不到就不查。",
            "回答用纯文本口语：不用 Markdown、列表符号、表格、代码块、链接和表情，也不用 products、map、choices、form、ask_user 等卡片或代码块。默认一到三句话、一百字以内，先说结论；用户要求详细时再展开，也不超过三百字。数字、时间和单位写成顺口好读的形式。",
            `不要追问：缺少信息就按最合理的默认处理，并用半句话说明假设。需要查资料、用浏览器或操作文件时照常用工具完成，过程不写进回答；需要写文件时放在 ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/。`,
            `现在是 ${describeNow(row.created_at, this.cfg.browser.timezone)}。用户这次说：${this.taskContext(row)}`,
        ].join("\n\n");
    }
    private dispatch() {
        const rows = this.rows();
        const active = rows.filter(t => DISPATCHED.has(t.status));
        for (const row of rows.filter(t => t.status === "waiting")) {
            const reference = this.referenceTarget(row);
            if (reference?.status === "stopping") continue;
            // Work still under way on the referenced session takes the message as a steer.
            if (reference && ["planning", "waiting", "queued", "running"].includes(reference.status)) {
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
            if (active.some(t => claimsConflict(this.held(row, plan), this.held(t))))
                continue;
            if (active.some(t => this.executor(t) === this.executor(row))) continue;
            const related = plan.related.map(id => this.get(id)).filter((t): t is TaskRow => !!t);
            const clock = (ts: number) => new Date(ts).toLocaleString("sv-SE", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
            // A pointer and the gist, not the whole record: the executor reads the rest with history_get when it needs it.
            const gist = (text: string | null | undefined, n: number, id: string) => text && text.length > n ? `${text.slice(0, n)}…（已截断，完整内容用 aio_history 的 history_get 读取 ${id}）` : text ?? null;
            const context = related.map(t => ({ id: t.id, createdAt: clock(t.created_at), message: gist(t.input_text, 1500, t.id), status: t.status, lastQuestionToUser: lastQuestion(t), result: gist(t.result, 2500, t.id) }));
            const injected = Object.fromEntries(context.map(c => [c.id, createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 16)]));
            // A resumed thread already holds what earlier turns in it were given or
            // answered: name those tasks instead of repeating them, unless they changed.
            const inThread = row.execution_conversation_id ? this.agent.turnsInThread(this.executor(row), row.model) : new Set<string>();
            const earlier = inThread.size ? this.rows().filter(t => t.id !== row.id && t.turn_id && inThread.has(t.turn_id) && this.executor(t) === this.executor(row)) : [];
            const seen = (id: string) => earlier.some(t => (t.id === id && ["completed", "needs_input"].includes(t.status))
                || (t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).injectedContext?.[id] === injected[id] : false));
            const repeated = context.filter(c => seen(c.id)).map(c => c.id);
            const fresh = context.filter(c => !repeated.includes(c.id));
            // What this message answers: the session it continues and the question that session left open.
            const continued = row.related_task_id && row.execution_conversation_id ? this.get(row.related_task_id) : null;
            const ask = continued ? lastQuestion(continued) ?? (continued.plan_json ? (JSON.parse(continued.plan_json) as TaskPlan).clarification : null) : null;
            const continuation = continued ? `本次消息接续任务 ${continued.id}（${clock(continued.created_at)} 创建）${ask ? `；该任务最后问用户：「${ask}」，用户这次的回复针对的就是这个问题` : "的工作"}。` : null;
            const relevance = plan.jev ? formatRelevance(plan.jev, id => this.get(id)) : null;
            const gadget = row.client_message_id.startsWith(GADGET_PREFIX);
            // The fixed executor rules go into a thread once: a resumed turn whose thread
            // already holds this version of them only names the version.
            const rules = this.executorRules(row.id);
            const rulesVersion = this.executorRulesVersion();
            const rulesKnown = earlier.some(t => t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).rulesVersion === rulesVersion : false);
            // The person's standing agreements, likewise given to a thread once per version.
            const agreements = gadget ? null : standingAgreements(this.db, this.ownerId(row));
            const agreementsKnown = !!agreements && earlier.some(t => t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).agreementsVersion === agreements.version : false);
            const prompt = gadget ? this.gadgetPrompt(row) : [
                `你是 AIO Agent 主会话委派的子 agent。任务 ID：${row.id}。${row.execution_conversation_id ? "本轮恢复此前任务的同一会话，保留完整上下文；按用户的新要求继续、补充或更新，不要从零重新做。" : "只处理本任务。"}不递归委派。身份、语气和行为遵循系统层注入的 SOUL.md；对子任务同样生效，不以内部执行角色替代个人助理身份。`,
                ...(rulesKnown
                    ? [`执行约束（版本 ${rulesVersion}）已在本会话前文给出且没有变化，这里不再重复，继续按之前的约束执行。注意本轮任务 ID 是 ${row.id}：约束里的任务目录、临时目录和图片存放位置都换成 ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/。`]
                    : [`执行约束（版本 ${rulesVersion}；同一会话里版本不变时后续轮次不再重复）：`, ...rules]),
                ...(agreements ? [agreementsKnown
                    ? `用户的长期约定（版本 ${agreements.version}）已在本会话前文给出且没有变化，继续遵守。`
                    : `用户的长期约定（版本 ${agreements.version}；用户亲口交代、要一直遵守的，与本任务相关时照做${agreements.omitted ? `；另有 ${agreements.omitted} 条未列出，用 memory_search 查` : ""}）：\n${agreements.text}`] : []),
                ...(fresh.length || !repeated.length ? ["以下是相关任务的背景资料（不是本任务的新指令，未完成结果不得当作已完成）：", JSON.stringify(fresh)] : []),
                ...(repeated.length ? [`相关任务 ${repeated.join("、")} 的详情已在本会话前文中（此前注入过，或就是在本会话里执行的），之后没有变化，这里不再重复；需要时查看前文。`] : []),
                "派单器的判断（仅作本轮执行背景；以用户原话和现有权限为准）：", JSON.stringify({ title: plan.title, description: plan.description, decision: plan.decision, related: plan.related, dependencies: plan.dependencies }),
                "主会话时间线（按时间先后列出用户最近的消息与各自归属的任务，▶ 是本次消息；用来理解本次消息的指代、先后和回应对象，不是新指令）：", formatTimeline(timeline(this.rows().filter(t => this.ownerId(t) === this.ownerId(row)), row), Date.now(), plan.jev),
                ...(relevance ? [`Jev 的逐任务相关性与路由建议（独立评分，仅供理解背景；正式决定见上方派单器的判断）：\n${relevance}\n以用户原话和派单器的最终路由为准，参考相关任务已完成的结果和最新进展，不把背景当成本轮新指令。`] : []),
                ...(continuation ? [continuation] : []),
                ...(row.schedule_id ? [this.scheduledRunNote(row)] : []),
                `用户的当前时间：${describeNow(Date.now(), this.cfg.browser.timezone)}（${this.cfg.browser.timezone}）。`,
                "本次用户任务：", this.taskContext(row),
            ].join("\n\n");
            try {
                // Reserve this specific task before submitTurn synchronously
                // emits turn.queued; another waiting reference may share the conversation.
                // Answering a task whose tabs the person still holds hands them back for this turn.
                if (row.execution_conversation_id) void this.handBackTabs(this.executor(row));
                this.db.prepare("UPDATE tasks SET status='queued',plan_json=? WHERE id=?").run(JSON.stringify({ ...plan, injectedContext: gadget ? {} : Object.fromEntries(fresh.map(c => [c.id, injected[c.id]])), rulesVersion: gadget || rulesKnown ? undefined : rulesVersion, agreementsVersion: agreements && !agreementsKnown ? agreements.version : undefined }), row.id);
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
            // The gadget session lives on across messages: compact it once it is quiet and nearly full.
            if (row.client_message_id.startsWith(GADGET_PREFIX)) this.agent.compactWhenIdle(event.conversationId);
        }
    };
    private syncTurn(row: TaskRow) {
        // Replayed reconciliation for the earlier turn must not reopen a
        // question that a later execution turn has already answered.
        if (row.status === "completed" && row.plan_json && (JSON.parse(row.plan_json) as TaskPlan).answeredBy) return;
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
        // The last answer stands, also after a supplement mid-turn: the executor carries over
        // what still holds from an earlier answer and drops what the supplement overturned.
        const last = items.filter(i => i.phase === "final_answer").at(-1) ?? items.at(-1);
        const question = turn.status === "completed" && !row.schedule_id && last?.text ? executorQuestion(last.text) : null;
        const plan = question && row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null;
        if (plan && question) { plan.clarification = question.question; plan.options = question.options ?? undefined; plan.form = question.form ?? undefined; }
        const status = question ? "needs_input" : turn.status;
        this.db.prepare("UPDATE tasks SET status=?,result=?,error=?,completed_at=?,plan_json=COALESCE(?,plan_json) WHERE id=?")
            .run(status, question ? question.result : last?.text ?? null, turn.error, turn.completed_at, plan ? JSON.stringify(plan) : null, row.id);
        if (status === "completed") this.recordFeed(this.get(row.id)!);
        this.notifyChange(row.id, row.status);
    }

    // ------------------------------------------------------------- schedules

    private scheduleRow(id: string): ScheduleRow | null {
        return (this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as unknown as ScheduleRow | undefined) ?? null;
    }
    private planningSchedules(ownerId: string): PlanningSchedule[] {
        return (this.db.prepare("SELECT * FROM schedules WHERE owner_id=? AND status IN ('active','paused') ORDER BY created_at").all(ownerId) as unknown as ScheduleRow[])
            .map(s => ({ id: s.id, title: s.title, rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), status: s.status, instruction: s.instruction.slice(0, 400) }));
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
        const at = this.cfg.agent.dailyFeedAt ?? FEED_AT;
        const existing = this.db.prepare("SELECT id,spec_json,next_run_at FROM schedules WHERE owner_id=? AND builtin=?").get(ownerId, DAILY_FEED) as { id: string; spec_json: string; next_run_at: number | null } | undefined;
        if (existing) {
            // A feed still on the shared 08:00 moves to the account's own minutes; a time the person chose stays.
            // The next run keeps its day and moves by the same minutes, so a run already made today is not repeated.
            const spec = JSON.parse(existing.spec_json) as ScheduleSpec;
            if (spec.kind !== "daily" || spec.at !== FEED_AT || at === FEED_AT) return;
            const shift = (clockMinutes(at) - clockMinutes(FEED_AT)) * 60_000;
            this.db.prepare("UPDATE schedules SET spec_json=?,next_run_at=?,updated_at=? WHERE id=?")
                .run(JSON.stringify({ ...spec, at }), existing.next_run_at === null ? null : existing.next_run_at + shift, Date.now(), existing.id);
            return;
        }
        const spec: ScheduleSpec = { ...FEED_SPEC, at };
        const tz = this.cfg.browser.timezone;
        const now = Date.now();
        this.db.prepare("INSERT INTO schedules (id,owner_id,title,instruction,spec_json,timezone,resources_json,status,next_run_at,created_at,updated_at,builtin) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)")
            .run(randomId("sched"), ownerId, "每日推送", FEED_INSTRUCTION, JSON.stringify(spec), tz, JSON.stringify(["browser"]), nextRun(spec, now, tz), now, now, DAILY_FEED);
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
    /** What a feed run works from: every earlier task of the person, what recent feeds said and what followed, and what the feed was told to keep in mind. */
    private feedBrief(row: TaskRow): string {
        const ownerId = this.ownerId(row);
        const tz = this.cfg.browser.timezone;
        const date = (ts: number) => describeNow(ts, tz);
        const cut = (text: string | null, n: number) => { const c = [...(text ?? "").replace(/\s+/g, " ").trim()]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : c.join(""); };
        // A window of days, not of tasks: on a busy account a fixed count covered barely one day.
        const mine = this.db.prepare("SELECT * FROM tasks WHERE schedule_id IS NULL AND merged_into IS NULL AND created_at>=? AND created_at<? AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) ORDER BY created_at DESC LIMIT ?")
            .all(row.created_at - FEED_TASK_DAYS * 86_400_000, row.created_at, ownerId, FEED_TASK_MAX) as unknown as TaskRow[];
        // The newest in detail; older ones by date and title, each title once.
        const titled = new Set<string>();
        const tasks = mine.flatMap((t, i) => {
            if (i < FEED_TASK_DETAILED) return [{ date: date(t.created_at), title: t.title, request: cut(t.input_text, 160), status: t.status, result: cut(t.result, 200) }];
            if (titled.has(t.title)) return [];
            titled.add(t.title);
            return [{ date: date(t.created_at), title: t.title }];
        });
        const feeds = this.db.prepare("SELECT * FROM feed_history WHERE owner_id=? AND created_at<? ORDER BY created_at DESC LIMIT 14").all(ownerId, row.created_at) as Array<{ task_id: string; created_at: number; topics_json: string; empty: number }>;
        const feedHistory = feeds.map((f, i) => {
            const until = i === 0 ? row.created_at : feeds[i - 1]!.created_at;
            const after = mine.filter(t => t.created_at > f.created_at && t.created_at < until).map(t => t.title).slice(0, 8);
            // What the person said in reply to that very push (a task they started from it).
            const replies = (this.db.prepare("SELECT title,input_text FROM tasks WHERE schedule_id IS NULL AND (related_task_id=? OR merged_into=?) AND created_at<? ORDER BY created_at LIMIT 5").all(f.task_id, f.task_id, row.created_at) as Array<{ title: string; input_text: string }>)
                .map(t => ({ title: t.title, request: cut(t.input_text, 120) }));
            return { date: date(f.created_at), topics: JSON.parse(f.topics_json) as string[], nothingToday: !!f.empty, userTasksAfter: after, ...(replies.length ? { replies } : {}) };
        });
        const s = row.schedule_id ? this.scheduleRow(row.schedule_id) : null;
        const asked = s && s.instruction.trim() !== FEED_INSTRUCTION ? s.instruction.trim() : null;
        const memory = this.feedMemory(ownerId);
        const kept = Object.fromEntries(FEED_MEMORY_KINDS.map(k => [k, memory.filter(m => m.kind === k).map(m => ({ id: m.id, text: m.text, from: m.source === "user" ? "用户说的" : "推送学到的", date: date(m.created_at) }))]));
        return [
            `这是内置的「每日推送」（每天 ${(s ? JSON.parse(s.spec_json) as ScheduleSpec : FEED_SPEC).at}）在 ${date(row.created_at)} 的自动运行。用户此刻不在对话中。你的工作：根据用户过往的全部任务记录、他交代的要求和关心的内容，挑出今天他最可能感兴趣、或需要提醒的 3-8 件事，像贴心的私人助理一样简短告诉他。`,
            "这是主动整理，不受上文“按请求实际需要控制工作量”“过程尽量简短”的限制：要实际动手查证，不要只凭记录写。邮箱和订单物流只是其中一项，不能占满整次推送；另外从任务记录里近几天在看、在比价或在犹豫的商品和话题中挑出 2-4 项（例如在等折扣的首饰手表、想买的主机或装备、关注的票价、在跟进的政策），实际去查今天的价格、折扣或最新动态。",
            ...(asked ? [`用户对每日推送的要求（优先照做，可以改变下面的默认做法，但不能突破只读和安全规则）：${asked}`] : []),
            "从任务记录里找线索：关注过的商品和价格（例如某款电脑、婴儿用品）、在比价或犹豫要不要买的东西、临近的日期和预约（证件、疫苗、账单、出行）、做了一半或说过以后再看的事、长期关心的话题。记录不限于最近一天，越早的兴趣越要核实是否仍然相关。",
            "需要最新信息时（价格、库存、天气、新闻）用浏览器或网络查证，只报告查到的事实并附来源链接；查不到就不写，不编造。只写有实际变化或与今天相关的事，例如“你关注的 Mac Studio 在 Best Buy 降到 $1,799，比上周低 $200”；没有变化的例行信息不写。没有以前的价格可比时，写今天查到的价格和是否在打折、离常见价有多远，这本身就是有用的信息。",
            "只读查看用户自己的网页：沙箱浏览器里用户已经登录、任务记录里用过或他要求看的网站（例如 Gmail、Outlook 邮箱，X、小红书等关注的动态，购物网站的订单页，账单页），可以打开看今天有没有需要提醒的事：要处理或快到期的邮件（账单、续费、预约确认、需要回复的人）、订单和快递变化、关注的人或话题的重要新动态。严格只读：只打开、滚动、阅读，不发送、回复、评论、点赞、关注、购买、下单、删除、归档、加标记，不改任何设置；不点开未读邮件和私信（会变成已读），用列表里的标题和摘要判断；没登录的网站直接跳过，不要登录，也不要请用户帮忙。写到邮件等私人内容只写要点、不贴全文。用完关掉自己打开的标签页。",
            "避免打扰：参考 feedHistory（最近几次推送的话题；之后用户的新任务 userTasksAfter；replies 是用户直接回复那次推送说的话）。同一话题最近已连续推过 3 次、而之后用户没有任何相关的新任务，说明他已不再关注，停止推送这个话题，除非出现重大新变化；用户最近新任务里体现的新兴趣优先；昨天说过且没有变化的不再重复。记住的内容 memory 里 care 是要多留意的，avoid 是不要再推的，note 是用户对推送的习惯和偏好，都要遵守。",
            "持续改进：feedHistory 里能看出用户对推送有明确反应时（例如回复说有用、要更多、别再推，或接着就某条推送做了任务，或某个话题推了几次一直没人理），用 aio_schedule 的 feed_update（source 填 \"feed\"）记下来：要多留意的加 care，不要再推的加 avoid，推送的形式和时机偏好加 note，过时或相反的旧条目用 remove 删掉。每次最多改 3 条，只记有明确证据的，不重复已有的，不确定就不记。",
            "格式：第一行“今日为你留意”，下面每件事一条，每条一两句话，必要时附链接或地图卡片，说到具体商品降价时用商品卡片（带商品图）；适合在手机上点开快速读完。今天确实没有值得说的，只回复一句“今天没有需要特别提醒的事”，并在末尾单独一行写 <!--feed-empty-->。",
            "最后单独一行写 <!--feed-topics: [\"话题1\", \"话题2\"]-->，列出本次写到的话题（简短中文，例如“Mac Studio 降价”“Roy 疫苗预约”）；系统用它调整之后的推送，用户看不到这一行。不要提问后等待，不要创建定时任务。",
            "记住的内容 memory：", JSON.stringify(kept),
            `用户最近 ${FEED_TASK_DAYS} 天的任务记录（新到旧；最新 ${FEED_TASK_DETAILED} 条带请求和结果摘要，更早的只列日期和标题，同名只列最近一次）：`, JSON.stringify(tasks),
            "推送记录 feedHistory（新到旧）：", JSON.stringify(feedHistory),
        ].join("\n\n");
    }
    private feedMemory(ownerId: string): FeedMemoryRow[] {
        return this.db.prepare("SELECT * FROM feed_memory WHERE owner_id=? ORDER BY created_at").all(ownerId) as unknown as FeedMemoryRow[];
    }
    private feedSchedule(ownerId: string): ScheduleRow {
        const s = this.db.prepare("SELECT * FROM schedules WHERE owner_id=? AND builtin=?").get(ownerId, DAILY_FEED) as unknown as ScheduleRow | undefined;
        if (!s) throw new Error("这个账号没有每日推送");
        return s;
    }
    /** The daily feed as the person's tasks see and change it. */
    feedSettings(userId: string) {
        const s = this.feedSchedule(userId);
        const tz = this.cfg.browser.timezone;
        return {
            title: s.title, rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), status: s.status,
            nextRun: s.next_run_at && s.status === "active" ? formatWhen(s.next_run_at, s.timezone) : null,
            instruction: s.instruction, customized: s.instruction.trim() !== FEED_INSTRUCTION,
            memory: this.feedMemory(userId).map(m => ({ id: m.id, kind: m.kind, text: m.text, source: m.source, date: describeNow(m.created_at, tz) })),
        };
    }
    /**
     * Change what the daily feed does: the person's own instruction (empty puts the
     * default back), its time, and what it keeps in mind. All or nothing.
     */
    updateFeed(userId: string, args: Record<string, unknown>): string {
        const s = this.feedSchedule(userId);
        const source = args.source === "feed" ? "feed" : "user";
        const now = Date.now();
        const said: string[] = [];
        let instruction: string | null = null;
        if (args.instruction !== undefined && args.instruction !== null) {
            if (typeof args.instruction !== "string") throw new Error("instruction 要是文字");
            const text = args.instruction.trim();
            if ([...text].length > FEED_INSTRUCTION_MAX) throw new Error(`instruction 太长（最多 ${FEED_INSTRUCTION_MAX} 字）`);
            instruction = text || FEED_INSTRUCTION;
            said.push(text ? "已更新每日推送的要求" : "每日推送的要求已恢复默认");
        }
        let timing: { spec: ScheduleSpec; next: number } | null = null;
        if (args.at !== undefined && args.at !== null) {
            const checked = validateSchedule({ kind: "daily", at: args.at }, now, s.timezone);
            if ("error" in checked) throw new Error(checked.error);
            timing = checked;
            said.push(`推送时间改为${describeSchedule(checked.spec)}`);
        }
        const existing = this.feedMemory(userId);
        const removeIds = new Set(Array.isArray(args.remove) ? args.remove.map(String) : []);
        for (const id of removeIds) if (!existing.some(m => m.id === id)) throw new Error(`没有 id 为 ${id} 的记忆`);
        const adds: Array<{ kind: FeedMemoryKind; text: string }> = [];
        let kept = 0;
        for (const item of Array.isArray(args.add) ? args.add : []) {
            const { kind, text } = (item ?? {}) as { kind?: unknown; text?: unknown };
            if (!FEED_MEMORY_KINDS.includes(kind as FeedMemoryKind)) throw new Error("add 里的 kind 只能是 care、avoid 或 note");
            const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
            if (!t || [...t].length > FEED_MEMORY_TEXT_MAX) throw new Error(`add 里的 text 要有内容，最多 ${FEED_MEMORY_TEXT_MAX} 字`);
            if (existing.some(m => m.kind === kind && m.text === t && !removeIds.has(m.id))) kept += 1;
            else if (!adds.some(a => a.kind === kind && a.text === t)) adds.push({ kind: kind as FeedMemoryKind, text: t });
        }
        // Caring about something again takes it off the do-not-push list, and the other way round.
        for (const a of adds) {
            const opposite = a.kind === "care" ? "avoid" : a.kind === "avoid" ? "care" : null;
            for (const m of existing) if (m.kind === opposite && m.text === a.text) removeIds.add(m.id);
        }
        for (const kind of FEED_MEMORY_KINDS) {
            const count = existing.filter(m => m.kind === kind && !removeIds.has(m.id)).length + adds.filter(a => a.kind === kind).length;
            if (count > FEED_MEMORY_MAX) throw new Error(`「${FEED_MEMORY_LABEL[kind]}」最多 ${FEED_MEMORY_MAX} 条，请先用 remove 删掉过时的`);
        }
        if (!instruction && !timing && !adds.length && !removeIds.size) {
            if (kept) return "这些已经记着了，没有变化。";
            throw new Error("没有要改的：给 instruction、at、add 或 remove");
        }
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (instruction) this.db.prepare("UPDATE schedules SET instruction=?,updated_at=? WHERE id=?").run(instruction, now, s.id);
            if (timing) this.db.prepare("UPDATE schedules SET spec_json=?,next_run_at=CASE WHEN status='active' THEN ? ELSE next_run_at END,updated_at=? WHERE id=?").run(JSON.stringify(timing.spec), timing.next, now, s.id);
            for (const id of removeIds) this.db.prepare("DELETE FROM feed_memory WHERE id=? AND owner_id=?").run(id, userId);
            adds.forEach((a, i) => this.db.prepare("INSERT INTO feed_memory (id,owner_id,kind,text,source,created_at) VALUES (?,?,?,?,?,?)").run(randomId("feedmem"), userId, a.kind, a.text, source, now + i));
            this.db.exec("COMMIT");
        } catch (err) { this.db.exec("ROLLBACK"); throw err; }
        if (adds.length) said.push(`记下 ${adds.length} 条（${adds.map(a => `${FEED_MEMORY_LABEL[a.kind]}：${a.text}`).join("；")}）`);
        if (removeIds.size) said.push(`删掉 ${removeIds.size} 条旧的`);
        if (kept) said.push(`${kept} 条原本就记着`);
        if (timing) this.schedule();
        return said.join("；") + "。";
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
    /**
     * Change one of the account's schedules: its name, what each run does, its rule, whether
     * runs use the browser. A new rule counts its runs (maxRuns) afresh from now, and an ended
     * schedule with runs ahead starts again within the active cap. The built-in feed is
     * changed through its own settings instead.
     */
    updateScheduleFor(userId: string, input: { id?: unknown; title?: unknown; instruction?: unknown; schedule?: unknown; needsBrowser?: unknown }): { ok: true; message: string; schedule: ReturnType<TaskService["viewSchedule"]> } | { ok: false; error: string } {
        const s = this.scheduleRow(String(input.id ?? ""));
        if (!s || s.owner_id !== userId) return { ok: false, error: "定时任务不存在" };
        if (s.builtin) return { ok: false, error: `「${s.title}」是内置的每日推送，请用推送设置修改（feed_update），这里不能改` };
        let title = s.title, instruction = s.instruction, resources = s.resources_json;
        if (input.title !== undefined) {
            title = typeof input.title === "string" ? [...input.title.trim()].slice(0, 40).join("") : "";
            if (!title) return { ok: false, error: "title 不能为空" };
        }
        if (input.instruction !== undefined) {
            instruction = typeof input.instruction === "string" ? input.instruction.trim().slice(0, 2000) : "";
            if (!instruction) return { ok: false, error: "instruction 不能为空：写每次运行要做的事" };
        }
        if (typeof input.needsBrowser === "boolean") resources = JSON.stringify(input.needsBrowser ? ["browser"] : []);
        const now = Date.now();
        let spec = JSON.parse(s.spec_json) as ScheduleSpec, next = s.next_run_at, status = s.status, runCount = s.run_count;
        if (input.schedule !== undefined) {
            const checked = validateSchedule(input.schedule, now, s.timezone);
            if ("error" in checked) return { ok: false, error: checked.error };
            ({ spec, next } = checked);
            runCount = 0;
            if (status === "done") {
                const active = (this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE owner_id=? AND status='active' AND builtin IS NULL").get(userId) as { n: number }).n;
                if (active >= MAX_ACTIVE_SCHEDULES) return { ok: false, error: `已有 ${active} 个进行中的定时任务（上限 ${MAX_ACTIVE_SCHEDULES} 个），这个已结束的不能再开始。请先暂停或删除不需要的。` };
                status = "active";
            }
        }
        this.db.prepare("UPDATE schedules SET title=?,instruction=?,spec_json=?,resources_json=?,status=?,next_run_at=?,run_count=?,updated_at=? WHERE id=?")
            .run(title, instruction, JSON.stringify(spec), resources, status, status === "done" ? null : next, runCount, now, s.id);
        const tz = s.timezone;
        const when = status === "paused" ? "目前已暂停，恢复后按新的时间运行。" : status === "done" ? "已经没有下一次运行。" : `下次运行 ${formatWhen(next!, tz)}。`;
        return { ok: true, message: [`已更新定时任务「${title}」：${describeSchedule(spec)}（按 ${tz} 时间），${when}`, `每次会做：${instruction}`].join("\n\n"), schedule: this.viewSchedule(this.scheduleRow(s.id)!) };
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
            appendTo: null, resume: null, clarification: null,
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
            id: s.id, title: s.title, instruction: s.instruction, rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), spec: JSON.parse(s.spec_json) as ScheduleSpec, needsBrowser: (JSON.parse(s.resources_json) as string[]).includes("browser"), status: s.status,
            timezone: s.timezone, nextRunAt: s.next_run_at, nextRunText: s.next_run_at ? formatWhen(s.next_run_at, s.timezone) : null,
            lastRunAt: s.last_run_at, lastTask: last ? { id: last.id, status: last.status } : null, runCount: s.run_count, createdAt: s.created_at,
            builtin: s.builtin,
            ...(s.builtin === DAILY_FEED ? { feed: { customized: s.instruction.trim() !== FEED_INSTRUCTION, memory: this.feedMemory(s.owner_id).map(m => ({ id: m.id, kind: m.kind, text: m.text, source: m.source })) } } : {}),
        };
    }
    /**
     * The account's past tasks for an executor searching them (aio_history history_search):
     * ranked by the same BM25 index the dispatcher recalls with (any of the words, titles
     * weigh double), newest first without a query. Each hit says which execution session it
     * belongs to and where in it, so a chain of follow-ups can be read in order.
     */
    searchHistoryFor(userId: string, opts: { query?: string; limit?: number; status?: string } = {}) {
        const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 30);
        const own = this.rows().filter(t => this.ownerId(t) === userId);
        const standing = own.filter(t => !t.merged_into);
        this.recall.forget(own.filter(t => t.merged_into).map(t => t.id));
        this.recall.sync(standing.map(t => ({ id: t.id, ownerId: userId, title: t.title, body: this.taskContext(t), result: t.result, latestMessage: t.result ?? (t.turn_id && DISPATCHED.has(t.status) ? this.latestAgentMessage(t.turn_id) : null) })));
        const byId = new Map(standing.map(t => [t.id, t]));
        const statusOk = (t: TaskRow) => !opts.status || (opts.status === "open" ? !TERMINAL.has(t.status) : t.status === opts.status);
        const query = opts.query?.trim() ?? "";
        let found: TaskRow[];
        if (query) {
            found = this.recall.rank(userId, query, 200).map(h => byId.get(h.id)).filter((t): t is TaskRow => !!t && statusOk(t));
            // A single character, or a symbol the index drops: match it literally.
            if (!found.length) found = [...standing].reverse().filter(t => statusOk(t) && [t.title, this.taskContext(t), t.result ?? ""].some(x => x.includes(query)));
        } else found = [...standing].reverse().filter(statusOk);
        const terms = tokenize(query);
        return found.slice(0, limit).map(t => this.historyEntry(t, standing, terms));
    }
    /** One task in a search result: a summary, and where the query hit when it did. */
    private historyEntry(t: TaskRow, standing: TaskRow[], terms: string[]) {
        const tz = this.cfg.browser.timezone;
        const cut = (text: string | null, n: number) => { const c = [...(text ?? "").replace(/\s+/g, " ").trim()]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : c.join(""); };
        const result = this.shownResult(t) ?? "";
        // Where the query shows up in the result, when it does: that part, not the opening lines.
        const lower = result.toLowerCase();
        const at = terms.map(term => lower.indexOf(term)).filter(i => i >= 0).sort((a, b) => a - b)[0];
        const excerpt = at === undefined || at < 60 ? cut(result, 200) : "…" + cut(result.slice(Math.max(0, at - 60)), 200);
        const chain = standing.filter(x => this.executor(x) === this.executor(t));
        return {
            id: t.id, date: describeNow(t.created_at, tz), title: t.title, status: t.status,
            request: cut(this.taskContext(t), 120), result: excerpt,
            ...(chain.length > 1 ? { session: `同一执行会话的第 ${chain.indexOf(t) + 1}/${chain.length} 个任务` } : {}),
            ...(t.client_message_id.startsWith(GADGET_PREFIX) ? { from: "语音配件" } : t.schedule_id ? { from: "定时任务" } : {}),
        };
    }
    /**
     * One of the account's tasks in full (aio_history history_get), with the tasks of its
     * execution session in order, and on request what it actually did; null if it isn't theirs.
     */
    historyDetailFor(userId: string, id: string, opts: { process?: boolean } = {}) {
        const row = this.get(id);
        if (!row || row.merged_into || this.ownerId(row) !== userId) return null;
        const tz = this.cfg.browser.timezone;
        const supplements = (this.db.prepare("SELECT input_text FROM tasks WHERE merged_into=? AND status='merged' ORDER BY created_at").all(row.id) as { input_text: string }[]).map(r => r.input_text);
        const plan = row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null;
        const chain = this.rows().filter(t => !t.merged_into && this.ownerId(t) === userId && this.executor(t) === this.executor(row));
        const process = opts.process && row.turn_id ? processSteps(this.db, row.turn_id) : null;
        return {
            id: row.id, date: describeNow(row.created_at, tz), title: row.title, status: row.status,
            request: row.input_text.slice(0, 6000), ...(supplements.length ? { supplements } : {}),
            ...(row.status === "needs_input" && plan?.clarification ? { question: plan.clarification } : {}),
            result: TERMINAL.has(row.status) || row.status === "needs_input" ? this.shownResult(row)?.slice(0, 16000) ?? null : null,
            error: row.error,
            ...(chain.length > 1 ? { session: chain.map(t => ({ id: t.id, date: describeNow(t.created_at, tz), title: t.title, status: t.status, ...(t.id === row.id ? { current: true } : {}) })) } : {}),
            ...(process ? { process: process.steps, ...(process.more ? { processOmitted: `前面还有 ${process.more} 步未列出` } : {}) } : {}),
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
