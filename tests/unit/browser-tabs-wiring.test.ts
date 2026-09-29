import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentManager } from "../../src/server/codex/manager.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { openDb, type Db } from "../../src/server/db.js";
import { Logger } from "../../src/server/logger.js";
import { TAB_POLICY, tabMcpServers, tabThreadConfig } from "../../src/server/browser/tabs.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

class RecordingCodex extends FakeCodex {
  threadOpts: Array<{ browserTaskKey?: string; developerInstructions?: string }> = [];
  resumes: Array<[string, string | undefined, string | undefined]> = [];
  override async startThread(opts: Parameters<FakeCodex["startThread"]>[0] & { browserTaskKey?: string; developerInstructions?: string }) {
    this.threadOpts.push(opts);
    return super.startThread(opts);
  }
  override async resumeThread(threadId: string, developerInstructions?: string, browserTaskKey?: string) {
    this.resumes.push([threadId, developerInstructions, browserTaskKey]);
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
    // The release is slow on purpose: the browser hold must outlive it.
    release: (key: string) => new Promise<void>((resolve) => { log.push(`release:${key}`); releaseGate = () => { log.push("released"); resolve(); }; }),
  };
  const browser = { reserveTurn: () => () => void log.push("lease-end"), ready: async () => void log.push("ready") };
  agent = new AgentManager({ cfg: testConfig("/tmp/pa-tabs-wiring", 1), db, codex, log: new Logger("error", undefined, false), hostTokens: {} as HostTokenSource, browser, tabs });
  await agent.init();
});

afterEach(() => {
  agent.shutdown();
  db.close();
});

it("runs every execution thread on its own tabs and closes them before the browser hold ends", async () => {
  const conv = agent.createConversation({ title: "web" });
  agent.submitTurn({ conversationId: conv.id, text: "open a page", clientMessageId: "w1", requiresBrowser: true });
  await tick();
  expect(log.slice(0, 2)).toEqual(["ready", "ensure"]);
  expect(codex.threadOpts[0]?.browserTaskKey).toBe(conv.id);
  expect(codex.threadOpts[0]?.developerInstructions).toContain(TAB_POLICY);

  codex.completeTurn(codex.startedTurns[0]!.turnId);
  await tick();
  expect(log).toContain(`release:${conv.id}`);
  expect(log).not.toContain("lease-end");
  releaseGate();
  await tick();
  expect(log.slice(-2)).toEqual(["released", "lease-end"]);

  // A later turn resumes the same thread under the same identity.
  agent.submitTurn({ conversationId: conv.id, text: "again", clientMessageId: "w2" });
  await tick();
  expect(codex.resumes.at(-1)?.[2]).toBe(conv.id);
  codex.completeTurn(codex.startedTurns[1]!.turnId);
  await tick();
  releaseGate();
});

it("wires Codex threads and Claude Code turns to the task's own tab identity", () => {
  expect(tabThreadConfig("conv_1")).toEqual({
    mcp_servers: { aio_browser: { enabled: false }, aio_tabs: { url: "http://127.0.0.1:8190/mcp", http_headers: { "X-AIO-Task": "conv_1" } } },
  });
  expect(tabMcpServers("conv_1")).toEqual({ aio_tabs: { type: "http", url: "http://127.0.0.1:8190/mcp", headers: { "X-AIO-Task": "conv_1" } } });
});
