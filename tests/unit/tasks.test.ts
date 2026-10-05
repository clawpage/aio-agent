import { DispatchTimeoutError } from "../../src/control/codex/dispatchTiming.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { TaskService } from "../../src/control/tasks/service.js";
import { executorQuestion } from "../../src/control/tasks/executorQuestion.js";
import { JsonRpcResponseError } from "../../src/control/codex/jsonrpc.js";
import { parsePlan, planningPrompt, resourcesConflict } from "../../src/control/tasks/planning.js";
import { Logger } from "../../src/common/logger.js";
import { writeAgentSettings } from "../../src/control/settings.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import { dispatchedTask } from "../../src/ui/src/dispatchText.js";
class PlanningCodex extends FakeCodex {
    plans: string[] = [];
    steers: {threadId:string;expectedTurnId:string;text:string;attachments?:{path:string;kind:"image"|"file";name?:string}[]}[] = [];
    steerHook: (()=>Promise<void>) | null = null;
    async steerTurn(p: {threadId:string;expectedTurnId:string;text:string;attachments?:{path:string;kind:"image"|"file";name?:string}[]}) { this.steers.push(p); await this.steerHook?.(); }
    plan: (p: string) => Promise<string | null> = async (p) => {
        const data = JSON.parse(p.split("\n").at(-1)!);
        return JSON.stringify({ title: data.message, related: [], dependencies: [], resources: [] });
    };
    planModels: (string | undefined)[] = [];
    async planTask(p: string, _soul?: string, model?: string, onTiming?: (timing: Record<string, string | number>) => void) { this.plans.push(p); this.planModels.push(model); onTiming?.({model:model ?? "fake-luna",effort:"high",connectionMs:2,threadStartMs:3,turnStartMs:4,firstTextMs:5,finishMs:6,classifierMs:20}); return this.plan(p); }
}
const tick = () => new Promise(r => setTimeout(r, 30));
const fakeJevAnswers = (questions: Record<string, {criteria:Record<string,string>}>, preferred: string) => {
    const ids=Object.keys(questions.route!.criteria);
    const pick=preferred==="NEW" ? "NEW" : ids.find(id=>id.endsWith(`:${preferred}`))!;
    return Object.fromEntries(Object.keys(questions).map(name=>{
        if(name==="route") return [name,{choice:pick,confidence:0.9,probabilities:Object.fromEntries(ids.map(id=>[id,id===pick?0.8:0.2/(ids.length-1)]))}];
        const taskId=name.slice("relevance:".length);
        const related=taskId===preferred?0.8:0.1;
        return [name,{choice:related>=0.5?"related":"unrelated",confidence:0.9,probabilities:{related,unrelated:1-related}}];
    }));
};
let db: Db, agent: AgentManager, codex: PlanningCodex, tasks: TaskService;
const submit = (text: string, relatedTaskId?: string) => tasks.submit({ text, clientMessageId: text, relatedTaskId }).task;
describe("executor question protocol", () => {
    it("accepts an explicit blocking question and keeps preceding progress", () => {
        expect(executorQuestion('已查记录。\n```ask_user\n{"question":"查哪个城市？","options":["圣何塞","旧金山"]}\n```'))
            .toEqual({question:"查哪个城市？",options:["圣何塞","旧金山"],result:"已查记录。"});
    });
    it("recognizes the legacy missing-city request but not an optional follow-up", () => {
        expect(executorQuestion("你想看哪个城市的天气？发城市名或邮编就行，我查今天的气温、降雨和出门穿什么。")?.question).toContain("哪个城市");
        expect(executorQuestion("圣何塞今天 22°C。还想看明天吗？")).toBeNull();
        expect(executorQuestion('```ask_user\n{"question":""}\n```')).toBeNull();
    });
});
beforeEach(async () => {
    db = openDb(":memory:");
    codex = new PlanningCodex();
    const cfg = testConfig("/tmp/aio-main-tasks", 1);
    agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false) });
    await agent.init();
    tasks = new TaskService(db, cfg, agent, codex);
    tasks.init();
});
afterEach(async () => { tasks.close(); for (const t of codex.startedTurns)
    codex.completeTurn(t.turnId); await tick(); agent.shutdown(); db.close(); });
describe("main inbox delegation", () => {
    it("exposes persisted execution start instead of admission time, including after completion", async () => {
        const job = submit("测试执行时间");
        expect(job.startedAt).toBeNull();
        await tick();
        const row = tasks.get(job.id)!;
        db.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(1000, job.id);
        db.prepare("UPDATE turns SET started_at=? WHERE id=?").run(10_000, row.turn_id);
        expect(tasks.view(tasks.get(job.id)!).startedAt).toBe(10_000);
        codex.completeTurn(codex.startedTurns[0]!.turnId);
        await tick();
        const finished = tasks.view(tasks.get(job.id)!);
        expect(finished.status).toBe("completed");
        expect(finished.startedAt).toBe(10_000);
        expect(finished.completedAt).toBeGreaterThan(10_000);
    });
    it("records the dispatcher's own failure reason on the task", async () => {
        codex.plan = async () => { throw new Error("任务分配失败：You've hit your usage limit."); };
        const job = submit("额度用完"); await tick();
        expect(tasks.get(job.id)).toMatchObject({ status: "planning_failed", error: "任务分配失败：You've hit your usage limit." });
    });
    it("fails planning at once when the dispatcher times out, instead of re-asking it as a format error", async () => {
        codex.plan = async () => { throw new DispatchTimeoutError(90); };
        const job = submit("慢"); await tick();
        expect(tasks.get(job.id)).toMatchObject({ status: "planning_failed" });
        expect(tasks.get(job.id)?.error).toContain("派单超时");
        expect(tasks.get(job.id)?.error).not.toContain("JSON");
        expect(codex.plans).toHaveLength(1);
    });
    it("freezes browser dependency from the dispatched resource plan", async () => {
        const chat=submit("hi"); await tick();
        const first=tasks.get(chat.id)!;
        expect(db.prepare("SELECT browser_required FROM turns WHERE id=?").get(first.turn_id)?.browser_required).toBe(0);
        const prompt = codex.startedTurns[0]!.text;
        expect(prompt).not.toContain("没有 browser 不操作");
        expect(prompt).toContain("按用户任务实际需要使用文件、浏览器和其他工具");
        expect(prompt).not.toContain("本次文件与共享环境资源范围");
        codex.plan=async()=>JSON.stringify({title:"网页",related:[],dependencies:[],resources:["browser"]});
        const web=submit("打开网页"); await tick();
        expect(db.prepare("SELECT browser_required FROM turns WHERE id=?").get(tasks.get(web.id)!.turn_id)?.browser_required).toBe(1);
    });
    it("starts execution even when an old dispatcher answer tries to ask first", async () => {
        codex.plan = async () => JSON.stringify({title:"航班查询",related:[],dependencies:[],resources:["browser"],
            clarification:"从哪里出发、去哪儿，哪天出行？",options:["巴黎到罗马"]});
        const parent=submit("查机票"); await tick();
        expect(tasks.get(parent.id)?.status).toBe("running");
        expect(tasks.list().tasks[0]).toMatchObject({clarification:null,options:null});
        expect(codex.startedTurns).toHaveLength(1);
        expect(codex.startedTurns[0]?.text).toContain("查机票");
        const { dispatchLog } = await import("../../src/control/tasks/recall.js");
        const [entry] = dispatchLog(db,"owner_1",parent.id);
        expect(entry?.steps.find(s=>s.kind==="timing")).toMatchObject({timing:{model:"fake-luna",effort:"high",firstTextMs:5,finishMs:6}});
        expect(entry?.steps.find(s=>s.kind==="plan")).toMatchObject({plan:{clarification:null}});
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"请告诉我出发地、目的地和日期？"});
        await tick();
        expect(tasks.get(parent.id)).toMatchObject({status:"needs_input",result:null});
        expect(tasks.view(tasks.get(parent.id)!).clarification).toBe("请告诉我出发地、目的地和日期？");
        const reply=submit("巴黎到罗马，10月12日",parent.id); await tick();
        expect(tasks.get(reply.id)?.execution_conversation_id).toBe(tasks.get(parent.id)?.conversation_id);
        expect(tasks.get(reply.id)?.merged_into).toBeNull();
        expect(tasks.get(parent.id)?.status).toBe("completed");
        expect(codex.startedTurns.at(-1)?.text).toContain("巴黎到罗马，10月12日");
    });
    it("routes an unreferenced reply to a completed executor question", async () => {
        let firstId="";
        codex.plan=async p=>{
            const data=JSON.parse(p.split("\n").at(-1)!);
            return JSON.stringify({title:"机票",related:firstId?[firstId]:[],dependencies:[],resources:[],
                resume:data.message==="罗马，11月12日"?firstId:null});
        };
        const first=submit("从巴黎查机票");firstId=first.id;await tick();
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"请告诉我目的地和日期？"});await tick();
        expect(tasks.get(first.id)?.status).toBe("needs_input");
        const answer=submit("罗马，11月12日");await tick();
        expect(tasks.get(answer.id)?.execution_conversation_id).toBe(tasks.get(first.id)?.conversation_id);
        expect(tasks.get(answer.id)?.merged_into).toBeNull();
        expect(tasks.get(first.id)?.status).toBe("completed");
        expect(tasks.get(first.id)?.result).toContain("已收到补充，结果请看后续任务");
        expect((JSON.parse(tasks.get(first.id)!.plan_json!) as {answeredBy?:string}).answeredBy).toBe(answer.id);
        expect(codex.startedTurns.at(-1)?.text).toContain("罗马，11月12日");
        expect(codex.startedTurns.at(-1)?.text).toContain("请告诉我目的地和日期？");
    });
    it("holds a structured executor question and resumes its thread after a selected answer", async () => {
        const first=submit("查天气");await tick();
        expect(codex.startedTurns[0]?.text).toContain("```ask_user");
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:'已查到天气源。\n```ask_user\n{"question":"查哪个城市？","options":["圣何塞","旧金山"]}\n```'});await tick();
        const pending=tasks.view(tasks.get(first.id)!);
        expect(pending).toMatchObject({status:"needs_input",result:null,clarification:"查哪个城市？",options:["圣何塞","旧金山"]});
        expect(tasks.list().tasks.some(t=>t.id===first.id && t.status==="needs_input")).toBe(true);
        const second=submit("圣何塞",first.id);await tick();
        expect(tasks.get(first.id)?.status).toBe("completed");
        expect(tasks.get(second.id)?.status).toBe("running");
        expect(tasks.get(second.id)?.merged_into).toBeNull();
        expect(codex.startedTurns.at(-1)?.threadId).toBe(codex.startedTurns[0]?.threadId);
        expect(codex.startedTurns.at(-1)?.text).toContain("该任务最后问用户：「查哪个城市？」");
        await codex.runTurn(codex.startedTurns.at(-1)!.turnId,{text:"圣何塞今天 22°C。"});await tick();
        expect(tasks.get(second.id)?.result).toBe("圣何塞今天 22°C。");
        expect(tasks.view(tasks.get(first.id)!).clarification).toBeNull();
    });
    it("can stop an executor task awaiting a user answer without interrupting its finished turn", async () => {
        const first=submit("查天气");await tick();
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:'```ask_user\n{"question":"查哪个城市？"}\n```'});await tick();
        await tasks.stop(first.id);
        expect(tasks.get(first.id)?.status).toBe("interrupted");
    });
    it("keeps simultaneous incomplete requests independent while executors decide whether to ask", async () => {
        codex.plan=async p=>{
            const data=JSON.parse(p.split("\n").at(-1)!);
            return JSON.stringify({title:data.message.slice(0,20),related:[],dependencies:[],resources:[],clarification:"请提供任务的目标？"});
        };
        const first=submit("第一个任务"),second=submit("第二个任务");await tick();
        expect(tasks.get(first.id)?.status).toBe("running");
        expect(tasks.get(second.id)?.status).toBe("running");
        expect(codex.startedTurns).toHaveLength(2);
        expect(codex.startedTurns[0]?.text).toContain("第一个任务");
        expect(codex.startedTurns[1]?.text).toContain("第二个任务");
    });
    it("accepts four messages immediately, runs three isolated child threads, reports out of order without cross-talk", async () => {
        const jobs = ["a", "b", "c", "d"].map(t => submit(t));
        expect(tasks.list().tasks).toHaveLength(4);
        await tick();
        await tick();
        expect(codex.startedTurns).toHaveLength(3);
        expect(new Set(codex.startedTurns.map(t => t.threadId)).size).toBe(3);
        expect(tasks.get(jobs[3]!.id)?.status).toBe("waiting");
        await codex.runTurn(codex.startedTurns[1]!.turnId, { text: "B only" });
        await tick();
        expect(codex.startedTurns).toHaveLength(4);
        expect(tasks.get(jobs[1]!.id)?.result).toBe("B only");
        expect(tasks.get(jobs[0]!.id)?.result).toBeNull();
        expect(agent.listConversations(true)).toHaveLength(0);
    });
    it("waits for related output, gives it to the successor, and does not block an unrelated task", async () => {
        const first = submit("create document");
        await tick();
        codex.plan=async p=>{const {message}=JSON.parse(p.split("\n").at(-1)!);return JSON.stringify({title:message,related:message==="revise document"?[first.id]:[],dependencies:message==="revise document"?[first.id]:[],resources:[]});};
        const next = submit("revise document");
        const independent = submit("calculate");
        await tick();
        expect(tasks.get(next.id)?.status).toBe("waiting");
        expect(tasks.get(independent.id)?.status).toBe("running");
        await codex.runTurn(codex.startedTurns[0]!.turnId, { text: "[result](/home/gem/workspace/tasks/demo/report.docx)" });
        await tick();
        expect(tasks.get(next.id)?.status).toBe("running");
        expect(codex.startedTurns.at(-1)!.text).toContain("report.docx");
    });
    it("lets scheduled runs take at most one of the recent slots the dispatcher sees",async()=>{
        const finish=async(text:string)=>{const t=submit(text);await tick();await codex.runTurn(codex.startedTurns.at(-1)!.turnId,{text:`${text} 完成`});await tick();return t;};
        const mine=[await finish("比较两款婴儿车"),await finish("查明天天气"),await finish("订周六餐厅")];
        const runs=[await finish("推送一"),await finish("推送二"),await finish("推送三")];
        for(const r of runs)db.prepare("UPDATE tasks SET schedule_id='sched_feed' WHERE id=?").run(r.id);
        submit("新的问题");await tick();
        const seen=JSON.parse(codex.plans.at(-1)!.split("\n").at(-1)!).previous.map((t:{id:string})=>t.id);
        for(const t of mine)expect(seen).toContain(t.id);
        // Only the newest run; the others no longer crowd out the person's own work.
        expect(seen).toContain(runs[2]!.id);
        expect(seen.filter((id:string)=>runs.some(r=>r.id===id))).toHaveLength(1);
    });
    it("a reference to a running task resumes its session after the running turn, whatever the model routes",async()=>{
        const first=submit("first"), other=submit("other");await tick();
        codex.plan=async()=>JSON.stringify({title:"correction",appendTo:other.id,related:["invented"],dependencies:["invented"],resources:[]});
        const extra=submit("correct the first",first.id);await tick();
        expect(tasks.get(extra.id)).toMatchObject({status:"waiting",merged_into:null});expect(codex.steers).toHaveLength(0);
        expect(JSON.parse(tasks.get(extra.id)!.plan_json!)).toMatchObject({resume:first.id,appendTo:null,decision:{kind:"resume",taskId:first.id},dependencies:[]});
        expect(tasks.view(tasks.get(extra.id)!).waitReason?.label).toBe("等待原任务");
        const context=JSON.parse(codex.plans.at(-1)!.split("\n").at(-1)!);expect(context.previous.map((t:{id:string})=>t.id)).toEqual([first.id]);
        expect(tasks.view(tasks.get(extra.id)!).relatedTaskTitle).toBe("first");
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"First done"});await tick();await tick();
        expect(tasks.get(extra.id)?.status).toBe("running");
        expect(codex.startedTurns.at(-1)!.threadId).toBe(codex.startedTurns[0]!.threadId);
        expect(tasks.get(first.id)).toMatchObject({status:"completed",title:"first",result:"First done"});
    });
    it("continues a finished reference without being hijacked by an unrelated running task",async()=>{
        const done=submit("done");await tick();await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"Selected original result"});await tick();
        const other=submit("other");await tick();
        codex.plan=async()=>JSON.stringify({title:"update",appendTo:other.id,related:[other.id],dependencies:[other.id],resources:[]});
        const update=submit("update the result",done.id);await tick();
        expect(tasks.get(update.id)?.merged_into).toBeNull();expect(tasks.get(update.id)?.status).toBe("running");expect(codex.steers).toHaveLength(0);
        expect(codex.startedTurns.at(-1)!.text).toContain("Selected original result");
        expect(JSON.parse(tasks.get(update.id)!.plan_json!).related).toEqual([done.id]);
        expect(codex.resumedThreads).toEqual([codex.startedTurns[0]!.threadId]);
        expect(codex.startedTurns.at(-1)!.threadId).toBe(codex.startedTurns[0]!.threadId);
        expect(tasks.view(tasks.get(update.id)!).conversationId).toBe(done.conversationId);
        expect(codex.startedThreads).toHaveLength(2); // original + unrelated, no new thread for resume
        await codex.runTurn(codex.startedTurns.at(-1)!.turnId,{text:"Updated result"});await tick();
        expect(tasks.get(done.id)?.result).toBe("Selected original result");expect(tasks.get(update.id)?.result).toBe("Updated result");
    });
    it("references to an old result queue behind its resumed turn, preserving the original report",async()=>{
        const original=submit('original');await tick();await codex.runTurn(codex.startedTurns[0]!.turnId,{text:'Original report'});await tick();
        const continuation=submit('continue',original.id);await tick();
        const supplement=submit('correct the continuation',original.id);await tick();
        expect(tasks.get(supplement.id)).toMatchObject({status:'waiting',merged_into:null,related_task_id:original.id});expect(codex.steers).toHaveLength(0);
        expect(codex.startedThreads).toHaveLength(1);expect(codex.startedTurns).toHaveLength(2);
        await codex.runTurn(codex.startedTurns[1]!.turnId,{text:'Continued'});await tick();await tick();
        expect(tasks.get(supplement.id)?.status).toBe('running');expect(codex.startedTurns).toHaveLength(3);
        expect(codex.startedTurns[2]!.threadId).toBe(codex.startedTurns[0]!.threadId);expect(codex.startedThreads).toHaveLength(1);
        expect(tasks.get(original.id)?.status).toBe('completed');expect(tasks.get(original.id)?.result).toBe('Original report');
        expect(tasks.get(continuation.id)?.result).toBe('Continued');
        await tasks.stop(supplement.id);await tick();expect(tasks.get(original.id)?.status).toBe('completed');
    });
    it("runs simultaneous manual references one after another on the same session",async()=>{
        const original=submit('original');await tick();await codex.runTurn(codex.startedTurns[0]!.turnId,{text:'Original'});await tick();
        const first=submit('followup one',original.id),second=submit('followup two',original.id);
        await tick();await tick();
        expect(tasks.get(first.id)?.status).toBe('running');expect(tasks.get(second.id)).toMatchObject({status:'waiting',merged_into:null});
        expect(codex.startedTurns).toHaveLength(2);expect(codex.startedThreads).toHaveLength(1);expect(tasks.get(first.id)?.turn_id).not.toBe(tasks.get(original.id)?.turn_id);
        await codex.runTurn(codex.startedTurns[1]!.turnId,{text:'One'});await tick();await tick();
        expect(tasks.get(second.id)?.status).toBe('running');expect(codex.startedTurns).toHaveLength(3);expect(codex.startedThreads).toHaveLength(1);
    });
    it("resumes the same thread for subsequent references and after TaskService reinitialization",async()=>{
        const original=submit('original');await tick();await codex.runTurn(codex.startedTurns[0]!.turnId,{text:'Original'});await tick();
        const second=submit('second',original.id);await tick();await codex.runTurn(codex.startedTurns[1]!.turnId,{text:'Second'});await tick();
        tasks.close();tasks=new TaskService(db,testConfig('/tmp/aio-main-tasks',1),agent,codex);tasks.init();
        const third=submit('third',second.id);await tick();
        expect(codex.resumedThreads).toEqual([codex.startedTurns[0]!.threadId,codex.startedTurns[0]!.threadId]);expect(codex.startedThreads).toHaveLength(1);
        expect(tasks.view(tasks.get(third.id)!).conversationId).toBe(original.conversationId);
        const plan=JSON.parse(tasks.get(third.id)!.plan_json!);
        expect(plan.ownedResources).toBeUndefined();
        expect(codex.startedTurns.at(-1)!.text).toContain("按用户任务实际需要使用文件、浏览器和其他工具");
        expect(tasks.get(second.id)?.result).toBe('Second');expect(tasks.get(original.id)?.result).toBe('Original');
    });
    it("turns an explicit reference into a followup if its task completes during planning",async()=>{
        const first=submit("first");await tick();let resolve!:(s:string)=>void;
        codex.plan=()=>new Promise(r=>resolve=r);const update=submit("new detail",first.id);await tick();
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"Fresh final result"});
        resolve(JSON.stringify({title:"detail",appendTo:null,related:[],dependencies:[],resources:[]}));await tick();await tick();
        expect(tasks.get(update.id)?.status).toBe("running");expect(tasks.get(update.id)?.merged_into).toBeNull();expect(codex.steers).toHaveLength(0);
        expect(codex.startedTurns.at(-1)!.text).toContain("Fresh final result");
    });
    it("waits for a referenced task to stop, then proceeds even when it was interrupted",async()=>{
        const first=submit("first");await tick();db.prepare("UPDATE tasks SET status='stopping' WHERE id=?").run(first.id);
        const update=submit("continue after stop",first.id);await tick();expect(tasks.get(update.id)?.status).toBe("waiting");
        expect(tasks.view(tasks.get(update.id)!).waitReason?.label).toBe("等待原任务停止");
        codex.completeTurn(codex.startedTurns[0]!.turnId,"interrupted");await tick();
        expect(tasks.get(update.id)?.status).toBe("running");
    });
    it("runs browser tasks in parallel, each on its own tabs, alongside file-only work", async () => {
        codex.plan = async (p) => JSON.stringify({ title: "task", related: [], dependencies: [], resources: p.includes('"message":"browser') ? ["browser"] : [] });
        const a = submit("browser one"), b = submit("browser two"), c = submit("new doc");
        await tick();
        expect(tasks.get(a.id)?.status).toBe("running");
        expect(tasks.get(b.id)?.status).toBe("running");
        expect(tasks.get(c.id)?.status).toBe("running");
        expect(codex.startedTurns).toHaveLength(3);
    });
    it("runs unrelated directory writes and new documents together, queues overlapping writes with a reason", async () => {
        const root="/home/gem/workspace";
        codex.plan=async p=>{const {message}=JSON.parse(p.split("\n").at(-1)!);return JSON.stringify({title:message,related:[],dependencies:[],resources:message==='document'?[]:[`write:${root}/projects/${message==='overlap'?'a/src':message}`]});};
        const a=submit("a");await tick();
        const overlap=submit("overlap"), b=submit("b"), doc=submit("document");await tick();await tick();
        expect(tasks.get(a.id)?.status).toBe("running");expect(tasks.get(b.id)?.status).toBe("running");expect(tasks.get(doc.id)?.status).toBe("running");
        const waiting=tasks.view(tasks.get(overlap.id)!);expect(waiting.status).toBe("waiting");expect(waiting.waitReason?.label).toBe("等待文件操作");expect(waiting.waitReason?.message).toContain("“a”");
        codex.completeTurn(codex.startedTurns[0]!.turnId);await tick();expect(tasks.get(overlap.id)?.status).toBe("running");expect(tasks.view(tasks.get(overlap.id)!).waitReason).toBeNull();
    });
    it("protects implicit task directories from path claims over them",async()=>{
        const doc=submit("document");await tick();
        codex.plan=async()=>JSON.stringify({title:"delete tasks",related:[],dependencies:[],resources:["write:/home/gem/workspace/tasks"]});
        const deletion=submit("delete task directories");await tick();expect(tasks.get(deletion.id)?.status).toBe("waiting");
        codex.completeTurn(codex.startedTurns[0]!.turnId);await tick();expect(tasks.get(doc.id)?.status).toBe("completed");expect(tasks.get(deletion.id)?.status).toBe("running");
    });
    it("runs a shared-environment task beside tasks that declared nothing; it waits only for declared scopes",async()=>{
        const plan=(title:string,...resources:string[])=>{codex.plan=async()=>JSON.stringify({title,related:[],dependencies:[],resources});};
        plan("research","browser");const research=submit("browse reviews");await tick();
        plan("install","workspace");const install=submit("global install");await tick();
        plan("chat");const chat=submit("quick question");await tick();
        for(const t of [research,install,chat]) expect(tasks.get(t.id)?.status).toBe("running");
        // Leave a free slot, so what follows waits for claims and not for a place.
        codex.completeTurn(codex.startedTurns[2]!.turnId);await tick();expect(tasks.get(chat.id)?.status).toBe("completed");
        plan("edit","write:/home/gem/workspace/projects/a");const edit=submit("edit project");await tick();
        plan("second install","workspace");const second=submit("another global install");await tick();
        for(const t of [edit,second]){const waiting=tasks.view(tasks.get(t.id)!);expect(waiting.status).toBe("waiting");expect(waiting.waitReason?.label).toBe("等待文件操作");expect(waiting.waitReason?.message).toContain("“install”");}
        codex.completeTurn(codex.startedTurns[1]!.turnId);await tick();
        expect(tasks.get(install.id)?.status).toBe("completed");expect(tasks.get(edit.id)?.status).toBe("running");
        const still=tasks.view(tasks.get(second.id)!);expect(still.status).toBe("waiting");expect(still.waitReason?.message).toContain("“edit”");
    });
    it("waits for a scoped resource upgrade without reserving it or blocking independent work",async()=>{
        codex.plan=async()=>JSON.stringify({title:"writer",related:[],dependencies:[],resources:["write:/home/gem/workspace/projects/a"]});
        submit("writer");await tick();
        codex.plan=async()=>JSON.stringify({title:"doc",related:[],dependencies:[],resources:[]});
        const doc=submit("doc");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:doc.id,related:[],dependencies:[],resources:["read:/home/gem/workspace/projects/a/report.md"]});
        const extra=submit("extra");await tick();expect(tasks.get(extra.id)?.status).toBe("merging");expect(codex.steers).toHaveLength(0);
        expect(tasks.view(tasks.get(extra.id)!).waitReason?.label).toBe("等待文件操作");
        codex.completeTurn(codex.startedTurns[0]!.turnId);await tick();expect(codex.steers).toHaveLength(1);expect(tasks.get(extra.id)?.status).toBe("merged");
    });
    it("stops only the selected child and accepts further work", async () => {
        const a = submit("a"), b = submit("b");
        await tick();
        await tasks.stop(a.id);
        expect(codex.interrupted).toHaveLength(1);
        expect(codex.interrupted[0]?.threadId).toBe(codex.startedTurns[0]?.threadId);
        expect(tasks.get(b.id)?.status).toBe("running");
        submit("c");
        await tick();
        expect(codex.startedTurns).toHaveLength(3);
    });
    it("cancels planning without ever starting its late plan", async () => {
        let resolve!: (s: string) => void;
        codex.plan = () => new Promise(r => { resolve = r; });
        const a = submit("a");
        await tick();
        await tasks.stop(a.id);
        resolve(JSON.stringify({ title: "a", related: [], dependencies: [], resources: [] }));
        await tick();
        expect(codex.startedTurns).toHaveLength(0);
        expect(tasks.get(a.id)?.status).toBe("interrupted");
    });
    it("deduplicates retries, rejects conflicting payloads, and freezes settings during planning", async () => {
        let resolve!: (s: string) => void;
        codex.plan = () => new Promise(r => { resolve = r; });
        writeAgentSettings(db, { model: "gpt-6-sol", effort: null });
        const a = submit("a");
        await tick();
        expect(tasks.submit({ text: "a", clientMessageId: "a" }).duplicate).toBe(true);
        expect(() => tasks.submit({ text: "different", clientMessageId: "a" })).toThrow();
        writeAgentSettings(db, { model: "other-model", effort: "high" });
        resolve(JSON.stringify({ title: "a", related: [], dependencies: [], resources: [] }));
        await tick();
        expect(codex.startedTurns[0]).toMatchObject({ model: "gpt-6-sol", effort: null });
        expect(tasks.get(a.id)?.revision).toBeGreaterThan(0);
    });
    it("surfaces invalid planning after one corrected retry, and supports a safe manual retry", async () => {
        codex.plan = async () => '{"related":[],"dependencies":[]}';
        const a = submit("a");
        await tick();
        expect(tasks.get(a.id)?.status).toBe("planning_failed");
        expect(tasks.get(a.id)?.error).toContain("缺少 title");
        expect(codex.plans).toHaveLength(2);
        expect(codex.plans[1]).toContain("你上一次的回答无法使用：缺少 title");
        expect(codex.startedTurns).toHaveLength(0);
        expect(db.prepare("SELECT failed, fail_reason, rounds FROM recall_events").get()).toMatchObject({ failed: 1, fail_reason: "缺少 title", rounds: 2 });
        codex.plan = async () => '{"title":"ok","related":[],"dependencies":[],"resources":[]}';
        tasks.retryPlanning(a.id);
        await tick();
        expect(codex.startedTurns).toHaveLength(1);
        expect(() => tasks.retryPlanning(a.id)).toThrow();
    });
    it("does not treat a failed dependency as a successful result", async () => {
        const a = submit("a");
        await tick();
        codex.plan=async()=>JSON.stringify({title:"dependent",related:[a.id],dependencies:[a.id],resources:[]});
        const b = submit("b");
        await tick();
        codex.completeTurn(codex.startedTurns[0]!.turnId, "failed");
        await tick();
        expect(tasks.get(b.id)?.status).toBe("blocked");
        expect(codex.startedTurns).toHaveLength(1);
        const repair=submit("repair with new information",b.id);
        await tick();
        expect(tasks.get(repair.id)?.status).toBe("running");
    });
    it("does not replay uncertain work after a restart and keeps the main report", async () => {
        const a = submit("a");
        await tick();
        tasks.close();
        agent.shutdown();
        const cfg = testConfig("/tmp/aio-main-tasks", 1);
        codex = new PlanningCodex();
        agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false) });
        await agent.init();
        tasks = new TaskService(db, cfg, agent, codex);
        tasks.init();
        await tick();
        expect(tasks.get(a.id)?.status).toBe("unknown");
        expect(tasks.list().tasks[0]?.error).toContain("未知");
        expect(codex.startedTurns).toHaveLength(0);
    });
    it("keeps executor commentary folded until an actual terminal result", async () => {
        const a = submit("a");
        await tick();
        const t = codex.startedTurns[0]!;
        codex.emitNotification("item/completed", { threadId: t.threadId, turnId: t.turnId, item: { id: "comment", type: "agentMessage", phase: "commentary", text: "working privately" } });
        expect(tasks.list().tasks[0]?.result).toBeNull();
        await codex.runTurn(t.turnId, { text: "final report" });
        await tick();
        expect(tasks.get(a.id)?.result).toBe("final report");
    });
    it("dispatches a message whose task the execution page can show on its own", async()=>{
        submit("规划带娃三天行程\n\n孩子 2 岁");await tick();
        const brief=codex.startedTurns[0]!.text;
        expect(dispatchedTask(brief)).toBe("规划带娃三天行程\n\n孩子 2 岁");
        expect(brief.length).toBeGreaterThan(400);
        expect(dispatchedTask("就是一句普通的话")).toBeNull();
        expect(dispatchedTask("你是 AIO Agent 主会话委派的子 agent。没有任务段")).toBeNull();
    });
    it("steers a travel supplement into the active executor without a second task or dependent wait", async()=>{
        const parent=submit("规划带娃三天行程");await tick();
        codex.plan=async()=>JSON.stringify({title:"补充住宿和餐厅",appendTo:parent.id,related:[parent.id],dependencies:[parent.id],resources:[]});
        const extra=submit("我住在902 links way，帮我也找好餐厅推荐");await tick();await tick();
        expect(codex.startedTurns).toHaveLength(1);
        expect(codex.steers).toHaveLength(1);
        expect(codex.steers[0]).toMatchObject({threadId:codex.startedTurns[0]!.threadId,expectedTurnId:codex.startedTurns[0]!.turnId});
        expect(codex.steers[0]!.text).toContain("902 links way");
        expect(tasks.get(extra.id)).toMatchObject({status:"merged",merged_into:parent.id});
        expect(tasks.view(tasks.get(parent.id)!)).toMatchObject({title:"补充住宿和餐厅",description:JSON.parse(tasks.get(extra.id)!.plan_json!).description});
        expect(tasks.list().tasks.find(t=>t.id===extra.id)?.conversationId).toBe(parent.conversationId);
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"包含住宿和餐厅的完整行程"});await tick();
        expect(tasks.get(parent.id)?.result).toContain("餐厅");
        expect(tasks.list().tasks.find(t=>t.id===extra.id)?.result).toBeNull();
    });
    it("folds supplements into a not-yet-dispatched task including attachments", async()=>{
        codex.plan=async()=>JSON.stringify({title:"shared",related:[],dependencies:[],resources:["write:/home/gem/workspace/projects/shared"]});
        submit("shared files busy");await tick();const parent=submit("plan trip");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:["write:/home/gem/workspace/projects/shared"]});
        const extra=tasks.submit({text:"with photo",attachments:[{path:"/home/gem/workspace/uploads/photo.png",kind:"image"}],clientMessageId:"photo"}).task;await tick();
        // Resource held by the first task: wait as a supplement, not a new executor.
        expect(tasks.get(extra.id)?.status).toBe("merging");
        await codex.runTurn(codex.startedTurns[0]!.turnId);await tick();await tick();
        expect(tasks.get(extra.id)?.status).toBe("merged");
        expect(tasks.get(parent.id)?.title).toBe("extra");
        expect(codex.startedTurns).toHaveLength(2);
        expect(codex.startedTurns[1]!.text).toContain("with photo");
        expect(codex.startedTurns[1]!.attachments).toHaveLength(1);
        expect(codex.steers).toHaveLength(0);
    });
    it("waits only for the running executor ID, then steers it without waiting for completion",async()=>{
        let release!:()=>void;codex.startTurnGate=new Promise(r=>release=r);
        const parent=submit("starting");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:[]});
        const extra=submit("additional requirement");await tick();expect(tasks.get(extra.id)?.status).toBe("merging");
        release();await tick();await tick();expect(tasks.get(extra.id)?.status).toBe("merged");expect(codex.steers).toHaveLength(1);
    });
    it("does not replay an ambiguously delivered supplement",async()=>{
        const parent=submit("a");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:[]});
        codex.steerHook=async()=>{throw new Error("transport timeout");};
        const extra=submit("b");await tick();expect(tasks.get(extra.id)?.status).toBe("merge_unknown");
        await codex.runTurn(codex.startedTurns[0]!.turnId);await tick();
        expect(codex.steers).toHaveLength(1);expect(codex.startedTurns).toHaveLength(1);
    });
    it("handles a task finishing during classification as a followup, without losing the message",async()=>{
        const parent=submit("a");await tick();let finish!:(s:string)=>void;
        codex.plan=()=>new Promise(r=>finish=r);const extra=submit("b");await tick();
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"original result"});
        finish(JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:[]}));await tick();await tick();
        expect(codex.steers).toHaveLength(0);expect(codex.startedTurns).toHaveLength(2);
        expect(codex.startedTurns[1]!.text).toContain("original result");expect(tasks.get(extra.id)?.status).toBe("running");
    });
    it("reconciles a restart during steering as unknown, never as delivered",async()=>{
        const parent=submit("a");await tick();const extra=submit("b");await tick();
        db.prepare("UPDATE tasks SET status='steering',merged_into=? WHERE id=?").run(parent.id,extra.id);
        tasks.close();tasks=new TaskService(db,testConfig("/tmp/aio-main-tasks",1),agent,codex);tasks.init();await tick();
        expect(tasks.get(extra.id)?.status).toBe("merge_unknown");expect(codex.steers).toHaveLength(0);
    });
    it("delivers multiple supplements once even while the first steer is in flight", async()=>{
        const parent=submit("a");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:[]});
        let release!:()=>void;codex.steerHook=()=>new Promise(r=>release=r);
        const first=submit("b");await tick();
        const second=submit("c");await tick();
        expect(submit("c").id).toBe(second.id);
        expect(codex.steers).toHaveLength(1);
        codex.steerHook=null;release();await tick();await tick();
        expect(codex.steers).toHaveLength(2);
        expect(tasks.get(first.id)?.status).toBe("merged");
        expect(tasks.get(second.id)?.status).toBe("merged");
        expect(codex.startedTurns).toHaveLength(1);
    });
    it("waits for additional shared resources before steering, while independent work continues",async()=>{
        codex.plan=async()=>JSON.stringify({title:"shared",related:[],dependencies:[],resources:["write:/home/gem/workspace/projects/shared"]});
        submit("shared files task");await tick();
        codex.plan=async()=>JSON.stringify({title:"document",related:[],dependencies:[],resources:[]});
        const parent=submit("document task");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:["write:/home/gem/workspace/projects/shared"]});
        const extra=submit("add shared file edits");await tick();
        expect(tasks.get(extra.id)?.status).toBe("merging");expect(codex.steers).toHaveLength(0);
        await codex.runTurn(codex.startedTurns[0]!.turnId);await tick();await tick();
        expect(codex.steers).toHaveLength(1);expect(tasks.get(extra.id)?.status).toBe("merged");
        expect(JSON.parse(tasks.get(parent.id)!.plan_json!).resources).toEqual(["write:/home/gem/workspace/projects/shared"]);
    });
    it("does not steer a supplement before a separate prerequisite result is available",async()=>{
        const parent=submit("a"), prerequisite=submit("b");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[prerequisite.id],dependencies:[prerequisite.id],resources:[]});
        const extra=submit("include separate result");await tick();
        expect(codex.steers).toHaveLength(0);expect(tasks.get(extra.id)?.status).toBe("merging");
        await codex.runTurn(codex.startedTurns[1]!.turnId,{text:"verified source"});await tick();
        expect(codex.steers).toHaveLength(1);expect(codex.steers[0]!.text).toContain("verified source");
    });
    it("uses a followup only after definite RPC rejection when the parent has just finished",async()=>{
        const parent=submit("a");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:[]});
        codex.steerHook=async()=>{await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"finished original"});throw new JsonRpcResponseError("turn/steer",-32600,"no active turn");};
        const extra=submit("b");await tick();await tick();
        expect(codex.steers).toHaveLength(1);expect(codex.startedTurns).toHaveLength(2);
        expect(tasks.get(extra.id)?.merged_into).toBeNull();
        expect(codex.startedTurns[1]!.text).toContain("finished original");
    });
    it("an accepted supplement replaces the card's title and overview, and keeps them across a reload",async()=>{
        const description="我会根据退房时间梳理返程路线，安排途中休息和用餐，整理成一份可照着走的行程。";
        codex.plan=async()=>JSON.stringify({title:"返程安排",description,related:[],dependencies:[],resources:[]});
        const parent=submit("十点退房后返程");await tick();
        expect(tasks.list().tasks.find(t=>t.id===parent.id)?.description).toBe(description);
        codex.plan=async()=>JSON.stringify({title:"补充",description:"新要求的说明",appendTo:parent.id,related:[],dependencies:[],resources:[]});
        submit("路上加一次午餐");await tick();
        expect(tasks.list().tasks.find(t=>t.id===parent.id)).toMatchObject({title:"补充",description:"新要求的说明"});
        tasks.close();tasks=new TaskService(db,testConfig("/tmp/aio-main-tasks",1),agent,codex);tasks.init();await tick();
        expect(tasks.list().tasks.find(t=>t.id===parent.id)).toMatchObject({title:"补充",description:"新要求的说明"});
        expect(codex.plans).toHaveLength(2);
    });
    it("keeps old pending tasks in the live page while paginating every completed task", () => {
        tasks.close();
        const jobs = Array.from({ length: 120 }, (_, i) => submit(`history-${i}`));
        db.prepare("UPDATE tasks SET status='completed',completed_at=created_at+1").run();
        db.prepare("UPDATE tasks SET status='running',completed_at=NULL WHERE id=?").run(jobs[0]!.id);
        const latest = tasks.list();
        expect(latest.tasks).toHaveLength(101);
        expect(latest.tasks.some(t => t.id === jobs[0]!.id)).toBe(true);
        const older = tasks.list(latest.nextBefore!);
        expect(older.nextBefore).toBeNull();
        expect(new Set([...latest.tasks, ...older.tasks].map(t => t.id)).size).toBe(120);
        db.prepare("UPDATE tasks SET status='completed',completed_at=? WHERE id=?").run(Date.now()+1000,jobs[0]!.id);
        expect(tasks.list().tasks.find(t=>t.id===jobs[0]!.id)?.status).toBe("completed");
    });
});
it("ignores invalid legacy resource hints and serializes intersecting valid hints", () => {
    expect(parsePlan('{"title":"x","related":[],"dependencies":[],"resources":["unknown"]}', [], null)?.resources).toEqual([]);
    expect(parsePlan('{"title":"x","related":[],"dependencies":[]}', [], null)?.resources).toEqual([]);
    expect(resourcesConflict(["write:/home/gem/workspace/projects/shared"], ["write:/home/gem/workspace/projects/shared/src"])).toBe(true);
    expect(resourcesConflict(["browser"], ["browser"])).toBe(false);
    expect(resourcesConflict(["browser"], [])).toBe(false);
});

it("converts a stale steering target to resume rather than sending to a finished turn",()=>{
    const plan={title:"extra",appendTo:"a",related:[],dependencies:[],resources:[]};
    expect(parsePlan(JSON.stringify(plan),[],null)).toMatchObject({appendTo:null,related:[]});
    const report={repairs:[] as string[]};
    expect(parsePlan(JSON.stringify(plan),[{id:"a",title:"a",input_text:"a",status:"completed",result:"done"}],null,undefined,report)).toMatchObject({appendTo:null,resume:"a",decision:{kind:"resume",taskId:"a"},related:["a"]});
    expect(report.repairs).toEqual(["steer 指向已结束的执行轮次，改为 resume"]);
});

it("uses Luna's formal decision and enforces the actual turn state",()=>{
    const previous=[
        {id:"live",title:"live",input_text:"work",status:"running",result:null},
        {id:"done",title:"done",input_text:"work",status:"completed",result:"result"},
    ];
    const plan=(decision:unknown,extra:Record<string,unknown>={})=>parsePlan(JSON.stringify({title:"继续处理",description:"接着做同一件事",decision,related:[],dependencies:[],resources:[],...extra}),previous,null)!;
    expect(plan({kind:"new",taskId:null},{appendTo:"live"})).toMatchObject({appendTo:null,resume:null,decision:{kind:"new",taskId:null}});
    expect(plan({kind:"steer",taskId:"done"})).toMatchObject({appendTo:null,resume:"done",decision:{kind:"resume",taskId:"done"}});
    expect(plan({kind:"resume",taskId:"live"})).toMatchObject({appendTo:"live",resume:null,decision:{kind:"steer",taskId:"live"}});
    expect(plan({kind:"resume",taskId:"missing"})).toMatchObject({appendTo:null,resume:null,decision:{kind:"new",taskId:null}});
});

it("lists the dispatcher's tasks newest first, so a bare follow-up lands on the adjacent conversation",()=>{
    // Badcase: "有实体的 sim 卡槽吗？" right after a Pixel search was tied to an older iKKO SIM task,
    // because a same-day date could not tell the dispatcher which task was adjacent.
    const at=(h:number,m:number)=>new Date(2026,8,30,h,m).getTime();
    const previous=[
        {id:"ikko",title:"核实 iKKO 的 eSIM 方案",input_text:"ikko",status:"completed",result:"ok",created_at:at(15,2),source:"recall"},
        {id:"pixel",title:"在 eBay 上找 Pixel 手机",input_text:"pixel",status:"completed",result:"ok",created_at:at(15,58),source:"recent"},
        {id:"root",title:"选好 root 的手机",input_text:"root",status:"completed",result:"ok",created_at:at(15,56),source:"recent"},
    ];
    const prompt=planningPrompt("有实体的 sim 卡槽吗？",previous,null);
    const listed=JSON.parse(prompt.split("\n").at(-1)!).previous as {id:string;order:number;time:string}[];
    expect(listed.map(t=>[t.id,t.order,t.time])).toEqual([["pixel",1,"15:58"],["root",2,"15:56"],["ikko",3,"15:02"]]);
    expect(prompt).toContain("相邻优先");
});

it("repairs what does not change what may run, and says why an answer is unusable",()=>{
    const previous=Array.from({length:20},(_,i)=>({id:`t${i}`,title:`任务${i}`,input_text:"x",status:"completed",result:"ok"}));
    const report={repairs:[] as string[]} as {repairs:string[];error?:string};
    // "What have I done?" can relate every task: keep twelve, dependencies first; drop invented ids.
    const plan=parsePlan('好的，计划如下：\n{"title":"汇总","related":'+JSON.stringify([...previous.map(t=>t.id),"invented"])+',"dependencies":["t19","ghost"],"resources":[],"clarification":"'+"问".repeat(230)+'"}\n以上。',previous,null,undefined,report)!;
    expect(plan.related).toHaveLength(12);
    expect(plan.related[0]).toBe("t19");
    expect(plan.dependencies).toEqual(["t19"]);
    expect([...plan.clarification!]).toHaveLength(200);
    expect(report.repairs).toEqual(["dependencies 去掉 1 个不在列表中的 id","clarification 超过 200 字，已截断","related 去掉 1 个不在列表中的 id","related 共 20 个，只保留 12 个"]);
    for(const [raw,error] of [["不是 JSON","回答不是 JSON"],['{"related":[],"dependencies":[],"resources":[]}',"缺少 title"],['{"title":"x","related":"t1","dependencies":[],"resources":[]}',"related、dependencies 必须是数组"]] as const){
        const r={repairs:[] as string[]} as {repairs:string[];error?:string};
        expect(parsePlan(raw,previous,null,undefined,r)).toBeNull();
        expect(r.error).toBe(error);
    }
});

it("bounds an overview to 100 Unicode characters and supports older planner payloads",()=>{
    const base={title:"计划",related:[],dependencies:[],resources:[]};
    const plan=parsePlan(JSON.stringify({...base,description:"路😀".repeat(80)}),[],null)!;
    expect([...plan.description!]).toHaveLength(100);
    expect(plan.description?.endsWith("…")).toBe(true);
    expect(parsePlan(JSON.stringify(base),[],null)?.description).toContain("计划");
    expect(parsePlan(JSON.stringify({...base,description:42}),[],null)?.description).toContain("计划");
});

it("keeps 2–5 short distinct answers with a question, and none without one",()=>{
    const base={title:"q",related:[],dependencies:[],resources:[]};
    const parse=(extra:Record<string,unknown>)=>{const report={repairs:[] as string[]};return {plan:parsePlan(JSON.stringify({...base,...extra}),[],null,undefined,report)!,report};};
    expect(parse({clarification:"哪个牌子？",options:[" 雅培 ","美赞臣","雅培"]}).plan.options).toEqual(["雅培","美赞臣"]);
    expect(parse({clarification:null,options:["雅培","美赞臣"]}).plan.options).toBeUndefined();
    const many=parse({clarification:"选哪个？",options:["一","二","三","四","五","六"]});
    expect(many.plan.options).toEqual(["一","二","三","四","五"]);
    expect(many.report.repairs).toContain("options 超过 5 个，只保留前 5 个");
    const thin=parse({clarification:"选哪个？",options:["只有一个","问".repeat(31)]});
    expect(thin.plan.options).toBeUndefined();
    expect(thin.report.repairs).toContain("options 不足 2 个有效选项，已忽略");
    expect(parse({clarification:"选哪个？",options:"雅培"}).report.repairs).toContain("options 不是列表，已忽略");
});

it("validates optional clarification and resumes the finished turn that asked a question",()=>{
    const base={title:"query",related:[],dependencies:[],resources:[]};
    expect(parsePlan(JSON.stringify({...base,clarification:42}),[],null)?.clarification).toBeNull();
    expect(parsePlan(JSON.stringify({...base,clarification:"问".repeat(201)}),[],null)?.clarification).toHaveLength(200);
    expect(parsePlan(JSON.stringify({...base,clarification:"  "}),[],null)?.clarification).toBeNull();
    const previous=[{id:"q",title:"flight",input_text:"query",status:"needs_input",result:null}];
    // A task waits for input only after its turn ended with a question: the answer resumes that turn's thread.
    expect(parsePlan(JSON.stringify({...base,appendTo:"q",clarification:"ignored"}),previous,null)).toMatchObject({appendTo:null,resume:"q",clarification:null});
});
describe("main-session order, Jev's second opinion and resuming a finished session", () => {
    const planWith = (extra: (message: string) => Record<string, unknown>) => async (p: string) => {
        const data = JSON.parse(p.split("\n").at(-1)!);
        return JSON.stringify({ title: data.message.slice(0, 20), related: [], dependencies: [], resources: [], ...extra(data.message) });
    };
    it("lets Luna overrule Jev and passes both outputs to a steered executor", async () => {
        const jev={enabled:true,decide:async (_state:unknown,questions:Record<string,{criteria:Record<string,string>}>)=>({answers:fakeJevAnswers(questions,"NEW"),usage:null,latencyMs:2})};
        tasks.close();tasks=new TaskService(db,testConfig("/tmp/aio-main-tasks",1),agent,codex,undefined,jev as never);tasks.init();
        const first=submit("规划东京行程");await tick();
        codex.plan=async p=>{
            const data=JSON.parse(p.split("\n").at(-1)!);
            expect(data.jevJudgment).toMatchObject({suggestion:{kind:"new",taskId:null,probability:0.8}});
            return JSON.stringify({title:"调整东京行程",description:"把酒店改到新宿附近",decision:{kind:"steer",taskId:first.id},related:[first.id],dependencies:[],resources:[]});
        };
        const change=submit("酒店改在新宿");await tick();
        expect(tasks.get(change.id)?.status).toBe("merged");
        expect(codex.steers[0]?.text).toContain("Jev 建议：新任务");
        // Jev's reading reaches the executor once, readable, not as its raw answers.
        expect(codex.steers[0]?.text).not.toContain('"probabilities"');
        expect(codex.steers[0]?.text).toContain('"decision":{"kind":"steer"');
        expect(JSON.parse(tasks.get(change.id)!.plan_json!)).toMatchObject({decision:{kind:"steer",taskId:first.id},jev:{suggestion:{kind:"new"}}});
    });
    it("resumes the finished task a reply answers, in its own session, with the question and the timeline", async () => {
        const order = submit("帮我在 eBay 买那台 Pixel"); await tick();
        const first = codex.startedTurns[0]!;
        await codex.runTurn(first.turnId, { text: "找到了，$499，卖家评分 99%。需要你授权我用已保存的卡付款吗？" }); await tick();
        expect(tasks.get(order.id)!.status).toBe("completed");
        codex.plan = planWith(m => ({ resume: m === "已授权" ? order.id : null }));
        submit("讲个笑话"); await tick();
        const reply = submit("已授权"); await tick(); await tick();
        expect(tasks.get(reply.id)!.related_task_id).toBe(order.id);
        const turn = codex.startedTurns.find(t => t.text.endsWith("已授权"))!;
        // Same execution session as the order, not a fresh one with a summary.
        expect(turn.threadId).toBe(first.threadId);
        expect(turn.text).toContain(`本次消息接续任务 ${order.id}`);
        expect(turn.text).toContain("该任务最后问用户：「需要你授权我用已保存的卡付款吗？」");
        // The conversation in order: the order, the unrelated joke, then this reply.
        const lines = turn.text.split("\n").filter(l => /\[\d\d:\d\d\] 用户：/.test(l));
        expect(lines.map(l => l.match(/用户：「(.*?)」/)![1])).toEqual(["帮我在 eBay 买那台 Pixel", "讲个笑话", "已授权"]);
        expect(lines[0]).toContain("助理最后问：「需要你授权我用已保存的卡付款吗？」");
        expect(lines[2]).toMatch(/^▶ .*← 本次消息$/);
    });
    it("gives the dispatcher Jev's pick with the timeline, records it, and dispatches without it when Jev fails", async () => {
        const asked: Array<Record<string, any>> = [];
        let fail = false;
        const jev = {
            enabled: true,
            decide: async (state: Record<string, unknown>, questions: Record<string, { criteria: Record<string, string> }>) => {
                asked.push({ state, questions });
                if (fail) throw new Error("Jev 返回 HTTP 503");
                const pick = Object.keys(questions.route!.criteria)[0]!.split(":").at(-1)!;
                return { answers: fakeJevAnswers(questions,pick), usage: null, latencyMs: 7 };
            },
        };
        tasks.close();
        tasks = new TaskService(db, testConfig("/tmp/aio-main-tasks", 1), agent, codex, undefined, jev as never);
        tasks.init();
        const trip = submit("规划东京三天行程"); await tick();
        submit("酒店要靠近新宿"); await tick(); await tick();
        const q = asked.at(-1)!;
        expect(Object.keys(q.questions.route.criteria)).toEqual([`steer:${trip.id}`, "NEW"]);
        expect(q.questions.route.criteria[`steer:${trip.id}`]).toContain("规划东京三天行程");
        expect(Object.keys(q.questions[`relevance:${trip.id}`].criteria)).toEqual(["related","unrelated"]);
        expect(q.state.main_session_timeline).toContain("「规划东京三天行程」");
        const prompt = JSON.parse(codex.plans.at(-1)!.split("\n").at(-1)!);
        expect(prompt.jevJudgment).toMatchObject({ scores:{[trip.id]:0.8},suggestion:{kind:"steer",taskId:trip.id,probability:0.8} });
        expect(prompt.mainSessionTimeline).toMatch(/▶ .*「酒店要靠近新宿」/);
        const recorded = db.prepare("SELECT jev_json FROM recall_events ORDER BY id DESC LIMIT 1").get() as { jev_json: string };
        expect(JSON.parse(recorded.jev_json)).toMatchObject({ choice: trip.id, confident: true, latencyMs: 7 });
        fail = true;
        const next = submit("再加一天镰仓"); await tick(); await tick();
        expect(["running", "merged", "waiting", "queued", "merging"]).toContain(tasks.get(next.id)!.status);
        expect(JSON.parse(codex.plans.at(-1)!.split("\n").at(-1)!).jevJudgment).toBeUndefined();
        const failed = db.prepare("SELECT jev_json FROM recall_events ORDER BY id DESC LIMIT 1").get() as { jev_json: string };
        expect(JSON.parse(failed.jev_json)).toEqual({ error: "Jev 返回 HTTP 503" });
    });
    it("passes Jev's reading on to the executor, next to the timeline, and nothing when Jev fails", async () => {
        let fail = false;
        const jev = {
            enabled: true,
            decide: async (_state: unknown, questions: Record<string, { criteria: Record<string, string> }>) => {
                if (fail) throw new Error("Jev 返回 HTTP 503");
                const pick = Object.keys(questions.route!.criteria).find(id => id !== "NEW")!.split(":").at(-1)!;
                return { answers: fakeJevAnswers(questions,pick), usage: null, latencyMs: 3 };
            },
        };
        tasks.close();
        tasks = new TaskService(db, testConfig("/tmp/aio-main-tasks", 1), agent, codex, undefined, jev as never);
        tasks.init();
        const order = submit("帮我在 eBay 买那台 Pixel"); await tick();
        await codex.runTurn(codex.startedTurns[0]!.turnId, { text: "找到了，$499。需要你授权我用已保存的卡付款吗？" }); await tick();
        codex.plan = planWith(m => ({ resume: m === "已授权" ? order.id : null }));
        const reply = submit("已授权"); await tick(); await tick();
        expect(JSON.parse(tasks.get(reply.id)!.plan_json!).jev).toMatchObject({ choice: order.id, confident: true, scores:{[order.id]:0.8},suggestion:{kind:"resume",taskId:order.id,probability:0.8} });
        const turn = codex.startedTurns.find(t => t.text.endsWith("已授权"))!;
        const line = turn.text.split("\n").find(l => l.includes("用户：「帮我在 eBay 买那台 Pixel」"))!;
        expect(line).toContain("〔Jev：相关性 80%〕");
        expect(turn.text).toContain("Jev 的逐任务相关性与路由建议");
        expect(turn.text).toContain('Luna 的派单判断');
        expect(turn.text).not.toContain('"probabilities"');
        expect(turn.text).toContain(`- 任务 ${order.id}「帮我在 eBay 买那台 Pixel」（completed，`);
        expect(turn.text).toMatch(/：80%，Jev 首选（高置信）；助理最后问：「需要你授权我用已保存的卡付款吗？」/);
        expect(turn.text).toContain(`Jev 建议：续接任务 ${order.id}（80%`);
        await codex.runTurn(turn.turnId, { text: "已付款。" }); await tick();
        fail = true;
        submit("讲个笑话"); await tick(); await tick();
        const joke = codex.startedTurns.find(t => t.text.endsWith("讲个笑话"))!;
        expect(joke.text).not.toContain("Jev");
    });
    it("repairs resume: an active target becomes an append, an unknown one is dropped, and it never doubles an append", () => {
        const previous = [
            { id: "t_done", title: "a", input_text: "a", status: "completed", result: "要授权吗？" },
            { id: "t_run", title: "b", input_text: "b", status: "running", result: null },
            { id: "t_blocked", title: "c", input_text: "c", status: "blocked", result: null },
        ];
        const plan = (extra: Record<string, unknown>) => { const report = { repairs: [] as string[] }; return { plan: parsePlan(JSON.stringify({ title: "x", related: [], dependencies: [], resources: [], clarification: "还要问吗？", ...extra }), previous, null, "/home/gem/workspace", report), report }; };
        expect(plan({ resume: "t_done" }).plan).toMatchObject({ resume: "t_done", appendTo: null, clarification: null, related: ["t_done"] });
        expect(plan({ resume: "t_run" }).plan).toMatchObject({ resume: null, appendTo: "t_run" });
        expect(plan({ resume: "t_missing" }).plan).toMatchObject({ resume: null });
        expect(plan({ resume: "t_blocked" }).plan).toMatchObject({ resume: null, related: ["t_blocked"] });
        const both = plan({ resume: "t_done", appendTo: "t_run" });
        expect(both.plan).toMatchObject({ resume: null, appendTo: "t_run" });
        expect(both.report.repairs.join()).toContain("同时给出");
    });
});
describe("owner dispatch log", () => {
    it("records each dispatch step by step and reads it back with titles", async () => {
        const jev = { enabled: true, decide: async (_s: unknown, questions: Record<string, { criteria: Record<string, string> }>) => {
            const pick=Object.keys(questions.route!.criteria)[0]!.split(":").at(-1)!;
            return { answers:fakeJevAnswers(questions,pick), usage:null, latencyMs:4 };
        } };
        tasks.close();
        tasks = new TaskService(db, testConfig("/tmp/aio-main-tasks", 1), agent, codex, undefined, jev as never);
        tasks.init();
        const trip = submit("规划东京三天行程"); await tick();
        codex.plan = async p => {
            const data = JSON.parse(p.split("\n").at(-1)!);
            return JSON.stringify({ title: data.message, description:"调整酒店到新宿附近",decision:{kind:"steer",taskId:trip.id}, related: [trip.id], dependencies: [], resources: [] });
        };
        const hotel = submit("酒店要靠近新宿"); await tick(); await tick();
        const { dispatchLog } = await import("../../src/control/tasks/recall.js");
        const [entry] = dispatchLog(db, "owner_1", hotel.id);
        expect(entry!.steps.map(s => s.kind)).toEqual(["context", "jev", "timing", "ask", "plan"]);
        const [context, decided, timing, answer, plan] = entry!.steps as any[];
        expect(context.timeline).toMatch(/▶ .*「酒店要靠近新宿」/);
        expect(decided.result).toMatchObject({ choice: trip.id, confident: true, latencyMs: 4, scores:{[trip.id]:0.8},suggestion:{kind:"steer",taskId:trip.id} });
        expect(timing.timing).toMatchObject({ model: "fake-luna", effort: "high", connectionMs: 2 });
        expect(answer).toMatchObject({ round: 1 });
        expect(answer.prompt).toContain("Luna 派单器");
        expect(answer.answer).toContain("酒店要靠近新宿");
        expect(plan.plan).toMatchObject({ decision:{kind:"steer",taskId:trip.id},related: [trip.id] });
        // Titles are read back as they are now: the accepted steer renamed the trip.
        expect(entry!.candidates.find(c => c.id === trip.id)?.title).toBe("酒店要靠近新宿");
        // A dispatch that cannot produce a plan logs why.
        codex.plan = async () => "这不是 JSON";
        const broken = submit("坏掉的派单"); await tick(); await tick();
        const [failed] = dispatchLog(db, "owner_1", broken.id);
        expect(failed!.failed).toBe(true);
        expect(failed!.steps.map(s => s.kind)).toEqual(["context", "jev", "timing", "ask", "timing", "ask", "failed"]);
        expect((failed!.steps[5] as any).correction).toBe("回答不是 JSON");
    });
});
