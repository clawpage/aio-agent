import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_CODE_PROVIDER_ID, ClaudeCodeHarness } from "../../src/control/claudeCode.js";
import { ClaudeCodeSession, withAttachments } from "../../src/control/codex/claudeSession.js";
import { ClaudeStreamTranslator, MAX_TOOL_OUTPUT_CHARS, toolItem } from "../../src/control/codex/claudeTranslator.js";
import { HarnessSession } from "../../src/control/codex/harnessSession.js";
import { JsonRpcResponseError } from "../../src/control/codex/jsonrpc.js";
import { AgentManager } from "../../src/control/codex/manager.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import type { SandboxContainer } from "../../src/control/sandbox/container.js";
import { openDb, type Db } from "../../src/control/db.js";
import { UsageLedger } from '../../src/control/usage.js';
import { Logger } from "../../src/common/logger.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";

const SECRET = "sk-ant-oat-test-secret-0003";
const log = new Logger("error", undefined, false);
const cleanups: Array<() => void> = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function secretsFile(body: string, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-claude-test-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "claude-code.env");
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function enabledConfig(extra: Record<string, string> = {}) {
  return testConfig("/tmp/pa-claude-harness", 1, {
    PA_CLAUDE_CODE_ENABLED: "auto",
    PA_CLAUDE_CODE_SECRETS_FILE: secretsFile(`CLAUDE_CODE_OAUTH_TOKEN=${SECRET}\n`),
    ...extra,
  });
}

describe("ClaudeCodeHarness", () => {
  it("enables from a private credential file and offers Claude models on its own provider", () => {
    const harness = new ClaudeCodeHarness(enabledConfig(), log);
    expect(harness.enabled).toBe(true);
    const entries = harness.modelEntries();
    expect(entries.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
    expect(entries.every((m) => m.modelProvider === CLAUDE_CODE_PROVIDER_ID)).toBe(true);
    expect(harness.owns("claude-opus-5-5")).toBe(true);
    expect(harness.owns("gpt-6-sol")).toBe(false);
    expect(harness.credentialEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET });
  });

  it("accepts an API key when no OAuth token is configured", () => {
    const cfg = testConfig("/tmp/pa-claude-harness", 1, {
      PA_CLAUDE_CODE_ENABLED: "auto",
      PA_CLAUDE_CODE_SECRETS_FILE: secretsFile(`ANTHROPIC_API_KEY=${SECRET}\n`),
    });
    expect(new ClaudeCodeHarness(cfg, log).credentialEnv()).toEqual({ ANTHROPIC_API_KEY: SECRET });
  });

  it("refuses a credential file others can read, and stays off without one", () => {
    const loose = testConfig("/tmp/pa-claude-harness", 1, {
      PA_CLAUDE_CODE_ENABLED: "on",
      PA_CLAUDE_CODE_SECRETS_FILE: secretsFile(`CLAUDE_CODE_OAUTH_TOKEN=${SECRET}\n`, 0o644),
    });
    const harness = new ClaudeCodeHarness(loose, log);
    expect(harness.enabled).toBe(false);
    expect(harness.modelEntries()).toEqual([]);
    expect(harness.credentialEnv()).toEqual({});
  });

  it("is never offered to a member runtime without an assigned Claude model, or when switched off", () => {
    expect(new ClaudeCodeHarness({ ...enabledConfig(), memberRuntime: true }, log).enabled).toBe(false);
    expect(new ClaudeCodeHarness(enabledConfig({ PA_CLAUDE_CODE_ENABLED: "off" }), log).enabled).toBe(false);
  });

  it("gives an assigned member only its gateway token and address, never the owner's credential", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = SECRET;
    const base = enabledConfig();
    const member = {
      ...base, memberRuntime: true, memberModel: "claude-sonnet-5-5",
      claudeCode: { ...base.claudeCode, secretsFile: secretsFile("ANTHROPIC_AUTH_TOKEN=member-gateway-token\n"), gatewayUrl: "http://host.docker.internal:4902/u/user_a/anthropic" },
    };
    const harness = new ClaudeCodeHarness(member, log);
    expect(harness.enabled).toBe(true);
    expect(harness.credentialEnv()).toEqual({
      ANTHROPIC_AUTH_TOKEN: "member-gateway-token",
      ANTHROPIC_BASE_URL: "http://host.docker.internal:4902/u/user_a/anthropic",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(JSON.stringify(harness.credentialEnv())).not.toContain(SECRET);
    expect(harness.modelEntries().map((m) => m.id)).toEqual(["claude-sonnet-5-5"]);
    expect(harness.owns("claude-opus-5-5")).toBe(false);
    // The owner's own credential file is not a member token source either.
    const noToken = { ...member, claudeCode: { ...member.claudeCode, secretsFile: base.claudeCode.secretsFile } };
    expect(new ClaudeCodeHarness(noToken, log).enabled).toBe(false);
  });
});

describe("ClaudeStreamTranslator", () => {
  function run(events: Array<Record<string, unknown>>) {
    const out: Array<{ method: string; params: Record<string, unknown> }> = [];
    const t = new ClaudeStreamTranslator("claude-t", "cturn_1", "/home/gem/workspace", (method, params) => out.push({ method, params }));
    for (const e of events) t.handle(e);
    return { out, t };
  }

  // Shapes recorded from a real `claude -p --output-format stream-json --include-partial-messages` run.
  const turn = [
    { type: "system", subtype: "init", session_id: "s" },
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, parent_tool_use_id: null },
    { type: "assistant", message: { id: "msg_1", content: [{ type: "thinking", thinking: "" }] }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } }, parent_tool_use_id: null },
    { type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo probe-ok" } }] }, parent_tool_use_id: null },
    // A sub-agent's own traffic stays inside its tool call.
    { type: "assistant", message: { id: "msg_sub", content: [{ type: "text", text: "inner" }] }, parent_tool_use_id: "toolu_task" },
    { type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "probe-ok", is_error: false }] }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_2" } }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Environment" } }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " ready." } }, parent_tool_use_id: null },
    { type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "Environment ready." }] }, parent_tool_use_id: null },
  ];

  it("maps a real turn onto Codex item events", () => {
    const { out } = run(turn);
    expect(out.map((e) => `${e.method}:${String((e.params.item as { type?: string } | undefined)?.type ?? "")}`)).toEqual([
      "item/started:commandExecution",
      "item/completed:commandExecution",
      "item/started:agentMessage",
      "item/agentMessage/delta:",
      "item/agentMessage/delta:",
      "item/completed:agentMessage",
    ]);
    for (const e of out) expect(e.params).toMatchObject({ threadId: "claude-t", turnId: "cturn_1" });
    expect(out[1]!.params.item).toMatchObject({ id: "toolu_1", command: "echo probe-ok", status: "completed", aggregatedOutput: "probe-ok" });
    // The streamed text and the settled message share one item id.
    const textId = (out[2]!.params.item as { id: string }).id;
    expect(out[3]!.params.itemId).toBe(textId);
    expect(out[5]!.params.item).toMatchObject({ id: textId, text: "Environment ready." });
  });

  it("never reports a synthetic error message as the answer", () => {
    const { out } = run([{ type: "assistant", error: "authentication_failed", message: { id: "x", content: [{ type: "text", text: "Not logged in" }] } }]);
    expect(out).toEqual([]);
  });

  it("marks failed tools, clips huge outputs and closes calls left open", () => {
    const { out, t } = run([
      { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/x" } }, { type: "tool_use", id: "b", name: "Bash", input: { command: "yes" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "nope" }] }] } },
    ]);
    expect(out[2]!.params.item).toMatchObject({ id: "a", type: "Read", title: "/x", status: "failed", output: "nope" });
    t.settleOpenTools();
    expect(out.at(-1)!.params.item).toMatchObject({ id: "b", status: "failed" });
    const big = run([
      { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c", content: "y".repeat(MAX_TOOL_OUTPUT_CHARS + 10) }] } },
    ]).out;
    expect(String((big[1]!.params.item as { aggregatedOutput: string }).aggregatedOutput).length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 50);
  });

  it("shows file edits, MCP calls and web search with their existing item types", () => {
    expect(toolItem("1", "Edit", { file_path: "/w/a.md" }, "/w")).toMatchObject({ type: "fileChange", changes: [{ path: "/w/a.md", kind: "update" }] });
    expect(toolItem("2", "mcp__aio_browser__browser_navigate", { url: "u" }, "/w")).toMatchObject({ type: "mcpToolCall", server: "aio_browser", tool: "browser_navigate" });
    expect(toolItem("3", "WebSearch", { query: "q" }, "/w")).toMatchObject({ type: "webSearch", query: "q" });
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: Array<Record<string, unknown>> = [];
  stdinEnded = false;
  killed = false;
  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    let buf = "";
    this.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        try {
          this.written.push(JSON.parse(line));
        } catch {
          this.written.push({ raw: line });
        }
        buf = buf.slice(i + 1);
      }
    });
    this.stdin.on("finish", () => (this.stdinEnded = true));
  }
  send(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  close(): void {
    this.emit("close", 0);
  }
  kill(): boolean {
    this.killed = true;
    this.close();
    return true;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 10));

function makeSession(patch: Partial<ReturnType<typeof enabledConfig>> = {}, usage?: UsageLedger) {
  const spawns: Array<{ args: string[]; env: Record<string, string>; child: FakeChild }> = [];
  const existing = new Set<string>();
  const killed: string[] = [];
  const container = {
    ensureClaudeCli: async () => undefined,
    claudeSessionExists: async (id: string) => existing.has(id),
    killClaudeSession: async (id: string) => void killed.push(id),
    spawnClaude: (args: string[], env: Record<string, string>) => {
      const child = new FakeChild();
      spawns.push({ args, env, child });
      return child;
    },
  } as unknown as SandboxContainer;
  const cfg = { ...enabledConfig(), ...patch };
  const session = new ClaudeCodeSession(cfg, log, container, new ClaudeCodeHarness(cfg, log), usage);
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  session.onNotification((method, params) => events.push({ method, params: params as Record<string, unknown> }));
  return { session, spawns, existing, killed, events };
}

const statusOf = (events: Array<{ method: string; params: Record<string, unknown> }>) =>
  (events.find((e) => e.method === "turn/completed")?.params.turn as { status?: string; error?: { message: string } } | undefined);

describe("ClaudeCodeSession", () => {
  it('persists actual executor and auxiliary result counters, including failure spend',async()=>{
    const db=openDb(':memory:');const {session,spawns}=makeSession({},new UsageLedger(db));
    try {
      const {threadId}=await session.startThread({model:'claude-opus-5-5'});await session.startTurn({threadId,text:'hello'});
      spawns[0].child.send({type:'result',is_error:true,uuid:'r1',modelUsage:{opus:{inputTokens:10,outputTokens:2,cacheReadInputTokens:20}}});spawns[0].child.close();
      const plan=session.planTask('classify');await flush();
      spawns[1].child.send({type:'result',result:'{}',uuid:'r2',usage:{input_tokens:3,output_tokens:1,cache_creation_input_tokens:4}});spawns[1].child.close();await plan;
      expect(db.prepare('SELECT SUM(input) input,SUM(output) output FROM token_usage').get()).toMatchObject({input:37,output:3});
    }finally{session.close();db.close();}
  });
  it("starts a session with fixed flags, then resumes it on the next turn", async () => {
    const { session, spawns, existing, events } = makeSession();
    const { threadId } = await session.startThread({ model: "claude-opus-5-5", developerInstructions: "你是助理" });
    expect(threadId.startsWith("claude-")).toBe(true);
    const sessionId = threadId.slice("claude-".length);
    const turnId = await session.startTurn({ threadId, text: "hi", model: "claude-opus-5-5", effort: "xhigh", attachments: [{ path: "/home/gem/workspace/uploads/a.png", kind: "image" }] });
    const { args, env, child } = spawns[0]!;
    expect(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2)).toEqual(["--session-id", sessionId]);
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--effort", "xhigh", "--append-system-prompt", "你是助理", "--permission-mode", "bypassPermissions", "--strict-mcp-config"]));
    // The CLI's session-bound timers are off: the account's schedules are aio_schedule's.
    expect(args).toContain("--disallowedTools=CronCreate,CronDelete,CronList,ScheduleWakeup");
    // The credential travels in the child environment only.
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET });
    expect(args.join(" ")).not.toContain(SECRET);
    await flush();
    expect(JSON.stringify(child.written[0])).toContain("/home/gem/workspace/uploads/a.png");

    child.send({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "hi" }] } });
    child.send({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "done" }] } });
    child.send({ type: "result", subtype: "success", is_error: false, result: "done" });
    await flush();
    expect(child.stdinEnded).toBe(true);
    child.close();
    expect(statusOf(events)).toMatchObject({ id: turnId, status: "completed" });

    existing.add(sessionId);
    await session.resumeThread(threadId, "新的设定");
    await session.startTurn({ threadId, text: "again" });
    const second = spawns[1]!.args;
    expect(second.slice(second.indexOf("--resume"), second.indexOf("--resume") + 2)).toEqual(["--resume", sessionId]);
    expect(second).toContain("新的设定");
  });

  it("reports an error result as a failed turn with the CLI's own reason", async () => {
    const { session, spawns, events } = makeSession();
    const { threadId } = await session.startThread({});
    await session.startTurn({ threadId, text: "hi" });
    const { child } = spawns[0]!;
    child.send({ type: "assistant", error: "authentication_failed", message: { id: "x", content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
    child.send({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    await flush();
    child.close();
    expect(events.find((e) => e.method === "error")?.params.message).toBe("Not logged in · Please run /login");
    expect(statusOf(events)).toMatchObject({ status: "failed", error: { message: "Not logged in · Please run /login" } });
    expect(events.some((e) => (e.params.item as { type?: string } | undefined)?.type === "agentMessage")).toBe(false);
  });

  it("treats a process that ends without a result as an unknown outcome", async () => {
    const { session, spawns, events } = makeSession();
    const { threadId } = await session.startThread({});
    await session.startTurn({ threadId, text: "hi" });
    spawns[0]!.child.close();
    expect(statusOf(events)?.status).toBe("unknown");
  });

  it("interrupts through the control channel and reports the turn as stopped", async () => {
    const { session, spawns, events } = makeSession();
    const { threadId } = await session.startThread({});
    const turnId = await session.startTurn({ threadId, text: "hi" });
    await session.interrupt(threadId, turnId);
    const { child } = spawns[0]!;
    await flush();
    expect(child.written.at(-1)).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    child.send({ type: "result", subtype: "error_during_execution", is_error: true });
    await flush();
    child.close();
    expect(statusOf(events)?.status).toBe("interrupted");
  });

  it("confirms a mid-turn addition only when the CLI echoes it, and refuses one after the result", async () => {
    const { session, spawns } = makeSession();
    const { threadId } = await session.startThread({});
    const turnId = await session.startTurn({ threadId, text: "hi" });
    const { child } = spawns[0]!;
    child.send({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "hi" }] } });
    await flush();
    let delivered = false;
    const steer = session.steerTurn({ threadId, expectedTurnId: turnId, text: "also this" }).then(() => (delivered = true));
    await flush();
    expect(delivered).toBe(false);
    expect(JSON.stringify(child.written.at(-1))).toContain("also this");
    child.send({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "also this" }] } });
    await steer;
    expect(delivered).toBe(true);

    await expect(session.steerTurn({ threadId, expectedTurnId: "other", text: "x" })).rejects.toBeInstanceOf(JsonRpcResponseError);
    child.send({ type: "result", subtype: "success", is_error: false });
    await flush();
    await expect(session.steerTurn({ threadId, expectedTurnId: turnId, text: "late" })).rejects.toBeInstanceOf(JsonRpcResponseError);
  });

  it("keeps the process open until an addition queued before the result is consumed", async () => {
    const { session, spawns, events } = makeSession();
    const { threadId } = await session.startThread({});
    const turnId = await session.startTurn({ threadId, text: "hi" });
    const { child } = spawns[0]!;
    child.send({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "hi" }] } });
    await flush();
    const steer = session.steerTurn({ threadId, expectedTurnId: turnId, text: "more" });
    child.send({ type: "result", subtype: "success", is_error: false });
    await flush();
    expect(child.stdinEnded).toBe(false);
    child.send({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "more" }] } });
    await steer;
    child.send({ type: "result", subtype: "success", is_error: false });
    await flush();
    expect(child.stdinEnded).toBe(true);
    child.close();
    expect(statusOf(events)?.status).toBe("completed");
  });

  it("gives a task's turns its own browser tabs, also after a restart", async () => {
    const { session, spawns } = makeSession();
    const mcp = (i: number) => JSON.parse(spawns[i]!.args[spawns[i]!.args.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    const { threadId } = await session.startThread({ browserTask: { key: "conv_web", title: "查网页" } });
    await session.startTurn({ threadId, text: "hi" });
    expect(Object.keys(mcp(0).mcpServers)).toEqual(["aio_tabs"]);
    expect(mcp(0).mcpServers.aio_tabs!.headers).toEqual({ "X-AIO-Task": "conv_web", "X-AIO-Task-Title": encodeURIComponent("查网页") });
    spawns[0]!.child.close();

    const restarted = makeSession();
    await restarted.session.resumeThread(threadId, undefined, { key: "conv_web", title: "查网页" });
    await restarted.session.startTurn({ threadId, text: "again" });
    const args = restarted.spawns[0]!.args;
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!).mcpServers.aio_tabs.headers["X-AIO-Task"]).toBe("conv_web");
  });

  it("adds the knowledge base to a task's turns only when this runtime was granted it", async () => {
    const url = "http://host.docker.internal:4902/kb/token/mcp";
    const { session, spawns } = makeSession({ kb: { url } });
    const servers = (i: number) => JSON.parse(spawns[i]!.args[spawns[i]!.args.indexOf("--mcp-config") + 1]!).mcpServers;
    const task = await session.startThread({ browserTask: { key: "conv_kb", title: "查资料" } });
    await session.startTurn({ threadId: task.threadId, text: "hi" });
    expect(Object.keys(servers(0))).toEqual(["aio_tabs", "aio_kb"]);
    expect(servers(0).aio_kb).toEqual({ type: "http", url });
    const plain = await session.startThread({});
    await session.startTurn({ threadId: plain.threadId, text: "hi" });
    expect(Object.keys(servers(1))).toEqual(["aio_browser"]);
  });

  it("adds the image tool to a task's turns only when this runtime has one", async () => {
    const url = "http://host.docker.internal:4902/image/token/mcp";
    const { session, spawns } = makeSession({ image: { url } });
    const servers = (i: number) => JSON.parse(spawns[i]!.args[spawns[i]!.args.indexOf("--mcp-config") + 1]!).mcpServers;
    const task = await session.startThread({ browserTask: { key: "conv_img", title: "画图" } });
    await session.startTurn({ threadId: task.threadId, text: "hi" });
    expect(Object.keys(servers(0))).toEqual(["aio_tabs", "aio_image"]);
    expect(servers(0).aio_image).toEqual({ type: "http", url });
  });

  it("runs one turn per session at a time", async () => {
    const { session } = makeSession();
    const { threadId } = await session.startThread({});
    await session.startTurn({ threadId, text: "a" });
    await expect(session.startTurn({ threadId, text: "b" })).rejects.toThrow();
  });

  it("lists attachments as sandbox paths", () => {
    expect(withAttachments("看图", [{ path: "/u/a.png", kind: "image", name: "a.png" }])).toBe("看图\n\n附件（沙箱内路径）：\n- /u/a.png（图片）（a.png）");
    expect(withAttachments("纯文本")).toBe("纯文本");
  });
});

describe("ClaudeCodeSession auxiliary runs", () => {
  it("dispatches with a tool-less, non-persisted run on the auxiliary model", async () => {
    const { session, spawns } = makeSession();
    const plan = session.planTask("classify this", "设定");
    await flush();
    const { args, child } = spawns[0]!;
    expect(args).toEqual(expect.arrayContaining(["--tools", "", "--no-session-persistence", "--output-format", "json", "--model", "claude-sonnet-5-5", "--effort", "high", "--append-system-prompt", "设定"]));
    expect(args).not.toContain("bypassPermissions");
    child.send({ type: "result", subtype: "success", is_error: false, result: '{"title":"x"}' });
    child.close();
    expect(await plan).toBe('{"title":"x"}');
  });

  it("returns nothing for a failed auxiliary run", async () => {
    const { session, spawns } = makeSession();
    const plan = session.planTask("hi");
    await flush();
    spawns[0]!.child.send({ type: "result", subtype: "success", is_error: true, result: "Not logged in" });
    spawns[0]!.child.close();
    expect(await plan).toBeNull();
  });
});

describe("HarnessSession", () => {
  it("routes Claude threads to Claude Code and everything else to Codex", async () => {
    const codex = new FakeCodex();
    const calls: string[] = [];
    const claude = {
      onNotification: () => undefined,
      startThread: async () => (calls.push("start"), { threadId: "claude-x", model: "m", cwd: "/w", modelProvider: CLAUDE_CODE_PROVIDER_ID }),
      resumeThread: async () => void calls.push("resume"),
      startTurn: async () => (calls.push("turn"), "cturn_1"),
      interrupt: async () => void calls.push("interrupt"),
      steerTurn: async () => void calls.push("steer"),
      close: () => void calls.push("close"),
    } as unknown as ClaudeCodeSession;
    let selected = false;
    const aux: string[] = [];
    Object.assign(claude, {
      planTask: async () => (aux.push("plan"), "{}"),
      owns: (model: string) => model === "claude-sonnet-5-5",
    });
    const harness = new HarnessSession(codex, claude, () => selected);
    await harness.startThread({ modelProvider: CLAUDE_CODE_PROVIDER_ID });
    await harness.resumeThread("claude-x");
    await harness.startTurn({ threadId: "claude-x", text: "t" });
    await harness.interrupt("claude-x", "cturn_1");
    await harness.steerTurn({ threadId: "claude-x", expectedTurnId: "cturn_1", text: "s" });
    expect(calls).toEqual(["start", "resume", "turn", "interrupt", "steer"]);

    const codexThread = await harness.startThread({ model: "gpt-6-sol" });
    expect(codexThread.threadId).toMatch(/^thread_/);
    await harness.startTurn({ threadId: codexThread.threadId, text: "t" });
    expect(codex.startedTurns).toHaveLength(1);
    await expect(harness.forkThread("claude-x", {})).rejects.toThrow();
    await expect(harness.forkThread(codexThread.threadId, { modelProvider: CLAUDE_CODE_PROVIDER_ID })).rejects.toThrow();

    // The dispatcher follows the owner's harness choice; an explicit model (the
    // member policy) runs on that model's harness.
    await harness.planTask("p");
    expect(aux).toEqual([]);
    selected = true;
    await harness.planTask("p");
    expect(aux).toEqual(["plan"]);
    await harness.planTask("p", undefined, "deepseek-v4.1-flash");
    expect(aux).toEqual(["plan"]);
    selected = false;
    await harness.planTask("p", undefined, "claude-sonnet-5-5");
    expect(aux).toEqual(["plan", "plan"]);
  });
});

describe("AgentManager with the Claude Code harness", () => {
  let agent: AgentManager;
  let codex: FakeCodex;
  let db: Db;
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    codex = new FakeCodex();
    const cfg = enabledConfig();
    db = openDb(":memory:");
    const hostTokens = { status: async () => ({ ok: true }) } as unknown as HostTokenSource;
    agent = new AgentManager({ cfg, db, log, codex, hostTokens, claudeCode: new ClaudeCodeHarness(cfg, log) });
    await agent.init();
  });

  afterEach(() => {
    agent.shutdown();
    db.close();
  });

  it("lists Claude models and runs a new conversation on the Claude Code provider", async () => {
    const models = await agent.listModels();
    expect(models.find((m) => m.id === "claude-opus-5-5")?.modelProvider).toBe(CLAUDE_CODE_PROVIDER_ID);
    expect(agent.saveAgentSettings({ model: "claude-opus-5-5", effort: "xhigh" }, models).ok).toBe(true);
    const conv = agent.createConversation({ title: "claude" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "c1" });
    await tick();
    const threadId = codex.startedThreads[0]!.threadId;
    expect(codex.threadProviders.get(threadId)).toBe(CLAUDE_CODE_PROVIDER_ID);
    expect(codex.startedTurns[0]).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick();
    const row = db.prepare("SELECT model_provider FROM conversations WHERE id = ?").get(conv.id) as { model_provider: string };
    expect(row.model_provider).toBe(CLAUDE_CODE_PROVIDER_ID);
  });

  it("runs a member assigned Claude on Claude Code with its fixed model, whatever the client asks", async () => {
    const base = enabledConfig();
    const cfg = {
      ...base, memberRuntime: true, memberModel: "claude-sonnet-5-5", agent: { ...base.agent, defaultModel: "claude-sonnet-5-5" },
      claudeCode: { ...base.claudeCode, secretsFile: secretsFile("ANTHROPIC_AUTH_TOKEN=member-gateway-token\n"), gatewayUrl: "http://host.docker.internal:4902/u/user_m/anthropic" },
    };
    const memberDb = openDb(":memory:");
    memberDb.prepare("INSERT INTO owners(id,username,role,password_hash,password_salt,password_params,created_at) VALUES ('user_m','cr','member','x','x','{}',0)").run();
    const hostTokens = { status: async () => ({ ok: true }) } as unknown as HostTokenSource;
    const member = new AgentManager({ cfg, db: memberDb, log, codex, hostTokens, claudeCode: new ClaudeCodeHarness(cfg, log) });
    await member.init();
    try {
      expect(member.memberSettings()).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
      const conv = member.createConversation({ ownerId: "user_m", title: "member" });
      member.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1", model: "claude-fable-5-1", effort: "max" });
      await tick();
      const threadId = codex.startedThreads[0]!.threadId;
      expect(codex.threadProviders.get(threadId)).toBe(CLAUDE_CODE_PROVIDER_ID);
      expect(codex.startedTurns[0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    } finally {
      member.shutdown();
      memberDb.close();
    }
  });

  it("moves a follow-up to the selected harness with the earlier exchange as background", async () => {
    const conv = agent.createConversation({ title: "codex first" });
    agent.submitTurn({ conversationId: conv.id, text: "规划三天行程", clientMessageId: "k1" });
    await tick();
    const first = codex.startedTurns[0]!;
    codex.emitNotification("item/completed", { threadId: first.threadId, turnId: first.turnId, item: { type: "agentMessage", id: "a1", text: "第一天去海边。" } });
    codex.completeTurn(first.turnId);
    await tick();

    agent.saveAgentSettings({ model: "claude-sonnet-5-5", effort: "high" }, await agent.listModels());
    agent.submitTurn({ conversationId: conv.id, text: "第二天改去山里", clientMessageId: "k2" });
    await tick();
    // No fork across harnesses: a fresh Claude Code session carries the history.
    expect(codex.forkedThreads).toHaveLength(0);
    expect(codex.startedThreads).toHaveLength(2);
    const second = codex.startedTurns[1]!;
    expect(second.threadId).not.toBe(first.threadId);
    expect(codex.threadProviders.get(second.threadId)).toBe(CLAUDE_CODE_PROVIDER_ID);
    expect(second.model).toBe("claude-sonnet-5-5");
    expect(second.text).toContain("用户：规划三天行程\n助理：第一天去海边。");
    expect(second.text.endsWith("[当前消息]\n第二天改去山里")).toBe(true);
    codex.completeTurn(second.turnId);
    await tick();

    // Later turns on the same harness resume that session with the plain message.
    agent.submitTurn({ conversationId: conv.id, text: "再加一天", clientMessageId: "k3" });
    await tick();
    expect(codex.startedTurns[2]).toMatchObject({ threadId: second.threadId, text: "再加一天" });
    codex.completeTurn(codex.startedTurns[2]!.turnId);
    await tick();
  });

  it("records the harness's failure reason on the turn", async () => {
    agent.saveAgentSettings({ model: "claude-opus-5-5", effort: null }, await agent.listModels());
    const conv = agent.createConversation({ title: "fail" });
    const { turn } = agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "f1" });
    await tick();
    const started = codex.startedTurns[0]!;
    codex.emitNotification("turn/completed", { threadId: started.threadId, turn: { id: started.turnId, status: "failed", error: { message: "Not logged in" } } });
    await tick();
    const row = db.prepare("SELECT status, error FROM turns WHERE id = ?").get(turn.id) as { status: string; error: string };
    expect(row).toMatchObject({ status: "failed", error: "执行失败：Not logged in" });
  });
});
