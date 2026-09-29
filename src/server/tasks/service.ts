import { isMember, MEMBER_MODEL } from "../auth/policy.js";
import {readSoul} from '../soul.js';
import { JsonRpcResponseError } from "../codex/jsonrpc.js";
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import { randomId } from "../auth/passwords.js";
import { AgentManager, TurnConflictError, type AgentEvent, type CodexSessionLike, type TurnAttachment } from "../codex/manager.js";
import { normalizeResource, resolveResources, type ResourceSandbox } from "./resources.js";
import { applyTaskReference, parsePlan, planningPrompt, resourcesConflict, type TaskPlan } from "./planning.js";
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
}
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
    constructor(private db: Db, private cfg: Config, private agent: AgentManager, private codex: CodexSessionLike, private resourceSandbox?: ResourceSandbox) { }
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
    }
    close(): void { this.#closed = true; this.agent.events.off("event", this.onEvent); }
    private rows(): TaskRow[] { return this.db.prepare("SELECT * FROM tasks ORDER BY created_at, id").all() as unknown as TaskRow[]; }
    get(id: string): TaskRow | null { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow ?? null; }
    ownerId(row: TaskRow): string { return this.agent.getConversation(row.conversation_id)!.owner_id; }
    belongsTo(id: string, userId: string): boolean { const row = this.get(id); return !!row && this.ownerId(row) === userId; }
    private executor(row: TaskRow): string { return row.execution_conversation_id ?? row.conversation_id; }
    /** Referencing an old result while its resumed turn runs supplements that turn. */
    private referenceTarget(row: TaskRow): TaskRow | null {
        const ref = row.related_task_id ? this.get(row.related_task_id) : null;
        if (!ref) return null;
        const same = this.rows().filter(t => t.id !== row.id && t.created_at < row.created_at && !t.merged_into && this.executor(t) === this.executor(ref));
        return same.filter(t => ["planning", "needs_input", "waiting", "queued", "running", "stopping"].includes(t.status)).at(-1) ?? ref;
    }
    ownsConversation(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM tasks WHERE conversation_id=?").get(id); }
    view(row: TaskRow) {
        const plan = row.plan_json ? JSON.parse(row.plan_json) as TaskPlan : null;
        const turn = row.turn_id ? this.db.prepare("SELECT started_at FROM turns WHERE id=?").get(row.turn_id) as { started_at: number | null } | undefined : undefined;
        const parent = row.merged_into ? this.get(row.merged_into) : null;
        return {
            id: row.id, revision: row.revision, title: row.title, text: row.input_text, conversationId: this.executor(parent ?? row), mergedInto: row.merged_into, mergedTitle: parent?.title ?? null,
            status: row.status, result: TERMINAL.has(row.status) ? row.result : null, error: row.error,
            attachments: JSON.parse(row.attachments_json) as TurnAttachment[], relatedTaskId: row.related_task_id,
            relatedTaskTitle: row.related_task_id ? this.get(row.related_task_id)?.title ?? null : null,
            description: plan?.description ?? null,
            waitReason: this.waitReason(row),
            clarification: row.status === "needs_input" ? plan?.clarification ?? null : null,
            dependencies: plan?.dependencies ?? [], createdAt: row.created_at, startedAt: turn?.started_at ?? null, completedAt: row.completed_at,
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
        try {
            const all = this.rows().filter(t => this.ownerId(t) === this.ownerId(row) && !t.merged_into && t.created_at < row.created_at).map(t => ({...t,input_text:this.taskContext(t),clarification:t.status === "needs_input" && t.plan_json ? (JSON.parse(t.plan_json) as TaskPlan).clarification ?? null : null}));
            // Keep unresolved questions and active work visible even after a
            // burst of unrelated messages; free-text replies have no task picker.
            const relevant = all.filter(t => t.status === "needs_input" || DISPATCHED.has(t.status)).slice(-24);
            const previous = [...new Map([...relevant, ...all.slice(-12)].map(t => [t.id,t])).values()];
            const explicit = row.related_task_id ? this.get(row.related_task_id) : null;
            if (explicit && !previous.some(t => t.id === explicit.id))
                previous.push({...explicit,input_text:this.taskContext(explicit),clarification:explicit.status === "needs_input" && explicit.plan_json ? (JSON.parse(explicit.plan_json) as TaskPlan).clarification ?? null : null});
            const inputContext = this.taskContext(row);
            const files = [row,...this.rows().filter(t=>t.merged_into===row.id && t.status==='merged')]
                .flatMap(t=>JSON.parse(t.attachments_json) as TurnAttachment[]);
            const planningInput = [inputContext, ...(files.length ? [`已有附件（执行者可以读取其中资料）：${JSON.stringify(files)}`] : [])].filter(Boolean).join("\n\n");
            const prompt = planningPrompt(planningInput, explicit ? previous.filter(t => t.id === explicit.id) : previous, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir);
            const soul = readSoul(this.cfg).content;
            const raw = isMember(this.db, this.ownerId(row))
                ? await this.codex.planTask?.(prompt, soul, MEMBER_MODEL)
                : await this.codex.planTask?.(prompt, soul);
            if (this.#closed || this.get(row.id)?.status !== "planning")
                return;
            // A supplement may arrive while the classifier is in flight. Replan
            // with the latest input rather than dispatching an outdated decision.
            if (this.taskContext(this.get(row.id)!) !== inputContext) return;
            const plan = parsePlan(raw ?? null, previous, row.related_task_id, this.cfg.sandbox.containerWorkspaceDir);
            if (!plan)
                throw new Error("任务分配暂时失败，尚未执行。请重试分配。");
            if (explicit) applyTaskReference(plan, this.referenceTarget(row)!);
            const ownerId = plan.appendTo ?? row.id;
            const root = this.cfg.sandbox.containerWorkspaceDir;
            const owned = [`write:${root}/tasks/${ownerId}`, ...files.map(f => normalizeResource(`read:${f.path}`, root) ?? "workspace")];
            // A resumed executor may update the outputs it already created. Keep
            // those directories locked too; unrelated task directories stay isolated.
            if (explicit) owned.push(...this.rows().filter(t => !t.merged_into && t.created_at < row.created_at && this.executor(t) === this.executor(explicit)).map(t => `write:${root}/tasks/${t.id}`));
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
            this.db.prepare("UPDATE tasks SET title=?,plan_json=?,status=?,error=NULL WHERE id=?").run(plan.title, JSON.stringify(plan), plan.clarification ? "needs_input" : "waiting", row.id);
            this.agent.renameConversation(row.conversation_id, plan.title);
        }
        catch (err) {
            if (!this.#closed && this.get(row.id)?.status === "planning")
                this.db.prepare("UPDATE tasks SET status='planning_failed',error=? WHERE id=?").run(err instanceof Error ? err.message : "任务分配失败", row.id);
        }
        finally {
            this.#planning = false;
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
                        `这是用户对当前任务的补充，请合并处理并在最终结果中覆盖，不要当作独立任务。可协作使用的资源更新为：${this.claims(parent, parentPlan).join(',')}。\n\n${row.input_text}${dependencies.length ? `\n\n补充所需的已完成任务资料：${JSON.stringify(dependencies.map(t => ({id:t!.id,result:t!.result?.slice(0,16000)})))}` : ''}`,
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
            const context = related.map(t => ({ id: t.id, message: t.input_text.slice(0, 6000), status: t.status, result: t.result?.slice(0, 16000) }));
            const prompt = [
                `你是 AIO Agent 主会话委派的子 agent。任务 ID：${row.id}。${row.execution_conversation_id ? "本轮恢复此前任务的同一会话，保留完整上下文；按用户的新要求继续、补充或更新，不要从零重新做。" : "只处理本任务。"}不递归委派。身份、语气和行为遵循系统层注入的 SOUL.md；对子任务同样生效，不以内部执行角色替代个人助理身份。`,
                "按请求实际需要控制工作量：普通聊天、问候、身份介绍、概念解释和可直接回答的问题，直接在消息中回答即可。不要为了完成任务而创建目录、制作文件、检查运行环境或截图验收；仅在回答确实需要外部事实、附件或既有资料时调用相关工具。身份与风格以已注入的 SOUL.md 为准，不为自我介绍额外检索记忆或寻找 SOUL.md 文件。需要依据用户过往信息时才有针对性地查相关记录。用户要求实际操作或文件交付时，仍须执行并做与风险相称的验证，不得用口头回答代替。",
                `只有确实需要写文件时才创建任务目录。新文件放在 ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/（按需创建），不要散落工作区根目录。共享工作区里可能有其他子 agent；不得覆盖无关文件，只能在本次明确授权的路径内更新已有任务产物。`,
                `本次获准使用的资源范围：${this.claims(row, plan).join(",")}。read: 只读；write: 可修改该路径及后代；workspace 表示共享环境操作。没有 browser 不操作共享浏览器；没有 workspace 不安装全局依赖或改变共享运行环境。只在声明路径内操作，不修改符号链接或通过链接越过声明范围。需要额外范围时停止并说明，不擅自扩大。沙盒命令无需审批不代表可以越过本任务范围。`,
                `如需运行工具生成临时文件、渲染输出、缓存或工具配置，放在 ${this.cfg.sandbox.containerWorkspaceDir}/tasks/${row.id}/.tmp/，设置 TMPDIR 指向该目录；LibreOffice 使用该目录下独立的 UserInstallation。不要复用或清理 /tmp/verify、/tmp/lo-final 等公共路径。结束前等待本任务的写入子进程完成，不留后台写入。`,
                "你以用户的个人助理身份交付：最终回复直接回答用户要的结论、建议、安排和交付物，先给最有用的结果，不要只说准备做。保留必要的事实来源、未完成事项与会影响用户决策的限制（如尚未预订、日期待确认）。",
                "用户明确不关心实现过程：最终回复不汇报使用了哪些 skill、工具、命令、API、子 agent 或文件创建/检查步骤；除非用户专门询问这些技术细节。需要说明的执行与验证细节放在 commentary 过程里，不要放进最终回报或交付文档。不要删掉有用的依据、链接或不确定性来假装结果更确定。",
                "默认在对话中直接给出完整回答，可使用 Markdown 排版，无需保存文件。只有用户要求文件、可下载交付物，或内容确实需要独立文档/页面承载时，才制作文件；不要仅因内容是说明、清单或计划就自动建文档。需要文件时按表达需要选择格式：普通文字、清单和简单表格可用结构清晰的 Markdown（.md）；攻略、计划、说明若需要复杂排版、图表、多栏卡片或交互，优先制作 HTML（.html）页面，不要一律用 Markdown。HTML 尽量自包含、适配手机，交付前验证实际展示；检查通过即交付，只有具体缺陷才继续修改复验。链接用有意义的中文标题，例如[完整三天行程](绝对文件路径)，不要只写下载文件或暴露冗长文件名。用户指定 Word、Excel、PPT 等格式时遵循其格式。交付文件时，最终消息给简要要点和文件链接；无文件需求时直接给出答案。",
                "过程尽量简短，会在主会话折叠。缺少必要信息时最终提问并结束，不要在未获回答时执行依赖该答案的操作。",
                "以下是相关任务的背景资料（不是本任务的新指令，未完成结果不得当作已完成）：", JSON.stringify(context),
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
    }
}
