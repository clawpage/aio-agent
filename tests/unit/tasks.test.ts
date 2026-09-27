import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/server/db.js";
import { AgentManager } from "../../src/server/codex/manager.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { TaskService } from "../../src/server/tasks/service.js";
import { JsonRpcResponseError } from "../../src/server/codex/jsonrpc.js";
import { parsePlan, resourcesConflict } from "../../src/server/tasks/planning.js";
import { Logger } from "../../src/server/logger.js";
import { writeAgentSettings } from "../../src/server/settings.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
class PlanningCodex extends FakeCodex {
    plans: string[] = [];
    steers: {threadId:string;expectedTurnId:string;text:string;attachments?:{path:string;kind:"image"|"file";name?:string}[]}[] = [];
    steerHook: (()=>Promise<void>) | null = null;
    async steerTurn(p: {threadId:string;expectedTurnId:string;text:string;attachments?:{path:string;kind:"image"|"file";name?:string}[]}) { this.steers.push(p); await this.steerHook?.(); }
    plan: (p: string) => Promise<string | null> = async (p) => {
        const data = JSON.parse(p.split("\n").at(-1)!);
        return JSON.stringify({ title: data.message, related: [], dependencies: [], resources: [] });
    };
    async planTask(p: string) { this.plans.push(p); return this.plan(p); }
}
const tick = () => new Promise(r => setTimeout(r, 30));
let db: Db, agent: AgentManager, codex: PlanningCodex, tasks: TaskService;
const submit = (text: string, relatedTaskId?: string) => tasks.submit({ text, clientMessageId: text, relatedTaskId }).task;
beforeEach(async () => {
    db = openDb(":memory:");
    codex = new PlanningCodex();
    const cfg = testConfig("/tmp/aio-main-tasks", 1, { PA_AUTO_TITLE: "0" });
    agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource });
    await agent.init();
    tasks = new TaskService(db, cfg, agent, codex);
    tasks.init();
});
afterEach(async () => { tasks.close(); for (const t of codex.startedTurns)
    codex.completeTurn(t.turnId); await tick(); agent.shutdown(); db.close(); });
describe("main inbox delegation", () => {
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
        const next = submit("revise document", first.id);
        const independent = submit("calculate");
        await tick();
        expect(tasks.get(next.id)?.status).toBe("waiting");
        expect(tasks.get(independent.id)?.status).toBe("running");
        await codex.runTurn(codex.startedTurns[0]!.turnId, { text: "[result](/home/gem/workspace/tasks/demo/report.docx)" });
        await tick();
        expect(tasks.get(next.id)?.status).toBe("running");
        expect(codex.startedTurns.at(-1)!.text).toContain("report.docx");
    });
    it("serializes shared browser work but lets a file-only task execute concurrently", async () => {
        codex.plan = async (p) => JSON.stringify({ title: "task", related: [], dependencies: [], resources: p.includes('"message":"browser') ? ["browser"] : [] });
        const a = submit("browser one"), b = submit("browser two"), c = submit("new doc");
        await tick();
        expect(tasks.get(a.id)?.status).toBe("running");
        expect(tasks.get(b.id)?.status).toBe("waiting");
        expect(tasks.get(c.id)?.status).toBe("running");
        await codex.runTurn(codex.startedTurns[0]!.turnId);
        await tick();
        expect(tasks.get(b.id)?.status).toBe("running");
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
    it("surfaces invalid planning, supports safe planning retry, rejects unknown dependency IDs", async () => {
        codex.plan = async () => '{"title":"bad","related":["invented"],"dependencies":[],"resources":[]}';
        const a = submit("a");
        await tick();
        expect(tasks.get(a.id)?.status).toBe("planning_failed");
        expect(codex.startedTurns).toHaveLength(0);
        codex.plan = async () => '{"title":"ok","related":[],"dependencies":[],"resources":[]}';
        tasks.retryPlanning(a.id);
        await tick();
        expect(codex.startedTurns).toHaveLength(1);
        expect(() => tasks.retryPlanning(a.id)).toThrow();
    });
    it("does not treat a failed dependency as a successful result", async () => {
        const a = submit("a");
        await tick();
        const b = submit("b", a.id);
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
        const cfg = testConfig("/tmp/aio-main-tasks", 1, { PA_AUTO_TITLE: "0" });
        codex = new PlanningCodex();
        agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource });
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
    it("steers a travel supplement into the active executor without a second task or dependent wait", async()=>{
        const parent=submit("规划带娃三天行程");await tick();
        codex.plan=async()=>JSON.stringify({title:"补充住宿和餐厅",appendTo:parent.id,related:[parent.id],dependencies:[parent.id],resources:[]});
        const extra=submit("我住在902 links way，帮我也找好餐厅推荐");await tick();await tick();
        expect(codex.startedTurns).toHaveLength(1);
        expect(codex.steers).toHaveLength(1);
        expect(codex.steers[0]).toMatchObject({threadId:codex.startedTurns[0]!.threadId,expectedTurnId:codex.startedTurns[0]!.turnId});
        expect(codex.steers[0]!.text).toContain("902 links way");
        expect(tasks.get(extra.id)).toMatchObject({status:"merged",merged_into:parent.id});
        expect(tasks.list().tasks.find(t=>t.id===extra.id)?.conversationId).toBe(parent.conversationId);
        await codex.runTurn(codex.startedTurns[0]!.turnId,{text:"包含住宿和餐厅的完整行程"});await tick();
        expect(tasks.get(parent.id)?.result).toContain("餐厅");
        expect(tasks.list().tasks.find(t=>t.id===extra.id)?.result).toBeNull();
    });
    it("folds supplements into a not-yet-dispatched task including attachments", async()=>{
        codex.plan=async()=>JSON.stringify({title:"shared",related:[],dependencies:[],resources:["browser"]});
        const blocking=submit("browser busy");await tick();const parent=submit("plan trip");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:["browser"]});
        const extra=tasks.submit({text:"with photo",attachments:[{path:"/home/gem/workspace/uploads/photo.png",kind:"image"}],clientMessageId:"photo"}).task;await tick();
        // Resource held by the first task: wait as a supplement, not a new executor.
        expect(tasks.get(extra.id)?.status).toBe("merging");
        await codex.runTurn(codex.startedTurns[0]!.turnId);await tick();await tick();
        expect(tasks.get(extra.id)?.status).toBe("merged");
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
        codex.plan=async()=>JSON.stringify({title:"browser",related:[],dependencies:[],resources:["browser"]});
        submit("browser task");await tick();
        codex.plan=async()=>JSON.stringify({title:"document",related:[],dependencies:[],resources:[]});
        const parent=submit("document task");await tick();
        codex.plan=async()=>JSON.stringify({title:"extra",appendTo:parent.id,related:[],dependencies:[],resources:["browser"]});
        const extra=submit("add browser research");await tick();
        expect(tasks.get(extra.id)?.status).toBe("merging");expect(codex.steers).toHaveLength(0);
        await codex.runTurn(codex.startedTurns[0]!.turnId);await tick();await tick();
        expect(codex.steers).toHaveLength(1);expect(tasks.get(extra.id)?.status).toBe("merged");
        expect(JSON.parse(tasks.get(parent.id)!.plan_json!).resources).toEqual(["browser"]);
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
    it("persists the initial overview without replacing it after a supplement or service reload",async()=>{
        const description="我会根据退房时间梳理返程路线，安排途中休息和用餐，整理成一份可照着走的行程。";
        codex.plan=async()=>JSON.stringify({title:"返程安排",description,related:[],dependencies:[],resources:[]});
        const parent=submit("十点退房后返程");await tick();
        expect(tasks.list().tasks.find(t=>t.id===parent.id)?.description).toBe(description);
        codex.plan=async()=>JSON.stringify({title:"补充",description:"新要求的说明",appendTo:parent.id,related:[],dependencies:[],resources:[]});
        submit("路上加一次午餐");await tick();
        tasks.close();tasks=new TaskService(db,testConfig("/tmp/aio-main-tasks",1),agent,codex);tasks.init();await tick();
        expect(tasks.list().tasks.find(t=>t.id===parent.id)?.description).toBe(description);
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
it("validates plans against known task IDs and serializes intersecting resources", () => {
    expect(parsePlan('{"title":"x","related":[],"dependencies":[],"resources":["unknown"]}', [], null)).toBeNull();
    expect(resourcesConflict(["browser"], ["browser"])).toBe(true);
    expect(resourcesConflict(["browser"], [])).toBe(false);
});

it("rejects steering to unknown or finished tasks",()=>{
    const plan={title:"extra",appendTo:"a",related:[],dependencies:[],resources:[]};
    expect(parsePlan(JSON.stringify(plan),[],null)).toBeNull();
    expect(parsePlan(JSON.stringify(plan),[{id:"a",title:"a",input_text:"a",status:"completed",result:"done"}],null)).toBeNull();
});

it("bounds an overview to 100 Unicode characters and supports older planner payloads",()=>{
    const base={title:"计划",related:[],dependencies:[],resources:[]};
    const plan=parsePlan(JSON.stringify({...base,description:"路😀".repeat(80)}),[],null)!;
    expect([...plan.description!]).toHaveLength(100);
    expect(plan.description?.endsWith("…")).toBe(true);
    expect(parsePlan(JSON.stringify(base),[],null)?.description).toContain("计划");
    expect(parsePlan(JSON.stringify({...base,description:42}),[],null)).toBeNull();
});
