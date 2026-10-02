import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AgentManager } from "../../src/control/codex/manager.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { openDb, type Db } from "../../src/control/db.js";
import { Logger } from "../../src/common/logger.js";
import { pruneBeforeSnapshot, TAB_POLICY, tabMcpServers, tabThreadConfig, type BrowserTask } from "../../src/control/browser/tabs.js";
import type { BrowserRuntimeLike } from "../../src/control/browser/lifecycle.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import { KB_POLICY } from "../../src/control/kb.js";
import type { Config } from "../../src/control/config.js";

class RecordingCodex extends FakeCodex {
  threadOpts: Array<{ browserTask?: BrowserTask; developerInstructions?: string }> = [];
  resumes: Array<[string, string | undefined, BrowserTask | undefined]> = [];
  override async startThread(opts: Parameters<FakeCodex["startThread"]>[0] & { browserTask?: BrowserTask; developerInstructions?: string }) {
    this.threadOpts.push(opts);
    return super.startThread(opts);
  }
  override async resumeThread(threadId: string, developerInstructions?: string, browserTask?: BrowserTask) {
    this.resumes.push([threadId, developerInstructions, browserTask]);
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let db: Db, agent: AgentManager, codex: RecordingCodex, cfg: Config;
const log: string[] = [];
let releaseGate!: () => void;

beforeEach(async () => {
  log.length = 0;
  db = openDb(":memory:");
  codex = new RecordingCodex();
  const tabs = {
    ensure: async () => void log.push("ensure"),
    // The finish is slow on purpose: the browser hold must outlive it.
    finish: (key: string) => new Promise<void>((resolve) => { log.push(`finish:${key}`); releaseGate = () => { log.push("finished"); resolve(); }; }),
    prune: async () => void log.push("prune"),
    list: async () => [],
    control: async () => null,
    screenshot: async () => null,
    input: async () => ({ status: 200, body: {} }),
    pointer: async () => ({ status: 200, body: {} }),
    open: async () => ({ status: 200, body: {} }),
    close: async () => ({ status: 200, body: {} }),
  };
  const browser = { reserveTurn: () => () => void log.push("lease-end"), ready: async () => void log.push("ready") };
  cfg = testConfig("/tmp/pa-tabs-wiring", 1);
  agent = new AgentManager({ cfg, db, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource, browser, tabs });
  await agent.init();
});

afterEach(() => {
  agent.shutdown();
  db.close();
});

it("tells the executor about the knowledge base only when this runtime was granted it", async () => {
  const plain = agent.createConversation({ title: "没有知识库" });
  agent.submitTurn({ conversationId: plain.id, text: "hi", clientMessageId: "k1" });
  await tick();
  expect(codex.threadOpts[0]?.developerInstructions).not.toContain(KB_POLICY);

  cfg.kb = { url: "http://host.docker.internal:4902/kb/token/mcp" };
  const granted = agent.createConversation({ title: "有知识库" });
  agent.submitTurn({ conversationId: granted.id, text: "hi", clientMessageId: "k2" });
  await tick();
  expect(codex.threadOpts[1]?.developerInstructions).toContain(TAB_POLICY);
  expect(codex.threadOpts[1]?.developerInstructions?.endsWith(KB_POLICY)).toBe(true);
});

it("records every execution thread's tabs against its task and marks them finished before the browser hold ends", async () => {
  const conv = agent.createConversation({ title: "查网页" });
  agent.submitTurn({ conversationId: conv.id, text: "open a page", clientMessageId: "w1", requiresBrowser: true });
  await tick();
  expect(log.slice(0, 2)).toEqual(["ready", "ensure"]);
  expect(codex.threadOpts[0]?.browserTask).toEqual({ key: conv.id, title: "查网页" });
  expect(codex.threadOpts[0]?.developerInstructions).toContain(TAB_POLICY);

  codex.completeTurn(codex.startedTurns[0]!.turnId);
  await tick();
  expect(log).toContain(`finish:${conv.id}`);
  expect(log).not.toContain("lease-end");
  releaseGate();
  await tick();
  expect(log.slice(-2)).toEqual(["finished", "lease-end"]);
  // Finishing never destroys: only a prune (before an idle release) does.
  expect(log).not.toContain("prune");

  // A later turn resumes the same thread under the same identity.
  agent.submitTurn({ conversationId: conv.id, text: "again", clientMessageId: "w2" });
  await tick();
  expect(codex.resumes.at(-1)?.[2]).toEqual({ key: conv.id, title: "查网页" });
  codex.completeTurn(codex.startedTurns[1]!.turnId);
  await tick();
  releaseGate();
});

it("wires Codex threads and Claude Code turns to the task's identity and title", () => {
  const headers = { "X-AIO-Task": "conv_1", "X-AIO-Task-Title": encodeURIComponent("任务：订机票") };
  expect(tabThreadConfig({ key: "conv_1", title: "任务：订机票" })).toEqual({
    // A browser hand-over waits up to 30 minutes inside one tool call; the client must allow it.
    mcp_servers: { aio_browser: { enabled: false }, aio_tabs: { url: "http://127.0.0.1:8190/mcp", http_headers: headers, tool_timeout_sec: 31 * 60 } },
  });
  expect(tabMcpServers({ key: "conv_1", title: "任务：订机票" })).toEqual({ aio_tabs: { type: "http", url: "http://127.0.0.1:8190/mcp", headers } });
});

it("destroys finished tasks' tabs right before an idle snapshot, and only then", async () => {
  const calls: string[] = [];
  const runtime = {
    status: async () => (calls.push("status"), {}),
    snapshot: async () => (calls.push("snapshot"), {}),
    stop: async () => (calls.push("stop"), {}),
    wake: async () => (calls.push("wake"), {}),
  } as unknown as BrowserRuntimeLike;
  const wrapped = pruneBeforeSnapshot(runtime, { ensure: async () => undefined, finish: async () => undefined, prune: async () => void calls.push("prune"), list: async () => [], control: async () => null, screenshot: async () => null, input: async () => ({ status: 200, body: {} }), pointer: async () => ({ status: 200, body: {} }), open: async () => ({ status: 200, body: {} }), close: async () => ({ status: 200, body: {} }) });
  await wrapped.status();
  await wrapped.wake();
  await wrapped.snapshot();
  await wrapped.stop();
  expect(calls).toEqual(["status", "wake", "prune", "snapshot", "stop"]);
});

it("makes sure the current tab server runs before typing for a person", async () => {
  const { TabServer } = await import("../../src/control/browser/tabs.js");
  const seen: string[] = [];
  const container = {
    execInSandbox: async (argv: string[]) => {
      const route = argv.find((a) => a.startsWith("http://127.0.0.1:8190/")) ?? argv[0]!;
      seen.push(route.replace("http://127.0.0.1:8190", ""));
      if (route.endsWith("/healthz")) return { code: 0, stdout: JSON.stringify({ version: "old" }), stderr: "" };
      if (route.endsWith("/input")) return { code: 0, stdout: '{"title":"t","url":"u"}\n200', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    writeFileInSandbox: async () => undefined,
    execDetached: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const runtime = { ensureScripts: async () => undefined };
  const tabs = new TabServer(testConfig("/tmp/pa-tabs-input", 1), new Logger("error", undefined, false), container as never, runtime as never);
  // The stale server is replaced (it never reports the new version here, so ensure gives up and input refuses honestly).
  const out = await tabs.input({ text: "hi" });
  expect(seen[0]).toBe("/healthz");
  expect(out.status).toBe(503);
  expect(seen).not.toContain("/input");
}, 20_000);

/** A container whose tab server answers health checks as scripted; every other call is recorded. */
function scriptedTabServer(answers: Array<"silent" | "current">) {
  const version = createHash("sha256").update(fs.readFileSync(path.resolve(import.meta.dirname, "../../src/control/browser/scripts/tab-server.cjs"), "utf8")).digest("hex").slice(0, 16);
  const seen: string[] = [];
  let started = false;
  const container = {
    execInSandbox: async (argv: string[]) => {
      if (argv.some((a) => a.endsWith("/healthz"))) {
        const answer = started ? "current" : answers.shift() ?? "silent";
        seen.push(`health:${answer}`);
        return answer === "current" ? { code: 0, stdout: JSON.stringify({ version }), stderr: "" } : { code: 28, stdout: "", stderr: "" };
      }
      seen.push(argv.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
    writeFileInSandbox: async () => undefined,
    execDetached: async () => { seen.push("start"); started = true; return { code: 0, stdout: "", stderr: "" }; },
  };
  return { container, seen };
}

it("stops a tab server that holds the port but no longer answers, then starts the current one", async () => {
  const { TabServer } = await import("../../src/control/browser/tabs.js");
  const { container, seen } = scriptedTabServer(["silent", "silent"]);
  const tabs = new TabServer(testConfig("/tmp/pa-tabs-stuck", 1), new Logger("error", undefined, false), container as never, { ensureScripts: async () => undefined } as never);
  await tabs.ensure();
  // Only that exact script's process is killed (its event loop is stuck, so only SIGKILL ends it).
  expect(seen.filter((s) => !s.startsWith("chmod"))).toEqual(["health:silent", "health:silent", `pkill -KILL -f -x node ${tabs.scriptPath}`, "start", "health:current"]);
});

it("leaves a tab server alone when it answers the second time", async () => {
  const { TabServer } = await import("../../src/control/browser/tabs.js");
  const { container, seen } = scriptedTabServer(["silent", "current"]);
  const tabs = new TabServer(testConfig("/tmp/pa-tabs-busy", 1), new Logger("error", undefined, false), container as never, { ensureScripts: async () => undefined } as never);
  await tabs.ensure();
  expect(seen).toEqual(["health:silent", "health:current"]);
});
