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
import { applyTaskReference, cleanTitle, jevPlan, parsePlan, planningPrompt, titlePrompt, type PlanningTask, type PlanReport, type TaskPlan } from "./planning.js";
import { executorQuestion } from "./executorQuestion.js";
import { isSupportCard } from "./support.js";
import { RECALL_CAP, recordRecall, STEP_ANSWER_CHARS, STEP_PROMPT_CHARS, TaskRecall, tokenize, type RecallEvent, type RecallSource } from "./recall.js";
import { processSteps, standingAgreements } from "./history.js";
import type { DispatchTimingSink } from "../codex/dispatchTiming.js";
import { dispatchAdvice, formatRelevance, formatTimeline, lastQuestion, routingQuestion, timeline, type JevRelevance } from "./context.js";
import { describeNow, describeSchedule, formatWhen, MAX_ACTIVE_SCHEDULES, nextRun, validateSchedule, type ScheduleSpec } from "./schedules.js";
import type { PlanningSchedule, ScheduleActionName } from "./planning.js";
import { answerLanguage, isLocale, readLocale, writeLocale, type Locale } from "../locale.js";
import type { SharePage } from "../share.js";
import type { Widget } from "../widgets.js";
import { runInLocaleOr, t } from "../i18n/index.js";
import { kbBrief, kbEnabled } from "../taskKb/read.js";
import { MAX_ATTACHMENTS } from "../../common/attachments.js";
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
/**
 * The feed's own instruction until the person words it themselves (the model reads it;
 * people see it in their language, `feedInstruction` in the catalog). Older feeds hold
 * the earlier Chinese one, which counts as the default too.
 */
const FEED_INSTRUCTION = "From the user's past tasks, gather what they may find interesting today and the reminders they need";
const LEGACY_FEED_INSTRUCTION = "根据你过往的任务，整理今天你可能感兴趣的内容和需要的提醒"; // i18n-exempt: the default instruction older feeds stored
const isDefaultFeedInstruction = (instruction: string) => [FEED_INSTRUCTION, LEGACY_FEED_INSTRUCTION].includes(instruction.trim());
/** The stored title of a new feed; people see the feed under `feedTitle` in their language, whatever its rows hold. */
const FEED_TITLE = "Daily feed";
/** What the feed keeps in mind: what the person cares about, what to stop pushing, what their reactions taught it. */
type FeedMemoryKind = "care" | "avoid" | "note";
const FEED_MEMORY_KINDS: FeedMemoryKind[] = ["care", "avoid", "note"];
const FEED_MEMORY_LABEL: Record<FeedMemoryKind, string> = { care: "care", avoid: "avoid", note: "note" };
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
    /** The console language the message was sent from; it becomes the account's language. */
    locale?: string | null;
}
const TERMINAL = new Set(["completed", "failed", "interrupted", "unknown"]);
/** How many widgets an execution prompt names. */
const WIDGETS_SHOWN = 20;
/** How many clawpages an execution prompt names. */
const CLAWPAGES_SHOWN = 12;
/** The task list's keyset cursor: [rank, time, id] of the last row a page held. */
const encodeCursor = (key: [number, number, string]) => Buffer.from(JSON.stringify(key)).toString("base64url");
export class TaskCursorError extends Error {}
/** None of the account's schedules has this id. */
export class ScheduleNotFoundError extends Error {
    readonly code = "not_found";
    constructor() { super(t().tasks.schedules.notFound); }
}
function decodeCursor(cursor: string): [number, number, string] {
    try {
        const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
        if (Array.isArray(key) && key.length === 3 && Number.isInteger(key[0]) && Number.isFinite(key[1]) && typeof key[2] === "string") return key as [number, number, string];
    } catch { /* falls through */ }
    throw new TaskCursorError(t().tasks.errors.badCursor);
}
/** client_message_id prefix of messages from the voice gadget (submitGadget). */
const GADGET_PREFIX = "gadget:";
/** Related tasks an executor's turn gets as background, once sessions are expanded into their turns. */
const MAX_RELATED_TURNS = 12;
const DISPATCHED = new Set(["queued", "running", "stopping"]);
/** The main inbox owns delegation; manual continuations reuse the same executor thread. */
/** A session idle this long is picked up with a reminder that what it holds may be out of date. */
const STALE_SESSION_HOURS = 6;

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
        this.db.prepare("UPDATE tasks SET status='merge_unknown',error=? WHERE status='steering'").run(t().tasks.errors.steeringAfterRestart);
        for (const row of this.rows()) {
            if (row.turn_id && !row.merged_into && !TERMINAL.has(row.status))
                this.syncTurn(row);
        }
        this.agent.events.on("event", this.onEvent);
        this.schedule();
        this.ensureDailyFeed();
        // Timers keep the language of whatever started them: scheduled runs are written in the account's.
        this.#ticker = setInterval(() => runInLocaleOr(() => this.locale(), () => this.runDueSchedules()), SCHEDULE_TICK_MS);
        this.#ticker.unref?.();
        this.runDueSchedules();
    }
    close(): void { this.#closed = true; this.agent.events.off("event", this.onEvent); if (this.#ticker) clearInterval(this.#ticker); }
    private rows(): TaskRow[] { return this.db.prepare("SELECT * FROM tasks WHERE (? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE owner_id=?)) ORDER BY created_at, id").all(this.cfg.runtimeUserId ?? null, this.cfg.runtimeUserId ?? null) as unknown as TaskRow[]; }
    /** rows() narrowed to some statuses (idx_tasks_status): the scheduler and the feed's wait reasons run often and need only these. */
    private rowsWithStatus(...statuses: string[]): TaskRow[] { return this.db.prepare(`SELECT * FROM tasks WHERE status IN (${statuses.map(() => "?").join(",")}) AND (? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE owner_id=?)) ORDER BY created_at, id`).all(...statuses, this.cfg.runtimeUserId ?? null, this.cfg.runtimeUserId ?? null) as unknown as TaskRow[]; }
    /** The supplements merged into a task (idx_tasks_merged). */
    private mergedRows(id: string): TaskRow[] { return this.db.prepare("SELECT * FROM tasks WHERE merged_into=? AND status='merged' ORDER BY created_at, id").all(id) as unknown as TaskRow[]; }
    /** rows() of one executor session (idx_tasks_execution). */
    private sessionRows(executor: string): TaskRow[] { return this.db.prepare("SELECT * FROM tasks WHERE COALESCE(execution_conversation_id, conversation_id)=? AND (? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE owner_id=?)) ORDER BY created_at, id").all(executor, this.cfg.runtimeUserId ?? null, this.cfg.runtimeUserId ?? null) as unknown as TaskRow[]; }
    get(id: string): TaskRow | null { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow ?? null; }
    ownerId(row: TaskRow): string { return this.agent.getConversation(row.conversation_id)!.owner_id; }
    belongsTo(id: string, userId: string): boolean { const row = this.get(id); return !!row && this.ownerId(row) === userId; }
    private executor(row: TaskRow): string { return row.execution_conversation_id ?? row.conversation_id; }
    #releaseHumanTabs: ((key: string) => Promise<number>) | null = null;
    #onCompleted: ((taskId: string) => void) | null = null;
    /** Told of every task that finished as completed (the knowledge maintainer reads them). */
    onTaskCompleted(listener: (taskId: string) => void): void { this.#onCompleted = listener; }
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
        const same = this.sessionRows(this.executor(ref)).filter(t => t.id !== row.id && t.created_at < row.created_at && !t.merged_into);
        return same.filter(t => ["planning", "needs_input", "waiting", "queued", "running", "stopping"].includes(t.status)).at(-1) ?? ref;
    }
    /** The account's console language: what its user-visible model output is written in. */
    locale(): Locale { return readLocale(this.db); }
    /** A choice on the settings page. */
    setLocale(locale: Locale): void { writeLocale(this.db, locale, "manual"); }
    /** The language a console opened in: taken once per account, and never over a choice. */
    syncLocale(locale: Locale): boolean { return writeLocale(this.db, locale, "open"); }
    setNotifier(notifier: ((task: ReturnType<TaskService["view"]>) => void) | null): void { this.#notifier = notifier; }
    /** The account's clawpages, so its executor knows what it already built and what their data holds. */
    /** The personal knowledge base's best matches, then each shared library's, under its name. */
    knowledgeBrief(userId: string, query: string): { text: string; version: string } | null {
        const parts: string[] = [];
        const own = kbBrief(this.db, userId, query);
        if (own) parts.push(own.text);
        let libraries: Array<{ db: Db; id: string; name: string }> = [];
        try { libraries = this.#libraries?.(userId) ?? []; } catch { /* a library that cannot be read adds nothing */ }
        for (const lib of libraries) {
            const brief = kbBrief(lib.db, lib.id, query, 400);
            if (brief) parts.push(`From the shared knowledge base "${lib.name}" (kept with other people):\n${brief.text}`);
        }
        if (!parts.length) return null;
        const text = parts.join("\n");
        return { text, version: createHash("sha256").update(text).digest("hex").slice(0, 8) };
    }
    setClawpages(list: ((userId: string) => SharePage[]) | null): void { this.#clawpages = list; }
    /** The shared knowledge bases an account reads (docs/SHARED-KB.md), for the notes a task starts with. */
    setSharedLibraries(list: ((userId: string) => Array<{ db: Db; id: string; name: string }>) | null): void { this.#libraries = list; }
    #libraries: ((userId: string) => Array<{ db: Db; id: string; name: string }>) | null = null;
    #clawpages: ((userId: string) => SharePage[]) | null = null;
    /** The account's clawpages for an execution prompt: the most recently active first, each with its tables. */
    private clawpagesNote(row: TaskRow): string | null {
        let pages: SharePage[];
        try { pages = this.#clawpages?.(this.ownerId(row)) ?? []; } catch { return null; }
        if (!pages.length) return null;
        const active = (p: SharePage) => Math.max(p.updatedAt, ...p.tables.map(t => t.updatedAt));
        const when = (ts: number) => formatWhen(ts, this.cfg.browser.timezone);
        const shown = [...pages].sort((a, b) => active(b) - active(a)).slice(0, CLAWPAGES_SHOWN);
        const lines = shown.map(p => `- ${p.name} "${p.title}" ${p.url} (published ${when(p.updatedAt)}${p.updatedBy ? ` by collaborator "${p.updatedBy}"` : ""}${p.restoredFrom ? `, restored from the version of ${when(p.restoredFrom)}` : ""}${p.collaborators ? `; ${p.collaborators} collaborator${p.collaborators > 1 ? "s" : ""}` : ""})${p.tables.length
            ? `; tables: ${p.tables.map(t => `${t.name} (${t.permission}, ${t.records} records${t.records ? `, last change ${when(t.updatedAt)}` : ""})`).join(", ")}`
            : "; no data tables"}`);
        return [`The user's clawpages (web pages and mini apps published for them; ${pages.length} in all${pages.length > shown.length ? `, the ${shown.length} most recently active listed` : ""}). When this message is about one of them, work on that clawpage with the clawpages skill: read or change its data with its data commands, and to change the page, pull it, edit, and publish again under the same name so the link stays. The data reflects what visitors and the user did since; it is the user's, so do not delete or overwrite it unless asked. A page with collaborators is also changed by other people's agents: pull it before changing it:`, ...lines].join("\n");
    }
    /** The account's widgets, so its executor reuses and improves them instead of building another. */
    setWidgets(list: ((userId: string) => Widget[]) | null): void { this.#widgets = list; }
    #widgets: ((userId: string) => Widget[]) | null = null;
    private widgetsNote(row: TaskRow): string | null {
        if (!this.#widgets) return null;
        let widgets: Widget[];
        try { widgets = this.#widgets(this.ownerId(row)); } catch { return null; }
        const intro = "Widgets: when content would read better as an interactive or visual component than as text (a board, timeline, comparison, tracker, calculator, live view), show it with a widget block in your reply; the widgets skill says how to build, publish and embed one.";
        if (!widgets.length) return intro;
        const shown = widgets.slice(0, WIDGETS_SHOWN);
        return [`${intro} The user's widgets (${widgets.length}${widgets.length > shown.length ? `, the ${shown.length} most recently changed listed` : ""}); reuse or improve one that fits before building a new one:`,
            ...shown.map(w => `- ${w.name} "${w.title}": ${w.description.replace(/\s+/g, " ").slice(0, 300)}`)].join("\n");
    }
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
        const s = row.schedule_id ? this.scheduleRow(row.schedule_id) : null;
        return {
            // A feed run is named after the feed, in the language it is shown in.
            id: row.id, revision: row.revision, title: s?.builtin === DAILY_FEED && row.title === s.title ? this.scheduleTitle(s) : row.title, text: row.input_text, conversationId: this.executor(parent ?? row), mergedInto: row.merged_into, mergedTitle: parent?.title ?? null,
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
            schedule: row.schedule_id ? (s ? this.scheduleLabel(s) : { id: row.schedule_id, title: row.title, rule: t().tasks.schedules.deleted }) : null,
            // A support card (support.ts): nobody typed it, so the console shows a support note instead.
            support: isSupportCard(row.client_message_id),
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
        const words = t().tasks.waiting;
        const plan = JSON.parse(row.plan_json) as TaskPlan;
        const reference = this.referenceTarget(row);
        if (reference?.status === "stopping") return { label: words.stopping, message: words.stoppingMessage(reference.title) };
        const dependency = plan.dependencies.map(id => this.get(id)).find(t => t && t.status !== "completed");
        if (dependency) return { label: words.dependency, message: words.dependencyMessage(dependency.title) };
        const parent = row.merged_into ? this.get(row.merged_into) : null;
        const claims = parent ? [...this.claims(parent), ...this.claims(row)] : this.claims(row);
        const active = this.rowsWithStatus(...DISPATCHED).filter(t => t.id !== parent?.id);
        const blocker = active.find(t => (parent ? [parent, row] : [row]).some(mine => claimsConflict(this.held(mine), this.held(t))));
        if (blocker) {
            const browser = claims.includes("browser") && this.claims(blocker).includes("browser");
            return { label: browser ? words.browser : words.files, message: words.busyMessage(this.ownerId(blocker) === this.ownerId(row) ? blocker.title : null, browser) };
        }
        if (!parent && active.length >= this.cfg.agent.maxConcurrentTurns) return { label: words.slot, message: words.slotMessage(this.cfg.agent.maxConcurrentTurns) };
        return { label: parent ? words.appending : words.starting, message: parent ? words.appendingMessage : words.startingMessage };
    }
    /** One page of the main feed: the latest `limit` tasks (the first screen shows only these), older ones by `before`. */
    list(before = Number.MAX_SAFE_INTEGER, userId = "owner_1", limit = 20) {
        const rows = this.db.prepare("SELECT * FROM tasks WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(userId, before, limit + 1) as unknown as TaskRow[];
        const page = rows.slice(0, limit);
        const nextBefore = rows.length > limit ? page.at(-1)!.created_at : null;
        // Polls must also update older unfinished work after a long burst of messages.
        const pending = before === Number.MAX_SAFE_INTEGER ? this.db.prepare("SELECT * FROM tasks WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) AND status NOT IN ('completed','failed','interrupted','unknown','merged')").all(userId) as unknown as TaskRow[] : [];
        // An old running task can finish outside the admission-time page. Keep
        // recent reports in the live feed too, so it never gets stuck at Working.
        const finished = before === Number.MAX_SAFE_INTEGER ? this.db.prepare("SELECT * FROM tasks WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT ?").all(userId, limit) as unknown as TaskRow[] : [];
        const merged = new Map([...page, ...pending, ...finished].map(r => [r.id, r]));
        return { tasks: [...merged.values()].sort((a, b) => a.created_at - b.created_at).map(r => this.view(r)), nextBefore };
    }
    /**
     * The files page: the main session's replies that name a path in the workspace, newest
     * first, `limit` at a time (older ones by `before`). Only replies already shown count.
     * The console picks the files out of each reply with the same Markdown parser it shows
     * the reply with, so the page lists exactly the files the conversation shows as cards
     * (web links are not files), and leaves out what the person sent.
     */
    files(userId: string, before = Number.MAX_SAFE_INTEGER, limit = 40) {
        const shown = [...TERMINAL, "needs_input"];
        const named = `%${this.cfg.sandbox.containerWorkspaceDir.replace(/[\\%_]/g, c => `\\${c}`)}/%`;
        const rows = this.db.prepare(`SELECT * FROM tasks WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) AND created_at < ?
            AND status IN (${shown.map(() => "?").join(",")}) AND result LIKE ? ESCAPE '\\'
            ORDER BY created_at DESC LIMIT ?`).all(userId, before, ...shown, named, limit + 1) as unknown as TaskRow[];
        const page = rows.slice(0, limit);
        return {
            messages: page.map(row => ({ taskId: row.id, title: row.title, createdAt: row.created_at, completedAt: row.completed_at, result: this.shownResult(row) ?? "" })),
            nextBefore: rows.length > limit ? page.at(-1)!.created_at : null,
        };
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
            throw new Error(t().tasks.errors.emptyMessage);
        if (text.length > 64000 || attachments.length > MAX_ATTACHMENTS || !input.clientMessageId || input.clientMessageId.length > 200)
            throw new Error(t().tasks.errors.messageTooLarge);
        const existing = this.db.prepare("SELECT * FROM tasks WHERE client_message_id = ?").get(input.clientMessageId) as unknown as TaskRow | undefined;
        if (existing) {
            if (this.ownerId(existing) !== userId) throw new TurnConflictError(t().tasks.errors.idTaken);
            if (existing.input_text !== text || existing.attachments_json !== JSON.stringify(attachments) || existing.related_task_id !== related)
                throw new TurnConflictError(t().tasks.errors.idOtherTask);
            return { task: this.view(existing), duplicate: true };
        }
        if (related && !this.belongsTo(related, userId))
            throw new Error(t().tasks.errors.relatedMissing);
        if (isLocale(input.locale)) writeLocale(this.db, input.locale, "message");
        const frozen = isMember(this.db, userId) ? this.agent.memberSettings() : this.agent.resolveSubmitSettings({ conversationId: "main", text, clientMessageId: input.clientMessageId });
        const id = randomId("task");
        const title = [...(text || attachments.map(a => a.name ?? a.path).join(t().tasks.titleSeparator))].slice(0, 40).join("");
        // One transaction prevents a failed admission leaving an orphan child.
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const conv = this.agent.createConversation({ ownerId: userId, title: t().tasks.conversations.task(title), model: frozen.model });
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
        if (!text) throw new Error(t().tasks.errors.emptyMessage);
        if (text.length > 4000 || !input.clientMessageId || input.clientMessageId.length > 200) throw new Error(t().tasks.errors.gadgetTooLarge);
        const clientMessageId = GADGET_PREFIX + input.clientMessageId;
        const existing = this.db.prepare("SELECT * FROM tasks WHERE client_message_id = ?").get(clientMessageId) as unknown as TaskRow | undefined;
        if (existing) {
            if (this.ownerId(existing) !== input.userId || existing.input_text !== text) throw new TurnConflictError(t().tasks.errors.idOtherTask);
            return existing;
        }
        const frozen = isMember(this.db, input.userId) ? this.agent.memberSettings() : this.agent.resolveSubmitSettings({ conversationId: "main", text, clientMessageId, effort: "medium" });
        const previous = this.db.prepare("SELECT * FROM tasks WHERE client_message_id LIKE 'gadget:%' AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=?) ORDER BY created_at DESC LIMIT 1").get(input.userId) as unknown as TaskRow | undefined;
        const id = randomId("task");
        const title = [...text].slice(0, 40).join("");
        const plan: TaskPlan = { title, description: t().tasks.notes.gadget, related: [], dependencies: [], resources: [], appendTo: null, resume: null, clarification: null };
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const conv = this.agent.createConversation({ ownerId: input.userId, title: t().tasks.conversations.gadget(title), model: frozen.model });
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
            throw new Error(t().tasks.errors.notFound);
        if (row.merged_into && row.status !== "merging") throw new Error(t().tasks.errors.stopSupplement);
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
            throw new Error(t().tasks.errors.notFound);
        if (row.status !== "unknown")
            throw new Error(t().tasks.errors.archiveOnlyUnknown);
        const note = t().tasks.notes.archived;
        this.db.prepare("UPDATE tasks SET status='interrupted',error=?,completed_at=COALESCE(completed_at,?) WHERE id=? AND status='unknown'").run(row.error ? `${row.error}\n${note}` : note, Date.now(), id);
    }
    retryPlanning(id: string) {
        const row = this.get(id);
        if (!row || row.status !== "planning_failed" || row.turn_id)
            throw new Error(t().tasks.errors.retryOnlyUnplanned);
        this.db.prepare("UPDATE tasks SET status='planning',error=NULL WHERE id=?").run(id);
        this.schedule();
    }
    private schedule() {
        if (this.#closed || this.#scheduled)
            return;
        this.#scheduled = true;
        // Started from a timer (no request), tasks run and write their errors in the account's language.
        queueMicrotask(() => runInLocaleOr(() => this.locale(), () => {
            this.#scheduled = false;
            if (this.#closed)
                return;
            void this.deliverSupplements();
            this.dispatch();
            void this.planNext();
        }));
    }
    private async planNext() {
        if (this.#closed || this.#planning)
            return;
        const row = this.rowsWithStatus("planning")[0];
        if (!row)
            return;
        this.#planning = true;
        const started = Date.now();
        let measured = false;
        const trace: RecallEvent = { taskId: row.id, ownerId: this.ownerId(row), candidates: [], searches: [], rounds: 0, chosen: { related: [], appendTo: null }, gold: null, latencyMs: 0, promptChars: 0, failed: true, steps: [] };
        const steps = trace.steps!;
        try {
            const owner = this.ownerId(row);
            const everything = this.rows().filter(t => this.ownerId(t) === owner);
            const all = everything.filter(t => !t.merged_into && t.created_at < row.created_at).map(t => ({
                ...t,
                input_text: this.taskContext(t),
                clarification: t.status === "needs_input" && t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).clarification ?? null : null,
                latestMessage: t.result ?? (t.turn_id && DISPATCHED.has(t.status) ? this.latestAgentMessage(t.turn_id) : null),
            }));
            const byId = new Map(all.map(t => [t.id, t]));
            // Dispatch is per session: a task and the tasks that resumed it share one execution session,
            // so they are one candidate, represented by the session's latest task (what a steer or resume
            // reaches), with how the session began. Otherwise Jev and the dispatcher split one continuation
            // between a session's turns.
            const sessions = new Map<string, Array<(typeof all)[number]>>();
            for (const t of all) sessions.set(this.executor(t), [...(sessions.get(this.executor(t)) ?? []), t]);
            const covered = new Set<string>();
            const candidates = new Map<string, PlanningTask & { source: RecallSource; rank?: number; score?: number }>();
            const add = (t: PlanningTask, source: RecallSource, hit?: { rank: number; score: number }): boolean => {
                const turns = sessions.get(this.executor(byId.get(t.id) ?? (t as TaskRow))) ?? [];
                const lead = turns.at(-1) ?? t, first = turns[0];
                for (const turn of turns) covered.add(turn.id);
                covered.add(t.id);
                if (candidates.has(lead.id)) return false;
                candidates.set(lead.id, { ...lead, source, ...(hit ? { rank: hit.rank, score: Math.round(hit.score * 100) / 100 } : {}),
                    ...(first && turns.length > 1 ? { session: { turns: turns.length, title: first.title, request: first.input_text } } : {}) });
                return true;
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
                if (add(t, "recent")) recent += 1;
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
                for (const hit of this.recall.search(trace.ownerId, query, { exclude: new Set([row.id, ...covered]), cap: take })) {
                    const t = byId.get(hit.id);
                    if (t) add(t, source, hit);
                }
            };
            if (explicit) {
                // A task pointed at by hand is the answer search should have found: measure where it ranks.
                const rank = this.recall.rank(trace.ownerId, inputContext).find(h => h.id === explicit.id)?.rank ?? null;
                trace.gold = { id: explicit.id, rank, inWindow: windowIds.has(explicit.id) };
                // A quoted task fixes the route by its own state (a steer while it works, a resume once
                // it finished), so no dispatcher model runs: the message keeps that task's title.
                const plan: TaskPlan = { title: explicit.title, related: [], dependencies: [], resources: [], clarification: null };
                applyTaskReference(plan, this.referenceTarget(row)!);
                trace.candidates = [{ id: explicit.id, source: "explicit" }];
                trace.repairs = []; trace.failReason = null; trace.failed = false;
                measured = true;
                steps.push({ kind: "plan", at: Date.now(), plan, repairs: [] });
                await this.admitPlan(row, plan, inputContext);
                return;
            }
            recalled(inputContext, "recall");
            // Terse follow-ups can omit the entity; query the inverted index
            // once more with the adjacent task titles, still before Jev.
            if (inputContext.trim().length < 30 && candidates.size < MAX_CANDIDATES)
                recalled(`${inputContext}\n${all.filter(t => !t.schedule_id).slice(-3).map(t => t.title).join("\n")}`, "context");
            const files = [row,...this.mergedRows(row.id)]
                .flatMap(t=>JSON.parse(t.attachments_json) as TurnAttachment[]);
            const planningInput = [inputContext, ...(files.length ? [`Attachments so far (the executor can read them): ${JSON.stringify(files)}`] : [])].filter(Boolean).join("\n\n");
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
            // The timeline names each message's session by the same task the candidates use.
            const lines = timeline(everything, row).map(entry => {
                const owner = byId.get(entry.taskId);
                const lead = owner ? sessions.get(this.executor(owner))?.at(-1) : undefined;
                return lead && lead.id !== entry.taskId ? { ...entry, taskId: lead.id, title: lead.title, status: lead.status, ask: lastQuestion(lead), session: true } : entry;
            });
            const timelineText = formatTimeline(lines, row.created_at);
            const scheduling = { now: Date.now(), timezone: this.cfg.browser.timezone, schedules: this.planningSchedules(trace.ownerId) };
            steps.push({ kind: "context", at: Date.now(), timeline: timelineText, candidates: candidates.size });
            let relevance: JevRelevance | null = null;
            if (candidates.size && this.jev?.enabled) {
                const pool = [...candidates.values()].map(t => ({ ...byId.get(t.id)!, ...t, recalled: RECALLED.has(t.source) }));
                const q = routingQuestion(inputContext, pool, lines, row.created_at);
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
            // Jev sure of the route (it agrees with the dispatcher ~97% of the time there): take it as the
            // plan, start the executor now and name the task on the side, without waiting for a dispatcher.
            const direct = relevance?.suggestion && relevance.suggestion.probability > this.cfg.jev.directProbability
                ? jevPlan(relevance, previous, row.title) : null;
            if (direct) {
                trace.candidates = [...candidates.values()].map(c => ({ id: c.id, source: c.source, ...(c.rank ? { rank: c.rank, score: c.score } : {}) }));
                trace.repairs = []; trace.failReason = null; trace.failed = false;
                measured = true;
                steps.push({ kind: "plan", at: Date.now(), plan: direct, repairs: [] });
                await this.admitPlan(row, direct, inputContext);
                // A supplement keeps the title of the task it joins.
                if (!direct.appendTo && this.get(row.id)?.status === "waiting") void this.nameTask(row.id, inputContext);
                return;
            }
            // Jev's displayed 0% means the task cannot help the dispatcher classify this
            // message. Keep the full candidate set in the dispatch log, but do
            // not send that task's input/result/latest message (or its timeline
            // excerpt) to the dispatcher.
            const zeroIds = new Set(previous.filter(t => relevance?.scores?.[t.id] === 0).map(t => t.id));
            const lunaCandidates = previous.filter(t => !zeroIds.has(t.id));
            const lunaTimeline = zeroIds.size
                ? formatTimeline(lines.filter(entry => entry.current || !zeroIds.has(entry.taskId)), row.created_at)
                : timelineText;
            trace.rounds = 1;
            const prompt = planningPrompt(planningInput, lunaCandidates, row.related_task_id, { timeline: lunaTimeline, jev: relevance, now: describeNow(scheduling.now, scheduling.timezone), timezone: scheduling.timezone, schedules: scheduling.schedules, locale: this.locale() });
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
                const prompt = planningPrompt(planningInput, lunaCandidates, row.related_task_id, { correction: report.error ?? t().tasks.planning.unusable, timeline: lunaTimeline, jev: relevance, now: describeNow(scheduling.now, scheduling.timezone), timezone: scheduling.timezone, schedules: scheduling.schedules, locale: this.locale() });
                trace.promptChars += prompt.length;
                raw = await askWithTiming(prompt, trace.rounds);
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
                const first = report.error;
                steps.push({ kind: "ask", at: Date.now(), round: trace.rounds, prompt: prompt.slice(0, STEP_PROMPT_CHARS), answer: raw?.slice(0, STEP_ANSWER_CHARS) ?? null, correction: first ?? t().tasks.planning.unusable });
                report.error = undefined;
                plan = parsePlan(raw ?? null, lunaCandidates, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir, report, scheduling);
                report.repairs.unshift(t().tasks.planning.retried(first ?? t().tasks.planning.unusable));
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
                throw new Error(t().tasks.errors.planningFailed(report.error ?? t().tasks.planning.unusable));
            // Setting up or changing a schedule needs no executor: answer right here.
            if (plan.scheduleAction || (plan.schedule && !plan.schedule.runNow)) {
                if (this.#closed || this.get(row.id)?.status !== "planning") return;
                if (this.taskContext(this.get(row.id)!) !== inputContext) return;
                let answer: string;
                if (plan.scheduleAction?.action === "update") {
                    const changed = this.updateScheduleFor(trace.ownerId, { id: plan.scheduleAction.id, title: plan.title, instruction: plan.schedule!.instruction, schedule: plan.schedule!.spec });
                    answer = changed.ok ? changed.message : t().tasks.schedules.notUpdated(changed.error);
                } else {
                    // Cancelling one schedule and setting up another in the same message does both.
                    const action = plan.scheduleAction?.action;
                    answer = [action ? this.applyScheduleAction(trace.ownerId, plan.scheduleAction!.id, action) : null, plan.schedule ? this.createSchedule(row, plan) : null].filter(Boolean).join("\n\n");
                }
                this.db.prepare("UPDATE tasks SET title=?,plan_json=?,status='completed',result=?,completed_at=? WHERE id=?").run(plan.title, JSON.stringify(plan), answer, Date.now(), row.id);
                this.agent.renameConversation(row.conversation_id, plan.title);
                return;
            }
            await this.admitPlan(row, plan, inputContext);
        }
        catch (err) {
            if (!this.#closed && this.get(row.id)?.status === "planning") {
                const reason = err instanceof Error ? err.message : t().tasks.errors.planningFailedGeneric;
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
    /**
     * Related tasks with the sessions they lead: dispatch sees a session as its latest turn, but its first turn
     * usually holds the main result, so the executor gets the first and the latest two (the rest via history_get).
     */
    private sessionTurns(related: string[], row: TaskRow): string[] {
        const rows = this.rows().filter(t => t.created_at < row.created_at && !t.merged_into);
        const out = related.flatMap(id => {
            const t = this.get(id);
            if (!t) return [id];
            const turns = rows.filter(r => this.executor(r) === this.executor(t) && r.created_at <= t.created_at);
            return [...new Set([turns[0]?.id, ...turns.slice(-2).map(r => r.id), id].filter((x): x is string => !!x))];
        });
        return [...new Set(out)].slice(0, MAX_RELATED_TURNS);
    }
    /** Name a task Jev routed directly, once the small title model answers; it never holds up the task. */
    private async nameTask(id: string, text: string): Promise<void> {
        const row = this.get(id);
        if (!row || !this.codex.titleTask) return;
        const model = isMember(this.db, this.ownerId(row)) ? this.agent.memberSettings().model : undefined;
        const title = cleanTitle(await this.codex.titleTask(titlePrompt(text, this.locale()), model).catch(() => null));
        const now = this.get(id);
        if (!title || this.#closed || !now || now.merged_into || now.title !== row.title) return;
        this.db.prepare("UPDATE tasks SET title=?,plan_json=json_set(plan_json,'$.title',?) WHERE id=?").run(title, title, id);
        this.agent.renameConversation(now.conversation_id, title);
    }
    /** Admit a planning task under its plan: a supplement to the task it steers, or a waiting task of its own. */
    private async admitPlan(row: TaskRow, plan: TaskPlan, inputContext: string) {
        const root = this.cfg.sandbox.containerWorkspaceDir;
        plan.related = this.sessionTurns([...plan.dependencies, ...plan.related], row);
        // Historical resource hints only coordinate queueing/prewarming;
        // they are not an authorization boundary for the executor.
        if (this.resourceSandbox && plan.resources.length)
            plan.resources = await resolveResources(plan.resources, root, this.resourceSandbox);
        if (this.#closed || this.get(row.id)?.status !== "planning") return;
        if (this.taskContext(this.get(row.id)!) !== inputContext) return;
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
            const acknowledgement = t().tasks.notes.supplementReceived;
            this.db.prepare("UPDATE tasks SET status='completed',result=?,plan_json=? WHERE id=? AND status='needs_input'")
                .run([finalContinued.result, acknowledgement].filter(Boolean).join("\n\n"), JSON.stringify(answeredPlan), finalContinued.id);
        }
        this.agent.renameConversation(row.conversation_id, plan.title);
        this.notifyChange(row.id, "planning");
    }
    private taskContext(row: TaskRow): string {
        const supplements = this.db.prepare("SELECT input_text FROM tasks WHERE merged_into=? AND status='merged' ORDER BY created_at").all(row.id) as {input_text:string}[];
        const question = row.plan_json ? (JSON.parse(row.plan_json) as TaskPlan).clarification : null;
        return [row.input_text, ...(question ? [`This task's earlier question: ${question}`] : []),...supplements.map(r=>`User supplement: ${r.input_text}`)].join("\n\n");
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
            for(const candidate of this.rowsWithStatus('merging')) {
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
                    this.db.prepare("UPDATE tasks SET status='merge_failed',error=? WHERE id=?").run(t().tasks.errors.supplementDependency, row.id);
                    continue;
                }
                if (dependencies.some(t => t!.status !== 'completed')) continue;
                const parentPlan=JSON.parse(parent.plan_json) as TaskPlan;
                const resources=[...new Set([...parentPlan.resources,...plan.resources])];
                const otherActive=this.rowsWithStatus(...DISPATCHED).filter(t=>t.id!==parent.id);
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
                        `${handed ? `When the user sent this supplement, ${handed} browser tab(s) were still waiting on them (taken over, or where you had asked them to act); they have now been handed back to you automatically, and a browser_request_human that was waiting has returned, so you can carry on directly as the supplement says. Ask for a takeover again only if they really must act by hand.\n\n` : ""}This is the user's supplement to the current task, sent at ${new Date(row.created_at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })} (the same matter, not a new task). First work out what they mean, then carry on: if they corrected something or changed a condition (date, place, subject, quantity, etc.), adjust to the new requirement, and the approach and conclusions based on the old condition no longer hold; if they added a requirement or information, fold it in and complete everything together; if they ask you to stop or do something else, do so. Parts already done that are still valid need not be redone. The final reply follows the latest requirement and gives the complete result: carry over content you sent before that is still valid, and leave out anything that has been overturned. Use whatever files, browser and tools the user's request needs; the dispatcher's resource hints do not limit you.\n\nRecent conversation in the main session (in time order; ▶ is this supplement):\n${formatTimeline(timeline(this.rows().filter(t => this.ownerId(t) === this.ownerId(row)), row, 6), Date.now(), plan.jev)}${plan.jev ? `\n\nJev's per-task relevance and routing suggestion (background only):\n${formatRelevance(plan.jev, id => this.get(id)) ?? "none"}` : ''}\n\nThe dispatcher's judgment (background only): ${JSON.stringify({title:plan.title,description:plan.description,decision:plan.decision})}${dependencies.length ? `\n\nResults of the completed tasks this supplement needs: ${JSON.stringify(dependencies.map(t => ({id:t!.id,result:t!.result?.slice(0,16000)})))}` : ''}\n\nThe user's supplement:\n\n${row.input_text}\n\n${answerLanguage(this.locale(), true)}`,
                        JSON.parse(row.attachments_json),resources.includes("browser"));
                    if(this.#closed) return;
                    if(result==='browser_unavailable') this.db.prepare("UPDATE tasks SET status='merge_failed',error=? WHERE id=?").run(t().tasks.errors.supplementNeedsBrowser,row.id);
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
                        err instanceof JsonRpcResponseError ? t().tasks.errors.supplementRejected(err.message) : t().tasks.errors.supplementUnknown,row.id);
                }
            }
        } finally { this.#merging=false; if(this.#mergeAgain) { this.#mergeAgain=false; this.schedule(); } }
    }
    /** The fixed rules every delegated executor turn runs under; `taskId` names its own directory. */
    private executorRules(taskId: string): string[] {
        const dir = `${this.cfg.sandbox.containerWorkspaceDir}/tasks/${taskId}`;
        const tz = this.cfg.browser.timezone;
        return [
            "[How to work]",
            "Match the effort to what the request actually needs: ordinary chat, greetings, introducing yourself, explaining concepts and questions you can answer directly are answered right in the message, with no directories, no files, no environment checks and no screenshot checks. Use tools only when the answer needs outside facts, attachments or existing material; when you need the user's past information, look up the relevant records specifically. Identity and style follow the injected SOUL.md; do not search memory or look for SOUL.md to introduce yourself. When the user asks for a real action or a file deliverable, actually carry it out and verify it in proportion to the risk; a verbal answer is no substitute.",
            "Use files, the browser and other tools as the task needs; the dispatcher's resource hints do not limit you. aio_tabs restores the browser on demand and manages which task owns which tab. Sandbox commands need no approval, but that does not mean the user authorized them: do only what the user asked for and authorized.",
            `Understand and state times in the user's time zone (${tz}): the sandbox system clock is UTC; do not take it as the user's time, and do not say "my time zone is UTC". "Today", "tomorrow" and clock times all mean the user's time zone; the user's current time is given at the start of each turn.`,
            "[Files and directories]",
            `Create the task directory ${dir}/ only when you actually need to write files, and put every new file there instead of scattering files in the workspace root. The workspace is shared with other sub-agents: do not overwrite unrelated files, and update existing outputs only within the paths authorized this time; if you notice concurrent changes, check the current state first.`,
            `Put temporary files, render output, caches and tool configuration produced while running tools in ${dir}/.tmp/, and point TMPDIR at it; LibreOffice uses its own UserInstallation inside that directory. Do not reuse or clean shared paths such as /tmp/verify or /tmp/lo-final. Before finishing, wait for this task's writing subprocesses to complete; leave no background writes.`,
            "By default answer right in the message, without creating files. Make a file only when the user wants a file or a downloadable deliverable, or the content truly needs its own document or page; content being an explanation, a list or a plan is not in itself a reason for a document. Choose the format the content needs: plain text, lists and simple tables as well-structured Markdown (.md); guides, plans and explanations that need complex layout, charts, multi-column cards or interaction as a self-contained, phone-friendly HTML file (.html). Check how it actually renders before delivering, deliver it once it passes, and keep revising and re-checking only when you find a specific defect. When the user names Word, Excel, PPT or another format, use it. When delivering a file, give the key points in the message and link the file with a meaningful title, e.g. [Full three-day itinerary](absolute file path), not just \"download file\", and without exposing a long file name.",
            "[Final reply]",
            "You deliver as the user's personal assistant: the final reply leads with the most useful conclusion, recommendation, arrangement or deliverable; do not just say what you are about to do. Keep the necessary sources, unfinished items and limitations that affect the user's decisions (e.g. not booked yet, date still to be confirmed); do not drop useful evidence, links or uncertainty to make the result look more certain.",
            "The user does not care how it was done: the final reply does not report which skills, tools, commands, APIs or sub-agents you used, or the steps of creating and checking files, unless the user asks for those technical details. Execution and verification details worth noting go in the commentary, and not into deliverable documents either. Keep the commentary short; it is collapsed in the main session.",
            "[Message layout: picture cards on a phone]",
            "Main-session messages are read on a phone and should look like picture cards, not long plain text: one or two sentences of conclusion first, then cards, images and short paragraphs. Use tables only to compare a little data side by side (many columns need horizontal scrolling). Pick the cards below by content and place each next to the text it belongs to, not all piled up at the end:\n- Concrete items worth seeing with a picture: products, hotels, restaurants, sights, events, articles, videos, posts, recipes, etc. → ```cards picture cards\n- A specific place to go → ```map map card\n- A process with branches, merges or loops, or relationships between several parties → ```mermaid flowchart (a few steps in a straight line need no diagram)\n- Numbers to see as a chart: a stock's K-line, a price or metric over time, a comparison, shares of a whole → ```chart (drawn live from the numbers; never an image)\n- Other diagrams → ```svg\n- Images, video, audio → ![caption](path); files → [meaningful title](path)\n- The task is done and you offer optional follow-ups: pick one → ```choices; fill in a few items → ```form\n- You cannot continue without the user's answer → ```ask_user\nHow to write each card follows. If the JSON or syntax inside a code block is wrong, the message shows it as raw code.",
            `Images and files: embed them with Markdown image syntax ![caption](absolute path). png/jpg/webp/gif/svg images, mp4/mov/webm video and mp3/m4a/wav/ogg/flac audio in the workspace are shown in place (audio and video as players) and can be enlarged. Images on the web can be written as ![caption](https://…) (the system fetches them through the sandbox), but it is safer to save them into ${dir}/ first and reference that; generated images go there too, because files outside the workspace, such as ~/.codex, cannot be shown in a message. Write ordinary files as [meaningful title](absolute path); they show as file cards that can be previewed and downloaded. Give share-page links as they are; they show as share cards with one-tap copy.`,
            "Flowcharts (```mermaid, Mermaid syntax, drawn as an image in the message that can be enlarged and downloaded). First decide whether one is worth drawing: draw only when branches, merges, loops or relationships between several parties are clearer as a diagram than as text. 3–5 steps in a straight line are written as numbered steps or one line \"A → B → C\", and timelines as a dated list, with no diagram. When you draw, design for a phone screen:\n- Direction: a short chain of only 3–4 nodes uses flowchart LR (one horizontal row); with branches or more steps use flowchart TD (top to bottom), with no more than 3 nodes side by side on any level.\n- Text: a node holds only the action or result, at most about 10 Chinese characters or 5 English words; details go in the text below the diagram. Wrap text that contains CJK characters or punctuation in double quotes.\n- Shapes: start and end as stadiums A([\"Start\"]), steps as B[\"Fill in the form\"], decisions as hexagons C{{\"Passport valid 6 months?\"}}; never use diamonds {} (a diamond grows huge with its text). Label a decision's exits with short words on the edge: C -->|Yes| D.\n- When several parties work together, group them by role with subgraph (one level only), named after the role.\n- At most 12 nodes per diagram; split anything larger into several, each introduced by one sentence on what to look at.\n- Write only the diagram itself, with no %%{init}%%, classDef, style or click: colors, font sizes and corner radii are handled by the system.\nOther diagrams and simple charts go in a ```svg code block (a complete <svg> document), shown as an image.",
            "Picture cards: use them when introducing or comparing a few concrete things worth seeing with a picture, one card per item, all in one code block (at most 8 cards):\n```cards\n[{\"title\": \"Name\", \"image\": \"" + dir + "/image.jpg\", \"subtitle\": \"Source or category, e.g. Amazon, Mountain View · Museum, Author · Site\", \"tags\": [\"one or two short facts, e.g. opening hours, distance, duration, date\"], \"text\": \"One or two sentences of introduction\", \"points\": [\"Point one\", \"Point two\"], \"url\": \"https://details-page\", \"action\": \"Official site\"}]\n```\nFor products also add price, was (the original price) and rating, e.g. \"price\": \"$899\", \"was\": \"$1,199\", \"rating\": \"4.4 (1,203 reviews)\". Give a badge only to the card you truly recommend (e.g. \"Top pick\", \"Cheapest\"). action is the text on the link; leave it out for the default label. Use the fields that fit the content and omit the rest. Give each card a real image whenever possible: save it into the task directory with aio_tabs' browser_save_image and put the returned path in image. On a details page pass only path (it saves the page's main image); on a list page such as search results add a selector pointing at that item's image element. Never copy an image URL into image by hand: dropping or changing its version or signature parameters breaks it. If the page really has no image of it, omit image; never use an unrelated or illustrative picture. Write prices, ratings and opening hours only as found, and explain anything unverified in note. When you are only listing a few facts with nothing worth seeing, a plain list is fine. After the cards, say in a sentence or two how to choose or what to do next.",
            "Map cards: when the answer involves a specific place to go (a restaurant, sight, hotel, meeting place, destination, etc.), insert one at the relevant spot in the text, one code block per place; the user taps it to open the place in their phone's maps:\n```map\n{\"name\": \"Place name\", \"address\": \"Full address\", \"lat\": latitude, \"lng\": longitude}\n```\nFill in coordinates only with values found in a reliable source (map search results, the official site); never estimate. When you cannot get them, write only name and address and the system locates the place by address. Coordinates are WGS-84 by default; for coordinates taken from Amap (Gaode) or Tencent Maps add \"coord\": \"gcj02\". Places mentioned only in passing need no card.",
            "Data charts (```chart, JSON; the console draws it from the numbers: tap for values, a slider for long histories, the user's theme). Use one when the shape of the numbers is the answer (a trend, a K-line, a comparison of a few items, shares); a single number or two are text. Never draw such a chart with image_generate, an svg block or a rendered PNG. One chart per code block, data only from a tool or source you actually read, never made up:\n- K-line: {\"type\": \"candlestick\", \"title\": \"Kweichow Moutai daily (forward adjusted)\", \"note\": \"Eastmoney · as of 2026-10-16\", \"data\": [[\"2026-10-15\", open, high, low, close, volume], ...], \"ma\": [5, 20]} (volume optional; \"up\": \"red\" or \"green\" overrides which color is a rise, otherwise red-up for Chinese, green-up for other languages). aio-market history --chart prints this block ready to use.\n- Line, bar or area: {\"type\": \"line\", \"title\": \"...\", \"unit\": \"%\", \"x\": [\"10-14\", \"10-15\"], \"series\": [{\"name\": \"Moutai\", \"data\": [0.87, 2.1]}]}; a series can say \"type\": \"bar\" or \"line\" and \"axis\": \"right\" (with \"unitRight\") to mix, e.g. revenue bars with a growth line; \"stack\": true stacks bars.\n- Pie (at most 12 slices): {\"type\": \"pie\", \"title\": \"...\", \"data\": [{\"name\": \"A\", \"value\": 45}]}.\nGive a short title, and a note with the source and as-of time; write numbers as plain JSON numbers (no units or thousands separators inside data). Up to 2,000 points; for a long history 60–250 bars read best. Put the chart next to the sentence it supports, and still state the key numbers in the text.",
            "[Asking the user]",
            "First look things up yourself with the known context, memory and the tools you need; if a reasonable default exists, just go ahead and state the assumption in half a sentence. Then pick one of three:\n1. The task is done and you only offer optional follow-ups: ask at the end of the answer, followed immediately by a choices code block\n```choices\n[\"Option one\", \"Option two\"]\n```\nGive 2–5 options, each a complete phrase that can serve directly as the reply (at most 30 characters), and no \"Other\" (the user can always type their own).\n2. The task is done and an optional follow-up needs the user to fill in several items at once (date, number of people, place, preferences, etc.): use a form code block\n```form\n{\"title\": \"Form title\", \"fields\": [{\"name\": \"date\", \"label\": \"Date\", \"type\": \"date\", \"required\": true}, {\"name\": \"people\", \"label\": \"People\", \"type\": \"number\", \"min\": 1, \"default\": 2}, {\"name\": \"area\", \"label\": \"Area\", \"type\": \"select\", \"options\": [\"Option one\", \"Option two\"]}], \"submit\": \"Submit\"}\n```\ntype may be text, textarea, number, date, time, select, radio (single choice) or checkbox (multiple choice); select, radio and checkbox carry 2–10 options; at most 8 fields, each label at most 30 characters. Do not use a form to ask just one thing.\n3. Information only the user has, with no reasonable default, is missing and you really cannot continue: first summarize what is done, then end the reply with a separate ask_user code block\n```ask_user\n{\"question\": \"One specific question for the user to answer\", \"options\": [\"Option one\", \"Option two\"]}\n```\nOmit options when none fit. When the user needs to supply several items at once, use fields instead (the same format as the form fields above, optionally with submit), with question as one sentence of explanation; the main session shows it as a form. The system marks the task as waiting for the user, and the user's reply resumes this execution session. Do not perform operations that depend on the answer before you have it; do not end with only a plain question, and do not claim the task is complete.\nWhatever the user taps or submits resumes this task as a reply. When you can already complete the task, give the result directly without ask_user.",
        ];
    }
    private executorRulesVersion(): string {
        return createHash("sha256").update(this.executorRules("<task ID>").join("\n\n")).digest("hex").slice(0, 8);
    }
    /** The voice gadget's executor prompt: spoken, brief and plain; the account's other tasks are looked up on demand. */
    private gadgetPrompt(row: TaskRow): string {
        return [
            `You are Clawpage Agent's voice gadget session. Task ID: ${row.id}. The user is speaking to the voice gadget on their desk (a small screen and a speaker): this sentence was transcribed by speech recognition and may contain homophone errors, so take the most plausible meaning; your answer is shown on the small screen and read aloud. Identity and tone follow the SOUL.md injected at the system level. Do not delegate recursively.`,
            "This is an ongoing gadget session that keeps the earlier gadget conversation; when the user says \"just now\" or \"that one\", look for what they mean here first. The user's other tasks in the main session are not here: when asked about something earlier, a task's progress or result, or what was done recently, find it with aio_task_kb's history_search (a few keywords), then read the full content with history_get, instead of answering from impression; skip the lookup when it is not needed.",
            "Answer in plain spoken text: no Markdown, bullets, tables, code blocks, links or emoji, and none of the cards or code blocks such as cards, products, map, choices, form or ask_user. By default one to three sentences, within about 100 Chinese characters or 60 English words, conclusion first; expand only when the user asks for detail, and even then stay within about 300 Chinese characters or 180 English words. Write numbers, times and units so they read aloud naturally.",
            `Do not ask follow-up questions: when information is missing, go with the most reasonable default and state the assumption in half a sentence. Use tools as usual when you need to look things up, use the browser or work with files, without describing the process in the answer; files you need to write go in ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/.`,
            `It is now ${describeNow(row.created_at, this.cfg.browser.timezone)}. This time the user says: ${this.taskContext(row)}`,
            answerLanguage(this.locale(), true),
        ].join("\n\n");
    }
    private dispatch() {
        const rows = this.rowsWithStatus("waiting", ...DISPATCHED);
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
                this.db.prepare("UPDATE tasks SET status='blocked',error=? WHERE id=?").run(t().tasks.errors.dependencyFailed, row.id);
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
            const gist = (text: string | null | undefined, n: number, id: string) => text && text.length > n ? `${text.slice(0, n)}… (truncated; read the full content of ${id} with aio_task_kb's history_get)` : text ?? null;
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
            const continuation = continued ? (ask ? `This message continues task ${continued.id} (created ${clock(continued.created_at)}); that task last asked the user: "${ask}", and the user's reply this time answers that question.` : `This message continues the work of task ${continued.id} (created ${clock(continued.created_at)}).`) : null;
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
            // A few notes from the personal knowledge base that match this message, likewise once per version.
            const knowledge = gadget || !this.cfg.taskKb || !kbEnabled(this.db) ? null : this.knowledgeBrief(this.ownerId(row), [row.input_text, ...this.mergedRows(row.id).map(m => m.input_text)].join("\n"));
            const knowledgeKnown = !!knowledge && earlier.some(t => t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).knowledgeVersion === knowledge.version : false);
            // A session picked up again after a while: what it holds is where things stood then, not now.
            const lastAt = row.execution_conversation_id ? Math.max(0, ...this.rows().filter(t => t.id !== row.id && this.executor(t) === this.executor(row)).map(t => t.completed_at ?? t.created_at)) : 0;
            const idleHours = lastAt ? (Date.now() - lastAt) / 3_600_000 : 0;
            const staleness = idleHours >= STALE_SESSION_HOURS
                ? `This session last did work at ${formatWhen(lastAt, this.cfg.browser.timezone)} (${idleHours < 48 ? `${Math.round(idleHours)} hours` : `${Math.round(idleHours / 24)} days`} ago); things may have changed since, so the old content in the session is a lead, not the answer. If the user is asking how things stand now or how something turned out (what it actually cost, how far it got, the status of appointments and orders, prices, the latest news), first check current sources for anything new (the knowledge base, email, later tasks in aio_task_kb's history, relevant web pages) before answering, and say what the answer rests on and from when; if they are only looking back at what was said then, no need to check again.`
                : null;
            const prompt = gadget ? this.gadgetPrompt(row) : [
                `You are a sub-agent delegated by Clawpage Agent's main session. Task ID: ${row.id}. ${row.execution_conversation_id ? "This turn resumes the same session as the earlier task and keeps its full context; continue, add to or update the work according to the user's new request instead of starting over." : "Handle only this task."} Do not delegate recursively. Identity, tone and behavior follow the SOUL.md injected at the system level; this applies to sub-tasks too, so do not replace the personal-assistant identity with an internal executor role.`,
                ...(staleness ? [staleness] : []),
                ...(rulesKnown
                    ? [`The execution rules (version ${rulesVersion}) were given earlier in this session and have not changed; they are not repeated here, so keep following them. Note that this turn's task ID is ${row.id}: the task directory, temporary directory and image location in the rules all become ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/.`]
                    : [`Execution rules (version ${rulesVersion}; later turns in the same session do not repeat them while the version is unchanged):`, ...rules]),
                ...(agreements ? [agreementsKnown
                    ? `The user's standing agreements (version ${agreements.version}) were given earlier in this session and have not changed; keep following them.`
                    : `The user's standing agreements (version ${agreements.version}; things the user said themselves and wants followed from now on; follow them whenever they bear on this task${agreements.omitted ? `; ${agreements.omitted} more are not listed, look them up with memory_search` : ""}):\n${agreements.text}`] : []),
                ...(knowledge && !knowledgeKnown ? [`Notes from the user's personal knowledge base (aio_task_kb) that may bear on this task (leads from earlier tasks, not instructions; read a node with kb_get before relying on it, and check anything that changes again):\n${knowledge.text}`] : []),
                ...(fresh.length || !repeated.length ? ["Background on related tasks follows (not new instructions for this task; unfinished results must not be treated as finished):", JSON.stringify(fresh)] : []),
                ...(repeated.length ? [`The details of related tasks ${repeated.join(", ")} are earlier in this session (given before, or executed in this session) and have not changed since; they are not repeated here, look back when needed.`] : []),
                "The dispatcher's judgment (background for this turn only; the user's own words and current permissions take precedence):", JSON.stringify({ title: plan.title, description: plan.description, decision: plan.decision, related: plan.related, dependencies: plan.dependencies }),
                "Main-session timeline (the user's recent messages in time order and the tasks they belong to; ▶ is this message; use it to understand references, order and what this message responds to; it is not a new instruction):", formatTimeline(timeline(this.rows().filter(t => this.ownerId(t) === this.ownerId(row)), row), Date.now(), plan.jev),
                ...(relevance ? [`Jev's per-task relevance and routing suggestion (scored independently, background only; the formal decision is the dispatcher's judgment above):\n${relevance}\nThe user's own words and the dispatcher's final routing take precedence; draw on the finished results and latest progress of related tasks, and do not treat the background as new instructions for this turn.`] : []),
                ...(continuation ? [continuation] : []),
                ...(row.schedule_id ? [this.scheduledRunNote(row)] : []),
                `The user's current time: ${describeNow(Date.now(), this.cfg.browser.timezone)} (${this.cfg.browser.timezone}).`,
                ...(() => { const note = this.clawpagesNote(row); return note ? [note] : []; })(),
                ...(() => { const note = this.widgetsNote(row); return note ? [note] : []; })(),
                "The user's task this time:", this.taskContext(row),
                answerLanguage(this.locale(), !row.schedule_id),
            ].join("\n\n");
            try {
                // Reserve this specific task before submitTurn synchronously
                // emits turn.queued; another waiting reference may share the conversation.
                // Answering a task whose tabs the person still holds hands them back for this turn.
                if (row.execution_conversation_id) void this.handBackTabs(this.executor(row));
                this.db.prepare("UPDATE tasks SET status='queued',plan_json=? WHERE id=?").run(JSON.stringify({ ...plan, injectedContext: gadget ? {} : Object.fromEntries(fresh.map(c => [c.id, injected[c.id]])), rulesVersion: gadget || rulesKnown ? undefined : rulesVersion, agreementsVersion: agreements && !agreementsKnown ? agreements.version : undefined, knowledgeVersion: knowledge && !knowledgeKnown ? knowledge.version : undefined }), row.id);
                const { turn } = this.agent.submitTurn({ conversationId: this.executor(row), clientMessageId: `task:${row.id}`, text: prompt, attachments: [...JSON.parse(row.attachments_json),...this.mergedRows(row.id).flatMap(t=>JSON.parse(t.attachments_json))], requiresBrowser: plan.resources.includes("browser"), frozenSettings: { model: row.model!, effort: row.effort } });
                this.db.prepare("UPDATE tasks SET turn_id=? WHERE id=?").run(turn.id, row.id);
                active.push(this.get(row.id)!);
            }
            catch (err) {
                this.db.prepare("UPDATE tasks SET status='failed',error=?,completed_at=? WHERE id=?").run(err instanceof Error ? err.message : t().tasks.errors.runFailed, Date.now(), row.id);
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
        if (status === "completed") { this.recordFeed(this.get(row.id)!); this.#onCompleted?.(row.id); }
        this.notifyChange(row.id, row.status);
    }

    // ------------------------------------------------------------- schedules

    private scheduleRow(id: string): ScheduleRow | null {
        return (this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as unknown as ScheduleRow | undefined) ?? null;
    }
    private planningSchedules(ownerId: string): PlanningSchedule[] {
        return (this.db.prepare("SELECT * FROM schedules WHERE owner_id=? AND status IN ('active','paused') ORDER BY created_at").all(ownerId) as unknown as ScheduleRow[])
            .map(s => ({ id: s.id, title: this.scheduleTitle(s), rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), status: s.status, instruction: s.instruction.slice(0, 400) }));
    }
    private scheduleLabel(s: ScheduleRow): { id: string; title: string; rule: string; builtin?: string } {
        return { id: s.id, title: this.scheduleTitle(s), rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), ...(s.builtin ? { builtin: s.builtin } : {}) };
    }
    /** A schedule's name as people read it: the built-in feed's (which nobody renames) is in their language. */
    private scheduleTitle(s: ScheduleRow): string {
        return s.builtin === DAILY_FEED ? t().tasks.schedules.feedTitle : s.title;
    }
    /** What each run does, as people read it: the feed's default instruction is in their language. */
    private scheduleInstruction(s: ScheduleRow): string {
        return s.builtin === DAILY_FEED && isDefaultFeedInstruction(s.instruction) ? t().tasks.schedules.feedInstruction : s.instruction;
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
            .run(randomId("sched"), ownerId, FEED_TITLE, FEED_INSTRUCTION, JSON.stringify(spec), tz, JSON.stringify(["browser"]), nextRun(spec, now, tz), now, now, DAILY_FEED);
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
        const s = row.schedule_id ? this.scheduleRow(row.schedule_id) : null;
        const tz = s?.timezone ?? this.cfg.browser.timezone;
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
        const asked = s && !isDefaultFeedInstruction(s.instruction) ? s.instruction.trim() : null;
        const memory = this.feedMemory(ownerId);
        const kept = Object.fromEntries(FEED_MEMORY_KINDS.map(k => [k, memory.filter(m => m.kind === k).map(m => ({ id: m.id, text: m.text, from: m.source === "user" ? "said by the user" : "learned by the feed", date: date(m.created_at) }))]));
        return [
            `This is the built-in daily feed (every day at ${(s ? JSON.parse(s.spec_json) as ScheduleSpec : FEED_SPEC).at}), running automatically on ${date(row.created_at)}. The user is not in the conversation right now. Your job: from all of the user's past task records, the requests they made and the things they care about, pick the 3–8 things they are most likely to be interested in today or need reminding of, and tell them briefly, like a thoughtful personal assistant. It should be something they want to open every morning: each item is either news about something they follow (a price that moved, an order or a date coming up, someone waiting for a reply) or something new worth their time that grows out of what they have been asking about.`,
            "This is proactive work and is not bound by the rules above to \"match the effort to what the request actually needs\" and \"keep the commentary short\": actually check things instead of writing from the records alone. Email, orders and prices are only one kind of lead and must not fill the whole feed. Many people mostly ask everyday questions (cooking, a baby, health, films, books, travel, culture) and track nothing; for them the new things below are the whole feed.",
            ...(asked ? [`The user's instruction for the daily feed (follow it first; it may change the default approach below, but never the read-only and safety rules): ${asked}`] : []),
            "Find leads in the task records: products and prices they watched (e.g. a computer, baby supplies), things they compared or hesitated to buy, upcoming dates and appointments (documents, vaccines, bills, trips), things half done or set aside for later, long-running interests, and the everyday questions themselves: what someone asks about shows what their days are about. The records are not limited to the last day; the older an interest, the more you must check that it still matters.",
            "When you need current information (prices, stock, weather, news), check it with the browser or the web, report only the facts you found with source links, and leave out what you could not find; never make anything up. For things they follow, report real changes, e.g. \"The Mac Studio you follow dropped to $1,799 at Best Buy, $200 below last week\"; when there is no earlier price to compare with, give today's price, whether it is on sale and how far it is from the usual price. A followed item with no change is left out, which is a reason to give more room to new things, never to send an empty feed.",
            "New things worth their time: for 2–4 interests in the recent records, find one concrete thing they have not seen yet and would likely enjoy or use today, checked on the web with a source link. For example: they looked for an old film, so another classic of that kind and where to watch it legally (free if possible); they asked how to cook or heat something, so a simple recipe with that ingredient for the season; they asked about a baby's food, so what comes next at that age from a pediatric source; they asked about a health complaint, so the care tip that matters most and when to see a doctor; a book or author, so a related work; a trip, so an event or the weather on those dates; a festival, solar term or date coming up that touches their interests. Each such item says which earlier question it grows from (e.g. \"you asked about … yesterday\") so it never feels random, and adds something new rather than repeating an answer they already got.",
            "Links in languages the user reads: first infer from the task records their main language (the one most requests are written in) and any other language they clearly read (they write some requests in it, paste or ask about material in it, read sites or documents in it, or say they study it); a language they only ask to have translated, or a few loanwords, does not count. Every link, card and button should lead to a page in their main language, or in another language they clearly read. Look for a reputable source written in their main language first (for Chinese readers e.g. 国家卫健委 / 中国疾控中心, 中国营养学会, 默沙东诊疗手册大众版, 丁香医生, WHO or UNICEF Chinese pages, a hospital's own Chinese articles; many official English sites also keep a translated page, so check for one). Only when the best source exists only in a language they do not read, still give it but say so next to the link (e.g. \"英文网页\") and put its key point in the item itself so they need not open it; never make a page they cannot read the main picture card or button. Items about local prices, shops or events may link to local sites in the local language.", // i18n-exempt: Chinese source names and the label asked of the model for Chinese feeds
            "Read-only look at the user's own pages: on sites where the user is already signed in in the sandbox browser, that appear in the task records, or that they asked you to check (e.g. Gmail or Outlook mail, X or Xiaohongshu feeds they follow, order pages on shopping sites, billing pages), you may open them to see whether anything needs a reminder today: email to act on or about to expire (bills, renewals, appointment confirmations, people waiting for a reply), order and delivery changes, important news from people or topics they follow. Strictly read-only: only open, scroll and read; never send, reply, comment, like, follow, buy, order, delete, archive or label anything, and change no settings. Do not open unread email or direct messages (that marks them read); judge by the titles and snippets in the list. Skip sites where the user is not signed in; do not sign in and do not ask the user for help. For private content such as email, write only the gist, never the full text. Close the tabs you opened when you are done.",
            "Avoid nagging: consult feedHistory (topics of the last few feeds; userTasksAfter are the user's new tasks afterwards; replies are what the user said in direct reply to that feed). A topic pushed 3 times in a row recently with no related new task from the user since means they no longer care; stop pushing it unless something major has changed. New interests shown in the user's recent tasks come first; anything said yesterday with no change is not repeated (this drops repeated items, never the whole feed). In the remembered memory, care is what to watch more closely, avoid is what not to push again, and note is the user's habits and preferences about the feed; follow all of them.",
            "Keep improving: when feedHistory shows a clear reaction to the feed (e.g. a reply saying it helped, asking for more or to stop, a task started right after an item, or a topic pushed several times that nobody responded to), record it with aio_schedule's feed_update (source set to \"feed\"): add care for what to watch more closely, avoid for what not to push again, note for preferences about the feed's form and timing, and remove outdated or contradicting old entries. Change at most 3 entries each time, record only what has clear evidence, do not duplicate existing entries, and record nothing when unsure.",
            "Format: the first line is the heading \"Picked for you today\" (in Simplified Chinese write exactly 今日为你留意), followed by one item per thing, each one or two sentences, with links or map cards when needed; use picture cards (with images) for specific price drops, places worth visiting or articles worth reading. It should read quickly on a phone. Only when the records offer no lead at all (no interest, question or date to grow anything from; an unchanged price or no new email does not count), reply with a single sentence saying there is nothing in particular to flag today (in Simplified Chinese: 今天没有需要特别提醒的事), and write <!--feed-empty--> on a line of its own at the end.", // i18n-exempt: the exact Chinese wording asked of the model for Chinese feeds
            "On the last line by itself write <!--feed-topics: [\"topic 1\", \"topic 2\"]-->, listing the topics covered this time (short phrases, e.g. \"Mac Studio price drop\", \"Roy's vaccine appointment\"); the system uses it to adjust later feeds and the user never sees this line. Do not ask a question and wait, and do not create schedules.",
            "Remembered memory:", JSON.stringify(kept),
            `The user's task records for the last ${FEED_TASK_DAYS} days (newest first; the newest ${FEED_TASK_DETAILED} carry request and result summaries, older ones only the date and title, with only the latest of identical titles):`, JSON.stringify(tasks),
            "Feed history feedHistory (newest first):", JSON.stringify(feedHistory),
        ].join("\n\n");
    }
    private feedMemory(ownerId: string): FeedMemoryRow[] {
        return this.db.prepare("SELECT * FROM feed_memory WHERE owner_id=? ORDER BY created_at").all(ownerId) as unknown as FeedMemoryRow[];
    }
    /**
     * The daily feed runs on the clock of the place the person last signed in from:
     * the same time of day, in that time zone. False when nothing changed.
     */
    followFeedTimezone(ownerId: string, tz: string): boolean {
        const s = this.db.prepare("SELECT * FROM schedules WHERE owner_id=? AND builtin=?").get(ownerId, DAILY_FEED) as unknown as ScheduleRow | undefined;
        if (!s || s.timezone === tz) return false;
        const now = Date.now();
        // A paused or finished feed keeps no next run; resuming it counts in its new zone.
        const next = s.status === "active" ? nextRun(JSON.parse(s.spec_json) as ScheduleSpec, now, tz) : s.next_run_at;
        this.db.prepare("UPDATE schedules SET timezone=?,next_run_at=?,updated_at=? WHERE id=?").run(tz, next, now, s.id);
        return true;
    }
    private feedSchedule(ownerId: string): ScheduleRow {
        const s = this.db.prepare("SELECT * FROM schedules WHERE owner_id=? AND builtin=?").get(ownerId, DAILY_FEED) as unknown as ScheduleRow | undefined;
        if (!s) throw new Error("This account has no daily feed");
        return s;
    }
    /** The daily feed as the person's tasks see and change it. */
    feedSettings(userId: string) {
        const s = this.feedSchedule(userId);
        const tz = this.cfg.browser.timezone;
        return {
            title: this.scheduleTitle(s), rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), status: s.status,
            nextRun: s.next_run_at && s.status === "active" ? formatWhen(s.next_run_at, s.timezone) : null,
            instruction: this.scheduleInstruction(s), customized: !isDefaultFeedInstruction(s.instruction),
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
            if (typeof args.instruction !== "string") throw new Error("instruction must be text");
            const text = args.instruction.trim();
            if ([...text].length > FEED_INSTRUCTION_MAX) throw new Error(`instruction is too long (at most ${FEED_INSTRUCTION_MAX} characters)`);
            instruction = text || FEED_INSTRUCTION;
            said.push(text ? "Updated the daily feed's instruction" : "Restored the daily feed's default instruction");
        }
        let timing: { spec: ScheduleSpec; next: number } | null = null;
        if (args.at !== undefined && args.at !== null) {
            const checked = validateSchedule({ kind: "daily", at: args.at }, now, s.timezone);
            if ("error" in checked) throw new Error(checked.error);
            timing = checked;
            said.push(`Feed time changed to ${describeSchedule(checked.spec)}`);
        }
        const existing = this.feedMemory(userId);
        const removeIds = new Set(Array.isArray(args.remove) ? args.remove.map(String) : []);
        for (const id of removeIds) if (!existing.some(m => m.id === id)) throw new Error(`No memory with id ${id}`);
        const adds: Array<{ kind: FeedMemoryKind; text: string }> = [];
        let kept = 0;
        for (const item of Array.isArray(args.add) ? args.add : []) {
            const { kind, text } = (item ?? {}) as { kind?: unknown; text?: unknown };
            if (!FEED_MEMORY_KINDS.includes(kind as FeedMemoryKind)) throw new Error("kind in add must be care, avoid or note");
            const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
            if (!t || [...t].length > FEED_MEMORY_TEXT_MAX) throw new Error(`text in add must not be empty and is at most ${FEED_MEMORY_TEXT_MAX} characters`);
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
            if (count > FEED_MEMORY_MAX) throw new Error(`"${FEED_MEMORY_LABEL[kind]}" holds at most ${FEED_MEMORY_MAX} entries; remove outdated ones first`);
        }
        if (!instruction && !timing && !adds.length && !removeIds.size) {
            if (kept) return "These are already remembered; nothing changed.";
            throw new Error("Nothing to change: give instruction, at, add or remove");
        }
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (instruction) this.db.prepare("UPDATE schedules SET instruction=?,updated_at=? WHERE id=?").run(instruction, now, s.id);
            if (timing) this.db.prepare("UPDATE schedules SET spec_json=?,next_run_at=CASE WHEN status='active' THEN ? ELSE next_run_at END,updated_at=? WHERE id=?").run(JSON.stringify(timing.spec), timing.next, now, s.id);
            for (const id of removeIds) this.db.prepare("DELETE FROM feed_memory WHERE id=? AND owner_id=?").run(id, userId);
            adds.forEach((a, i) => this.db.prepare("INSERT INTO feed_memory (id,owner_id,kind,text,source,created_at) VALUES (?,?,?,?,?,?)").run(randomId("feedmem"), userId, a.kind, a.text, source, now + i));
            this.db.exec("COMMIT");
        } catch (err) { this.db.exec("ROLLBACK"); throw err; }
        if (adds.length) said.push(`Remembered ${adds.length} (${adds.map(a => `${FEED_MEMORY_LABEL[a.kind]}: ${a.text}`).join("; ")})`);
        if (removeIds.size) said.push(`Removed ${removeIds.size} old`);
        if (kept) said.push(`${kept} already remembered`);
        if (timing) this.schedule();
        return said.join("; ") + ".";
    }
    /** Store one schedule for the account (the cap applies however it was asked for); its id, or why not. */
    private insertSchedule(ownerId: string, s: { title: string; instruction: string; spec: ScheduleSpec; nextRunAt: number; resources: string[]; sourceTaskId: string | null }): { id: string } | { refused: string } {
        const active = (this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE owner_id=? AND status='active' AND builtin IS NULL").get(ownerId) as { n: number }).n;
        if (active >= MAX_ACTIVE_SCHEDULES)
            return { refused: t().tasks.schedules.limitReached(active, MAX_ACTIVE_SCHEDULES) };
        const id = randomId("sched");
        const now = Date.now();
        this.db.prepare("INSERT INTO schedules (id,owner_id,title,instruction,spec_json,timezone,resources_json,status,next_run_at,source_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)")
            .run(id, ownerId, s.title, s.instruction, JSON.stringify(s.spec), this.cfg.browser.timezone, JSON.stringify(s.resources), s.nextRunAt, s.sourceTaskId, now, now);
        return { id };
    }
    /** What was set up, for the person. */
    private scheduleCreated(title: string, instruction: string, spec: ScheduleSpec, nextRunAt: number): string {
        const tz = this.cfg.browser.timezone;
        const words = t().tasks.schedules;
        return [words.created(title, describeSchedule(spec), tz, formatWhen(nextRunAt, tz)), words.eachRun(instruction), words.manageHint].join("\n\n");
    }
    /** Store the schedule a plan asked for; the sentence that tells the person what was set up. */
    private createSchedule(row: TaskRow, plan: TaskPlan, runningNow = false): string {
        const planned = plan.schedule!;
        const stored = this.insertSchedule(this.ownerId(row), { title: plan.title, instruction: planned.instruction, spec: planned.spec, nextRunAt: planned.nextRunAt, resources: plan.resources, sourceTaskId: row.id });
        if ("refused" in stored) return stored.refused;
        if (runningNow) return t().tasks.schedules.createdRunningNow(describeSchedule(planned.spec), formatWhen(planned.nextRunAt, this.cfg.browser.timezone));
        return this.scheduleCreated(plan.title, planned.instruction, planned.spec, planned.nextRunAt);
    }
    /**
     * An executor's schedule tool (scheduleTool.ts): set up a schedule for the account,
     * kept here and run as new tasks whatever conversation asked for it.
     */
    createScheduleFor(userId: string, input: { title?: unknown; instruction?: unknown; schedule?: unknown; needsBrowser?: unknown }): { ok: true; message: string; schedule: ReturnType<TaskService["viewSchedule"]> } | { ok: false; error: string } {
        const words = t().tasks.schedules;
        const title = typeof input.title === "string" ? [...input.title.trim()].slice(0, 40).join("") : "";
        const instruction = typeof input.instruction === "string" ? input.instruction.trim().slice(0, 2000) : "";
        if (!title) return { ok: false, error: words.emptyTitle };
        if (!instruction) return { ok: false, error: words.emptyInstruction };
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
    updateScheduleFor(userId: string, input: { id?: unknown; title?: unknown; instruction?: unknown; schedule?: unknown; needsBrowser?: unknown }): { ok: true; message: string; schedule: ReturnType<TaskService["viewSchedule"]> } | { ok: false; error: string; code?: "not_found" } {
        const words = t().tasks.schedules;
        const s = this.scheduleRow(String(input.id ?? ""));
        if (!s || s.owner_id !== userId) return { ok: false, error: words.notFound, code: "not_found" };
        if (s.builtin) return { ok: false, error: words.builtinFeed(this.scheduleTitle(s)) };
        let title = s.title, instruction = s.instruction, resources = s.resources_json;
        if (input.title !== undefined) {
            title = typeof input.title === "string" ? [...input.title.trim()].slice(0, 40).join("") : "";
            if (!title) return { ok: false, error: words.emptyTitle };
        }
        if (input.instruction !== undefined) {
            instruction = typeof input.instruction === "string" ? input.instruction.trim().slice(0, 2000) : "";
            if (!instruction) return { ok: false, error: words.emptyInstruction };
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
                if (active >= MAX_ACTIVE_SCHEDULES) return { ok: false, error: words.limitRestart(active, MAX_ACTIVE_SCHEDULES) };
                status = "active";
            }
        }
        this.db.prepare("UPDATE schedules SET title=?,instruction=?,spec_json=?,resources_json=?,status=?,next_run_at=?,run_count=?,updated_at=? WHERE id=?")
            .run(title, instruction, JSON.stringify(spec), resources, status, status === "done" ? null : next, runCount, now, s.id);
        const tz = s.timezone;
        const when = status === "paused" ? words.updatedPaused : status === "done" ? words.updatedDone : words.updatedNext(formatWhen(next!, tz));
        return { ok: true, message: [words.updated(title, describeSchedule(spec), tz, when), words.eachRun(instruction)].join("\n\n"), schedule: this.viewSchedule(this.scheduleRow(s.id)!) };
    }
    /** Pause, resume or cancel one of the owner's schedules; the sentence that says what happened. */
    private applyScheduleAction(ownerId: string, id: string, action: ScheduleActionName): string {
        const words = t().tasks.schedules;
        const s = this.scheduleRow(id);
        if (!s || s.owner_id !== ownerId) return words.missing;
        const now = Date.now();
        const title = this.scheduleTitle(s);
        if (action === "cancel" && s.builtin) {
            this.db.prepare("UPDATE schedules SET status='paused',updated_at=? WHERE id=?").run(now, id);
            return words.builtinClosed(title);
        }
        if (action === "cancel") {
            this.db.prepare("DELETE FROM schedules WHERE id=?").run(id);
            return words.cancelled(title);
        }
        if (action === "pause") {
            this.db.prepare("UPDATE schedules SET status='paused',updated_at=? WHERE id=?").run(now, id);
            return words.paused(title);
        }
        const next = nextRun(JSON.parse(s.spec_json) as ScheduleSpec, now, s.timezone);
        if (next === null) {
            this.db.prepare("UPDATE schedules SET status='done',next_run_at=NULL,updated_at=? WHERE id=?").run(now, id);
            return words.noNextRun(title);
        }
        this.db.prepare("UPDATE schedules SET status='active',next_run_at=?,updated_at=? WHERE id=?").run(next, now, id);
        return words.resumed(title, formatWhen(next, s.timezone));
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
            title: s.title, description: t().tasks.schedules.runDescription(describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec)),
            related: previous && s.builtin !== DAILY_FEED ? [previous.id] : [], dependencies: [], resources: JSON.parse(s.resources_json) as string[],
            appendTo: null, resume: null, clarification: null,
        };
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const conv = this.agent.createConversation({ ownerId: s.owner_id, title: t().tasks.conversations.scheduled(this.scheduleTitle(s)), model: frozen.model });
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
        const rule = s ? ` (${describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec)})` : "";
        const plan = JSON.parse(row.plan_json!) as TaskPlan;
        return `This is run ${n} of the scheduled task "${row.title}"${rule}, started automatically at ${formatWhen(row.created_at, s?.timezone ?? this.cfg.browser.timezone)}. The user is not in the conversation right now: finish the work and report the result directly, write anything that needs the user's decision or confirmation into the result, do not ask a question and wait, and do not create another schedule.${plan.related.length ? " The background includes the previous run's result, so you can say what changed since then." : ""}`;
    }
    private viewSchedule(s: ScheduleRow) {
        const last = s.last_task_id ? this.get(s.last_task_id) : null;
        return {
            id: s.id, title: this.scheduleTitle(s), instruction: this.scheduleInstruction(s), rule: describeSchedule(JSON.parse(s.spec_json) as ScheduleSpec), spec: JSON.parse(s.spec_json) as ScheduleSpec, needsBrowser: (JSON.parse(s.resources_json) as string[]).includes("browser"), status: s.status,
            timezone: s.timezone, nextRunAt: s.next_run_at, nextRunText: s.next_run_at ? formatWhen(s.next_run_at, s.timezone) : null,
            lastRunAt: s.last_run_at, lastTask: last ? { id: last.id, status: last.status } : null, runCount: s.run_count, createdAt: s.created_at,
            builtin: s.builtin,
            ...(s.builtin === DAILY_FEED ? { feed: { customized: !isDefaultFeedInstruction(s.instruction), memory: this.feedMemory(s.owner_id).map(m => ({ id: m.id, kind: m.kind, text: m.text, source: m.source })) } } : {}),
        };
    }
    /**
     * The account's past tasks for an executor searching them (aio_task_kb history_search):
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
            ...(chain.length > 1 ? { session: `task ${chain.indexOf(t) + 1} of ${chain.length} in the same execution session` } : {}),
            ...(t.client_message_id.startsWith(GADGET_PREFIX) ? { from: "voice gadget" } : t.schedule_id ? { from: "scheduled task" } : {}),
        };
    }
    /**
     * One of the account's tasks in full (aio_task_kb history_get), with the tasks of its
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
            ...(process ? { process: process.steps, ...(process.more ? { processOmitted: `${process.more} earlier steps not listed` } : {}) } : {}),
        };
    }
    listSchedules(userId: string) {
        return (this.db.prepare("SELECT * FROM schedules WHERE owner_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, next_run_at, created_at DESC").all(userId) as unknown as ScheduleRow[]).map(s => this.viewSchedule(s));
    }
    /** Pause, resume or cancel from the schedules page. */
    changeSchedule(id: string, userId: string, action: ScheduleActionName) {
        const s = this.scheduleRow(id);
        if (!s || s.owner_id !== userId) throw new ScheduleNotFoundError();
        const message = this.applyScheduleAction(userId, id, action);
        const after = this.scheduleRow(id);
        return { message, schedule: after ? this.viewSchedule(after) : null };
    }
    /** One extra run right now; the regular rhythm is unchanged. */
    runScheduleNow(id: string, userId: string) {
        const s = this.scheduleRow(id);
        if (!s || s.owner_id !== userId) throw new ScheduleNotFoundError();
        if (s.status === "done") throw new Error(t().tasks.schedules.ended);
        const taskId = this.fireSchedule(s, Date.now(), true);
        if (!taskId) throw new Error(t().tasks.schedules.stillRunning);
        this.schedule();
        return { task: this.view(this.get(taskId)!), schedule: this.viewSchedule(this.scheduleRow(id)!) };
    }
}
