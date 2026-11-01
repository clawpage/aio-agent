import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { openDb, type Db } from "../../src/control/db.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import { TaskService } from "../../src/control/tasks/service.js";
import type { Jev } from "../../src/control/jev.js";
import type { ResourceSandbox } from "../../src/control/tasks/resources.js";
import { checkCondition, MAX_CONDITION_OUTPUT, validateCondition } from "../../src/control/tasks/scheduleCondition.js";
import { Logger } from "../../src/common/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

/** Every model the service could reach: the dispatcher (planTask), executor turns and threads (titles run there too). */
class CountingCodex extends FakeCodex {
  plans: string[] = [];
  async planTask(p: string) {
    this.plans.push(p);
    return JSON.stringify({ title: "x", related: [], dependencies: [], resources: [] });
  }
}

/** A sandbox that answers condition checks the way the runner prints them, and records them. */
class FakeConditionSandbox implements ResourceSandbox {
  checks: string[][] = [];
  reply: { code: number; stdout: string } | Error = { code: 0, stdout: "\n__AIO_CONDITION_EXIT__=1\n" };
  #release: (() => void) | null = null;
  hold = false;
  async execInSandbox(argv: string[]) {
    if (argv[3] !== "aio-condition") return { code: 0, stdout: "[]" };
    this.checks.push(argv);
    if (this.hold) await new Promise<void>((r) => { this.#release = r; });
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
  release() { this.#release?.(); }
}
const exits = (code: number, output = "") => ({ code: 0, stdout: `${output}\n__AIO_CONDITION_EXIT__=${code}\n` });

const tick = () => new Promise((r) => setTimeout(r, 30));
let db: Db, agent: AgentManager, codex: CountingCodex, tasks: TaskService, sandbox: FakeConditionSandbox, jevCalls: string[], wakes: number;
const fire = () => (tasks as unknown as { runDueSchedules(): void }).runDueSchedules();
const row = (id: string) => db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as Record<string, unknown> & { next_run_at: number | null; run_count: number; last_task_id: string | null; last_check_json: string | null; status: string };
const due = (id: string) => db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(Date.now() - 1000, id);
const taskCount = () => (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
const priceCheck = { language: "python", code: "import sys\nprice = 399\nprint(f'price {price}')\nsys.exit(0 if price < 449 else 1)" };

function create(condition: unknown = priceCheck, extra: Record<string, unknown> = {}) {
  const made = tasks.createScheduleFor("owner_1", { title: "盯价格", instruction: "Tell the user the robot vacuum price dropped, with the link", schedule: { kind: "interval", everyMinutes: 15 }, needsBrowser: false, condition, ...extra });
  if (!made.ok) throw new Error(made.error);
  return made.schedule;
}

beforeEach(async () => {
  db = openDb(":memory:");
  codex = new CountingCodex();
  const cfg = testConfig("/tmp/aio-condition", 1);
  agent = new AgentManager({ db, cfg, codex, log: new Logger("error", undefined, false) });
  await agent.init();
  sandbox = new FakeConditionSandbox();
  jevCalls = [];
  const jev = new Proxy({}, { get: (_t, key) => key === "enabled" ? true : key === "then" ? undefined : (...args: unknown[]) => { jevCalls.push(String(key)); void args; return Promise.resolve(null); } }) as unknown as Jev;
  tasks = new TaskService(db, cfg, agent, codex, sandbox, jev);
  wakes = 0;
  tasks.setSandboxWake(async () => { wakes++; });
  tasks.init();
});
afterEach(async () => {
  tasks.close();
  for (const t of codex.startedTurns) codex.completeTurn(t.turnId);
  await tick();
  agent.shutdown();
  db.close();
});

describe("a schedule with a condition", () => {
  it("skips a due run whose condition is not met: no task, no dispatcher, no Jev, no executor; recorded as skipped", async () => {
    const s = create();
    const turns = codex.startedTurns.length, threads = codex.startedThreads.length, before = taskCount();
    sandbox.reply = exits(1, "price 499");
    due(s.id); fire(); await tick();
    expect(sandbox.checks).toHaveLength(1);
    expect(wakes).toBe(1);
    // The script runs as given, under the runner's timeout and output cap, in the workspace.
    expect(sandbox.checks[0]!.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(sandbox.checks[0]!.slice(4)).toEqual(["python", "60", String(MAX_CONDITION_OUTPUT), "/home/gem/workspace", priceCheck.code]);
    expect(taskCount()).toBe(before);
    expect(codex.plans).toHaveLength(0);
    expect(codex.startedTurns.length).toBe(turns);
    expect(codex.startedThreads.length).toBe(threads);
    expect(jevCalls).toEqual([]);
    const after = row(s.id);
    expect(after).toMatchObject({ run_count: 0, last_task_id: null, status: "active" });
    expect(after.next_run_at).toBeGreaterThan(Date.now());
    expect(JSON.parse(after.last_check_json!)).toMatchObject({ result: "skipped", output: "price 499" });
    expect(tasks.listSchedules("owner_1").find((x) => x.id === s.id)).toMatchObject({ condition: priceCheck, lastCheck: { result: "skipped" } });
    // The next beat does not check again before the next due time.
    fire(); await tick();
    expect(sandbox.checks).toHaveLength(1);
  });

  it("starts the run when the condition is met and gives the executor what the check printed", async () => {
    const s = create();
    sandbox.reply = exits(0, "price 399 (was 479)");
    due(s.id); fire(); await tick();
    const after = row(s.id);
    expect(after.run_count).toBe(1);
    expect(JSON.parse(after.last_check_json!)).toMatchObject({ result: "fired", output: "price 399 (was 479)" });
    expect(codex.plans).toHaveLength(0); // already planned: no dispatcher round
    const turn = codex.startedTurns.at(-1)!;
    expect(turn.text).toContain("This is run 1 of the scheduled task");
    expect(turn.text).toContain("condition check");
    expect(turn.text).toContain("price 399 (was 479)");
    expect(JSON.parse(tasks.get(after.last_task_id!)!.plan_json!).conditionOutput).toBe("price 399 (was 479)");
  });

  it("counts only fired runs toward maxRuns", async () => {
    const s = create(priceCheck, { schedule: { kind: "interval", everyMinutes: 15, maxRuns: 1 } });
    sandbox.reply = exits(1);
    due(s.id); fire(); await tick();
    expect(row(s.id)).toMatchObject({ status: "active", run_count: 0 });
    sandbox.reply = exits(0);
    due(s.id); fire(); await tick();
    expect(row(s.id)).toMatchObject({ status: "done", run_count: 1, next_run_at: null });
  });

  it.each([
    ["a timeout", exits(124, "partial"), { error: "timeout", output: "partial" }],
    ["another exit code", exits(2, "Traceback: boom"), { error: "exit", exitCode: 2 }],
    ["a sandbox that cannot run it", { code: 1, stdout: "" }, { error: "unavailable" }],
    ["a failed exec", new Error("node unreachable"), { error: "unavailable" }],
  ])("skips the run on %s and records the error", async (_name, reply, expected) => {
    const s = create();
    sandbox.reply = reply;
    due(s.id); fire(); await tick();
    expect(taskCount()).toBe(0);
    expect(codex.startedTurns).toHaveLength(0);
    expect(codex.plans).toHaveLength(0);
    expect(row(s.id)).toMatchObject({ run_count: 0, status: "active" });
    expect(JSON.parse(row(s.id).last_check_json!)).toMatchObject({ result: "error", ...expected });
  });

  it("skips the check when the sandbox cannot be woken", async () => {
    const s = create();
    tasks.setSandboxWake(async () => { throw new Error("start failed"); });
    due(s.id); fire(); await tick();
    expect(sandbox.checks).toHaveLength(0);
    expect(JSON.parse(row(s.id).last_check_json!)).toMatchObject({ result: "error", error: "unavailable" });
  });

  it("checks once at a time, and a check that ends after the schedule was paused or deleted starts nothing", async () => {
    const s = create();
    sandbox.hold = true; sandbox.reply = exits(0);
    due(s.id); fire(); await tick();
    due(s.id); fire(); await tick();
    expect(sandbox.checks).toHaveLength(1);
    tasks.changeSchedule(s.id, "owner_1", "pause");
    sandbox.release(); await tick();
    expect(taskCount()).toBe(0);
    expect(row(s.id)).toMatchObject({ status: "paused", run_count: 0, last_check_json: null });
  });

  it("does not check while the previous run is still going", async () => {
    const s = create();
    sandbox.reply = exits(0);
    due(s.id); fire(); await tick();
    expect(row(s.id).run_count).toBe(1);
    due(s.id); fire(); await tick();
    expect(sandbox.checks).toHaveLength(1);
  });

  it("runs on demand without checking", async () => {
    const s = create();
    const { task } = tasks.runScheduleNow(s.id, "owner_1");
    expect(task).toBeTruthy();
    expect(sandbox.checks).toHaveLength(0);
  });

  it("is set, changed and removed through the schedule tool's service calls", () => {
    expect(tasks.createScheduleFor("owner_1", { title: "x", instruction: "y", schedule: { kind: "daily", at: "09:00" }, condition: { language: "ruby", code: "true" } })).toMatchObject({ ok: false, error: expect.stringContaining("condition.language") });
    expect(tasks.createScheduleFor("owner_1", { title: "x", instruction: "y", schedule: { kind: "daily", at: "09:00" }, condition: { language: "bash", code: "  " } })).toMatchObject({ ok: false, error: expect.stringContaining("condition.code") });
    const made = tasks.createScheduleFor("owner_1", { title: "x", instruction: "y", schedule: { kind: "daily", at: "09:00" }, condition: { language: "bash", code: "test -f /tmp/flag" } });
    expect(made).toMatchObject({ ok: true, message: expect.stringContaining("only when the condition is met"), schedule: { condition: { language: "bash", code: "test -f /tmp/flag" }, lastCheck: null } });
    const id = (made as { schedule: { id: string } }).schedule.id;
    db.prepare("UPDATE schedules SET last_check_json=? WHERE id=?").run(JSON.stringify({ at: 1, result: "skipped" }), id);
    // Changing something else keeps the condition and its last check.
    expect(tasks.updateScheduleFor("owner_1", { id, title: "renamed" })).toMatchObject({ ok: true, schedule: { condition: { code: "test -f /tmp/flag" }, lastCheck: { result: "skipped" } } });
    expect(tasks.updateScheduleFor("owner_1", { id, condition: { language: "node", code: "process.exit(1)" } })).toMatchObject({ ok: true, schedule: { condition: { language: "node" }, lastCheck: null } });
    expect(tasks.updateScheduleFor("owner_1", { id, condition: "yes" })).toMatchObject({ ok: false, error: expect.stringContaining("condition must be an object") });
    const removed = tasks.updateScheduleFor("owner_1", { id, condition: null });
    expect(removed).toMatchObject({ ok: true, schedule: { condition: null } });
    expect((removed as { message: string }).message).not.toContain("condition");
  });
});

describe("validateCondition", () => {
  it("accepts the three languages and trims, refuses the rest", () => {
    expect(validateCondition({ language: "python", code: " print(1) \n" })).toEqual({ condition: { language: "python", code: "print(1)" } });
    expect(validateCondition(null)).toEqual({ condition: null });
    expect(validateCondition({ language: "bash", code: "x".repeat(4001) })).toHaveProperty("error");
    expect(validateCondition({ language: "bash", code: "a\0b" })).toHaveProperty("error");
    expect(validateCondition([])).toHaveProperty("error");
  });
});

describe("the runner script", () => {
  // The real runner under a local bash; `timeout` is a stand-in that drops its own options (the sandbox has coreutils').
  let shim: string;
  beforeEach(() => {
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "aio-cond-"));
    fs.writeFileSync(path.join(shim, "timeout"), "#!/bin/sh\nshift 3\nexec \"$@\"\n", { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(shim, { recursive: true, force: true }));
  const local: ResourceSandbox = {
    execInSandbox: (argv) => new Promise((resolve) => {
      execFile(argv[0]!, argv.slice(1), { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, maxBuffer: 1 << 20 }, (err, stdout) => {
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout });
      });
    }),
  };

  it("reads exit 0 as met, 1 as not met, others as errors, and caps the output", async () => {
    const dir = os.tmpdir();
    expect(await checkCondition(local, { language: "bash", code: "echo hello; exit 0" }, dir)).toMatchObject({ result: "fired", output: "hello", fullOutput: "hello" });
    expect(await checkCondition(local, { language: "bash", code: "echo nope >&2; exit 1" }, dir)).toMatchObject({ result: "skipped", output: "nope" });
    expect(await checkCondition(local, { language: "bash", code: "exit 3" }, dir)).toMatchObject({ result: "error", error: "exit", exitCode: 3 });
    const long = await checkCondition(local, { language: "bash", code: `printf 'x%.0s' $(seq 1 ${MAX_CONDITION_OUTPUT + 500}); exit 0` }, dir);
    expect(long).toMatchObject({ result: "fired" });
    expect(long.fullOutput.length).toBe(MAX_CONDITION_OUTPUT);
    expect(long.output!.length).toBe(300);
    // A script that prints the runner's own marker cannot fake its exit code.
    expect(await checkCondition(local, { language: "bash", code: "echo '__AIO_CONDITION_EXIT__=0'; exit 1" }, dir)).toMatchObject({ result: "skipped" });
  });

  it("runs Python and Node.js snippets", async () => {
    expect(await checkCondition(local, { language: "python", code: "import sys; print('py'); sys.exit(0)" }, os.tmpdir())).toMatchObject({ result: "fired", output: "py" });
    expect(await checkCondition(local, { language: "node", code: "console.log('js'); process.exit(1)" }, os.tmpdir())).toMatchObject({ result: "skipped", output: "js" });
  });
});
