import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/server/db.js";
import { AgentManager } from "../../src/server/codex/manager.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { TaskService } from "../../src/server/tasks/service.js";
import { parsePlan, resourcesConflict } from "../../src/server/tasks/planning.js";
import { Logger } from "../../src/server/logger.js";
import { writeAgentSettings } from "../../src/server/settings.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
class PlanningCodex extends FakeCodex {
    plans: string[] = [];
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
