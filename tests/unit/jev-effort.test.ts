import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { TaskService } from "../../src/control/tasks/service.js";
import { Logger } from "../../src/common/logger.js";
import { writeAgentSettings } from "../../src/control/settings.js";
import { Jev, type JevAnswer } from "../../src/control/jev.js";
import { decideEffort, effortQuestion, EFFORT_QUESTION } from "../../src/control/tasks/effort.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import type { Config } from "../../src/control/config.js";

class PlanningCodex extends FakeCodex {
  async planTask(p: string) {
    const data = JSON.parse(p.split("\n").findLast((l) => l.startsWith("{"))!);
    return JSON.stringify({ title: data.message, decision: { kind: "new", taskId: null }, related: [], dependencies: [], resources: [] });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));
const answer = (probabilities: Record<string, number>): JevAnswer => {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { choice, confidence: 0.9, probabilities };
};
type Questions = Record<string, { criteria: Record<string, string>; instructions: Record<string, unknown> }>;
type Call = { state: Record<string, unknown>; questions: Questions; opts: { timeoutMs?: number; optional?: string[] } };
/** A fake Jev: routing answers "new task", the effort question answers as given (or throws). */
function fakeJev(effort: Record<string, number> | Error, calls: Call[]) {
  return {
    enabled: true,
    decide: async (state: Record<string, unknown>, questions: Questions, opts: Call["opts"] = {}) => {
      calls.push({ state, questions, opts });
      if (effort instanceof Error) throw effort;
      const answers: Record<string, JevAnswer> = {};
      for (const [name, q] of Object.entries(questions)) {
        const ids = Object.keys(q.criteria);
        if (name === EFFORT_QUESTION) answers[name] = answer(effort);
        else if (name === "route") answers[name] = answer(Object.fromEntries(ids.map((id) => [id, id === "NEW" ? 0.8 : 0.2 / (ids.length - 1)])));
        else answers[name] = answer({ related: 0.1, unrelated: 0.9 });
      }
      return { answers, usage: null, latencyMs: 3 };
    },
  };
}

let db: Db, agent: AgentManager, codex: PlanningCodex, tasks: TaskService, cfg: Config;
const submit = (text: string) => tasks.submit({ text, clientMessageId: text }).task;
const plan = (id: string) => JSON.parse(tasks.get(id)!.plan_json!);
const start = (jev: unknown) => {
  tasks.close();
  tasks = new TaskService(db, cfg, agent, codex, undefined, jev as never);
  tasks.init();
};

beforeEach(async () => {
  db = openDb(":memory:");
  codex = new PlanningCodex();
  cfg = testConfig("/tmp/aio-jev-effort", 1);
  agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false) });
  await agent.init();
  tasks = new TaskService(db, cfg, agent, codex);
  tasks.init();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  tasks.close();
  for (const t of codex.startedTurns) codex.completeTurn(t.turnId);
  await tick();
  agent.shutdown();
  db.close();
});

describe("auto effort decision", () => {
  const auto = { levels: ["low", "medium", "high"], fallback: "high" };
  it("uses Jev's level only when it is clearly sure, otherwise the fallback", () => {
    expect(decideEffort(auto, answer({ low: 0.1, medium: 0.15, high: 0.75 }))).toMatchObject({ effort: "high", source: "jev" });
    expect(decideEffort(auto, answer({ low: 0.7, medium: 0.2, high: 0.1 }))).toMatchObject({ effort: "low", source: "jev" });
    // Top below 0.6, or a margin under 0.15: unsure.
    expect(decideEffort(auto, answer({ low: 0.2, medium: 0.5, high: 0.3 }))).toMatchObject({ effort: "high", source: "fallback", answer: { choice: "medium" } });
    expect(decideEffort(auto, answer({ low: 0.05, medium: 0.47, high: 0.48 }))).toMatchObject({ effort: "high", source: "fallback" });
    // A level outside the account's levels is never used.
    expect(decideEffort(auto, { choice: "xhigh", confidence: 1, probabilities: { xhigh: 1 } })).toMatchObject({ effort: "high", source: "fallback" });
    expect(decideEffort(auto, null, "Jev HTTP 503")).toEqual({ effort: "high", source: "fallback", levels: auto.levels, error: "Jev HTTP 503" });
  });
  it("asks about the depth of the work, offering exactly the allowed levels", () => {
    const q = effortQuestion(["low", "medium", "high", "xhigh"]);
    expect(Object.keys(q.criteria)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(String(q.instructions.goal)).toMatch(/how hard and deep the work is/);
    expect(String(q.instructions.goal)).toMatch(/Do not judge by the length of the message/);
  });
});

describe("Jev decides the effort of tasks on Auto", () => {
  it("runs the first task at Jev's confident level, asking only the effort question", async () => {
    const calls: Call[] = [];
    start(fakeJev({ low: 0.05, medium: 0.15, high: 0.8 }, calls));
    const task = submit("调研三家托儿所的学费、师生比和评价，做成对比表");
    await tick(); await tick();
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual([EFFORT_QUESTION]);
    expect(calls[0]!.opts).toMatchObject({ timeoutMs: cfg.jev.dispatchTimeoutMs, optional: [EFFORT_QUESTION] });
    // The test catalog's model offers low/medium/high.
    expect(Object.keys(calls[0]!.questions[EFFORT_QUESTION]!.criteria)).toEqual(["low", "medium", "high"]);
    expect(tasks.get(task.id)!.effort).toBe("high");
    expect(codex.startedTurns[0]?.effort).toBe("high");
    expect(plan(task.id).effort).toMatchObject({ effort: "high", source: "jev", levels: ["low", "medium", "high"], answer: { choice: "high" } });
    const { dispatchLog } = await import("../../src/control/tasks/recall.js");
    expect(dispatchLog(db, "owner_1", task.id)[0]!.steps.find((s) => s.kind === "effort")).toMatchObject({ decision: { effort: "high", source: "jev" } });
  });

  it("keeps the configured effort (the model's default) when Jev is unsure or fails", async () => {
    const calls: Call[] = [];
    start(fakeJev({ low: 0.3, medium: 0.4, high: 0.3 }, calls));
    const unsure = submit("你好");
    await tick(); await tick();
    expect(codex.startedTurns[0]?.effort ?? null).toBeNull();
    expect(plan(unsure.id).effort).toMatchObject({ effort: null, source: "fallback", answer: { choice: "medium" } });

    start(fakeJev(new Error("Jev HTTP 503"), calls));
    const failed = submit("再查一下明天的天气");
    await tick(); await tick();
    expect(tasks.get(failed.id)!.status).not.toBe("planning_failed");
    expect(codex.startedTurns.at(-1)?.effort ?? null).toBeNull();
    expect(plan(failed.id).effort).toMatchObject({ effort: null, source: "fallback", error: "Jev HTTP 503" });
  });

  it("rides along with the routing question, in the same Jev request", async () => {
    const calls: Call[] = [];
    start(fakeJev({ low: 0.85, medium: 0.1, high: 0.05 }, calls));
    submit("规划东京三天行程");
    await tick(); await tick();
    const second = submit("东京现在几点");
    await tick(); await tick();
    const routed = calls.at(-1)!;
    expect(Object.keys(routed.questions)).toEqual(expect.arrayContaining(["route", EFFORT_QUESTION]));
    expect(routed.opts.optional).toEqual([EFFORT_QUESTION]);
    expect(calls).toHaveLength(2);
    expect(tasks.get(second.id)!.effort).toBe("low");
    expect(plan(second.id).effort).toMatchObject({ effort: "low", source: "jev" });
    // The dispatcher's Jev reading carries no effort answer.
    expect(plan(second.id).jev.answers[EFFORT_QUESTION]).toBeUndefined();
  });

  it("does not ask when the owner chose a fixed level", async () => {
    writeAgentSettings(db, { model: "gpt-6-sol", effort: "low" });
    const calls: Call[] = [];
    start(fakeJev({ low: 0.05, medium: 0.05, high: 0.9 }, calls));
    const task = submit("写一份详细的研究报告");
    await tick(); await tick();
    expect(calls).toHaveLength(0);
    expect(codex.startedTurns[0]?.effort).toBe("low");
    expect(plan(task.id).effort).toBeUndefined();
  });

  it("falls back within Jev's own timeout when Jev hangs", async () => {
    // The real client against an endpoint that never answers.
    process.env.TYPESAFE_API_KEY = "test-key";
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }));
    try {
      cfg = { ...cfg, jev: { ...cfg.jev, dispatchTimeoutMs: 1_000 } };
      start(new Jev(cfg, new Logger("error", undefined, false)));
      const began = Date.now();
      const task = submit("帮我比较两款婴儿车");
      await vi.waitFor(() => expect(codex.startedTurns).toHaveLength(1), { timeout: 4_000, interval: 50 });
      expect(Date.now() - began).toBeLessThan(2_500);
      expect(codex.startedTurns[0]?.effort ?? null).toBeNull();
      expect(plan(task.id).effort).toMatchObject({ effort: null, source: "fallback", error: expect.any(String) });
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });
});

describe("Jev optional questions", () => {
  it("leaves out an unusable optional answer instead of failing the request", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    const reply = { answers: { route: answer({ a: 0.9, b: 0.1 }), [EFFORT_QUESTION]: { choice: "huge", confidence: 1, probabilities: { huge: 1 } } } };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(reply), { status: 200 }));
    try {
      const jev = new Jev(cfg, new Logger("error", undefined, false));
      const questions = { route: { criteria: { a: "A", b: "B" }, instructions: {} }, [EFFORT_QUESTION]: effortQuestion(["low", "high"]) };
      const r = await jev.decide({}, questions, { optional: [EFFORT_QUESTION] });
      expect(Object.keys(r.answers)).toEqual(["route"]);
      await expect(jev.decide({}, questions)).rejects.toThrow();
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });
});
