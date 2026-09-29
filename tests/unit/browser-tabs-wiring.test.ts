import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentManager } from "../../src/server/codex/manager.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { openDb, type Db } from "../../src/server/db.js";
import { Logger } from "../../src/server/logger.js";
import { pruneBeforeSnapshot, TAB_POLICY, tabMcpServers, tabThreadConfig, type BrowserTask } from "../../src/server/browser/tabs.js";
import type { BrowserRuntimeLike } from "../../src/server/browser/lifecycle.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

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
let db: Db, agent: AgentManager, codex: RecordingCodex;
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
  };
  const browser = { reserveTurn: () => () => void log.push("lease-end"), ready: async () => void log.push("ready") };
  agent = new AgentManager({ cfg: testConfig("/tmp/pa-tabs-wiring", 1), db, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource, browser, tabs });
  await agent.init();
});

afterEach(() => {
  agent.shutdown();
  db.close();
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
  const wrapped = pruneBeforeSnapshot(runtime, { ensure: async () => undefined, finish: async () => undefined, prune: async () => void calls.push("prune"), list: async () => [], control: async () => null, screenshot: async () => null });
  await wrapped.status();
  await wrapped.wake();
  await wrapped.snapshot();
  await wrapped.stop();
  expect(calls).toEqual(["status", "wake", "prune", "snapshot", "stop"]);
});
