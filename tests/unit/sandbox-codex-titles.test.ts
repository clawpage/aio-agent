import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { SandboxCodexSession } from "../../src/server/codex/sandboxCodex.js";
import { Logger } from "../../src/server/logger.js";
import type { SandboxContainer } from "../../src/server/docker/sandbox.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { testConfig } from "../helpers/harness.js";

interface Inbound {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/**
 * A scripted stand-in for `codex app-server`: it answers the client's JSON-RPC
 * requests and can push arbitrary notifications / server requests back. This is
 * what lets a test observe which notifications the session forwards to the
 * manager (the user's conversation stream) and which it isolates.
 */
class FakeAppServer {
  readonly inbound: Inbound[] = [];
  readonly child: ChildProcess;
  #stdin = new PassThrough();
  #stdout = new PassThrough();
  #stderr = new PassThrough();
  #handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  #buffer = "";

  constructor() {
    this.#stdin.setEncoding("utf8");
    this.#stdin.on("data", (chunk: string) => this.#onData(chunk));
    const child = Object.assign(new EventEmitter(), {
      stdin: this.#stdin,
      stdout: this.#stdout,
      stderr: this.#stderr,
      exitCode: null as number | null,
      pid: 1,
      kill: () => undefined,
    });
    this.child = child as unknown as ChildProcess;
    this.handle("initialize", () => ({}));
    this.handle("account/login/start", () => ({}));
    this.handle("account/read", () => ({ account: { type: "chatgpt", email: "owner@example.com", planType: "pro" } }));
    this.handle("turn/interrupt", () => ({}));
  }

  handle(method: string, fn: (params: Record<string, unknown>) => unknown): void {
    this.#handlers.set(method, fn);
  }

  notify(method: string, params: unknown): void {
    this.#stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  serverRequest(id: number, method: string, params: unknown): void {
    this.#stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }

  responses(): Inbound[] {
    return this.inbound.filter((m) => m.method === undefined && m.id !== undefined);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Inbound;
      this.inbound.push(msg);
      if (msg.id !== undefined && msg.method) {
        const handler = this.#handlers.get(msg.method);
        const result = handler ? handler(msg.params ?? {}) : {};
        this.#stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      }
    }
  }
}

const hostTokens = {
  getTokens: async () => ({ accessToken: "token", chatgptAccountId: "acct", planType: "pro", expiresAt: Date.now() + 3_600_000 }),
} as unknown as HostTokenSource;

function containerFor(server: FakeAppServer): SandboxContainer {
  return { spawnCodexAppServer: () => server.child } as unknown as SandboxContainer;
}

function makeSession(server: FakeAppServer, timeoutMs = 30): SandboxCodexSession {
  const cfg = testConfig("/tmp/pa-title-stream", 1, {});
  cfg.agent.titleTimeoutMs = timeoutMs;
  return new SandboxCodexSession(cfg, new Logger("error", undefined, false), containerFor(server), hostTokens);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SandboxCodexSession auto-title isolation", () => {
  it("drops late notifications from a timed-out title thread and interrupts it", async () => {
    const server = new FakeAppServer();
    server.handle("thread/start", () => ({ thread: { id: "aux_1" } }));
    server.handle("turn/start", () => ({ turn: { id: "turn_aux_1" } }));
    const session = makeSession(server);
    const forwarded: Array<{ method: string; params: unknown }> = [];
    session.onNotification((method, params) => forwarded.push({ method, params }));

    try {
      // The scripted turn never completes, so the title run times out.
      expect(await session.generateTitle("第一轮用户消息")).toBeNull();

      // The main conversation is mid-turn (delta for a real thread is forwarded).
      server.notify("item/agentMessage/delta", { threadId: "main_1", turnId: "turn_main", itemId: "i2", delta: "正常增量" });
      // A late delta/item for the auxiliary thread must never reach the manager,
      // otherwise the manager's active-conversation delta buffer would record it.
      server.notify("item/agentMessage/delta", { threadId: "aux_1", turnId: "turn_aux_1", itemId: "i1", delta: "标题泄漏" });
      server.notify("item/completed", { threadId: "aux_1", turnId: "turn_aux_1", item: { id: "i1", type: "agentMessage", text: "标题泄漏" } });
      await wait(20);
      expect(forwarded).toEqual([
        { method: "item/agentMessage/delta", params: { threadId: "main_1", turnId: "turn_main", itemId: "i2", delta: "正常增量" } },
      ]);

      // A late approval on the tombstoned thread is denied, not surfaced to the UI.
      server.serverRequest(900, "item/commandExecution/requestApproval", { threadId: "aux_1", turnId: "turn_aux_1" });
      await wait(20);
      const approval = server.responses().find((m) => m.id === 900);
      expect(approval?.result).toEqual({ decision: "decline" });

      // The timed-out turn was asked to stop so the tombstone is released soon.
      expect(
        server.inbound.some(
          (m) => m.method === "turn/interrupt" && m.params?.threadId === "aux_1" && m.params?.turnId === "turn_aux_1",
        ),
      ).toBe(true);
    } finally {
      session.close();
    }
  });

  it("releases the tombstone once the auxiliary turn really completes", async () => {
    const server = new FakeAppServer();
    server.handle("thread/start", () => ({ thread: { id: "aux_2" } }));
    server.handle("turn/start", () => ({ turn: { id: "turn_aux_2" } }));
    const session = makeSession(server, 15);
    const forwarded: unknown[] = [];
    session.onNotification((method) => forwarded.push(method));

    try {
      expect(await session.generateTitle("第一轮")).toBeNull();
      // The interrupted turn finally reports completion: the tombstone is dropped.
      server.notify("turn/completed", { threadId: "aux_2", turn: { id: "turn_aux_2", status: "interrupted" } });
      await wait(10);
      // A later notification for that id is no longer swallowed by the tombstone.
      server.notify("thread/closed", { threadId: "aux_2" });
      await wait(10);
      expect(forwarded).toContain("thread/closed");
    } finally {
      session.close();
    }
  });

  it("returns a title only for a completed auxiliary turn", async () => {
    const server = new FakeAppServer();
    server.handle("thread/start", () => ({ thread: { id: "aux_3" } }));
    server.handle("turn/start", () => {
      server.notify("item/agentMessage/delta", { threadId: "aux_3", turnId: "turn_aux_3", itemId: "i1", delta: "失败标题" });
      server.notify("turn/completed", { threadId: "aux_3", turn: { id: "turn_aux_3", status: "failed" } });
      return { turn: { id: "turn_aux_3" } };
    });
    const session = makeSession(server, 200);

    try {
      expect(await session.generateTitle("第一轮")).toBeNull();
    } finally {
      session.close();
    }
  });

  it("returns the captured text for a completed auxiliary turn", async () => {
    const server = new FakeAppServer();
    server.handle("thread/start", () => ({ thread: { id: "aux_4" } }));
    server.handle("turn/start", () => ({ turn: { id: "turn_aux_4" } }));
    const session = makeSession(server, 200);

    try {
      const resultPromise = session.generateTitle("第一轮");
      await wait(10);
      server.notify("item/agentMessage/delta", { threadId: "aux_4", turnId: "turn_aux_4", itemId: "i1", delta: "清晰标题" });
      server.notify("turn/completed", { threadId: "aux_4", turn: { id: "turn_aux_4", status: "completed" } });
      expect(await resultPromise).toBe("清晰标题");
    } finally {
      session.close();
    }
  });
});

describe("SandboxCodexSession main turn summary opt-in", () => {
  it("sends the requested reasoning summary and omits it when disabled", async () => {
    const server = new FakeAppServer();
    server.handle("thread/start", () => ({ thread: { id: "main_1" }, model: "gpt-6-sol", cwd: "/home/gem/workspace" }));
    server.handle("turn/start", () => ({ turn: { id: "turn_main_1" } }));
    const session = makeSession(server, 200);
    try {
      await session.startThread({ model: "gpt-6-sol" });
      await session.startTurn({ threadId: "main_1", text: "hi", summary: "concise" });
      const withSummary = server.inbound.filter((m) => m.method === "turn/start").at(-1)!;
      expect(withSummary.params?.summary).toBe("concise");

      await session.startTurn({ threadId: "main_1", text: "again", summary: "none" });
      const without = server.inbound.filter((m) => m.method === "turn/start").at(-1)!;
      expect("summary" in (without.params ?? {})).toBe(false);
    } finally {
      session.close();
    }
  });
});

describe("SandboxCodexSession active-turn steering",()=>{
  it("sends the exact turn ID, text and images without starting another turn",async()=>{
    const server=new FakeAppServer();server.handle("turn/steer",p=>({turnId:p.expectedTurnId}));
    const session=makeSession(server);
    try{
      await session.start();
      await session.steerTurn({threadId:"thread-main",expectedTurnId:"turn-main",text:"补充要求",attachments:[{kind:"image",path:"/workspace/photo.png"},{kind:"file",path:"/workspace/data.csv"}]});
      const requests=server.inbound.filter(m=>m.method?.startsWith("turn/"));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({method:"turn/steer",params:{threadId:"thread-main",expectedTurnId:"turn-main",input:[{type:"text",text:expect.stringContaining("/workspace/data.csv")},{type:"localImage",path:"/workspace/photo.png"}]}});
    }finally{session.close();}
  });
  it("does not mark a mismatched acknowledgement as delivered",async()=>{
    const server=new FakeAppServer();server.handle("turn/steer",()=>({turnId:"different"}));
    const session=makeSession(server);
    try{await session.start();await expect(session.steerTurn({threadId:"thread-main",expectedTurnId:"turn-main",text:"extra"})).rejects.toThrow("acknowledgement");}finally{session.close();}
  });
});

 it("uses never approval for new, resumed, forked threads and every execution turn",async()=>{
    const server=new FakeAppServer();
    for(const m of ["thread/start","thread/fork"]) server.handle(m,()=>({thread:{id:"policy"},model:"gpt-6-sol",cwd:"/home/gem/workspace"}));
    server.handle("turn/start",()=>({turn:{id:"policy-turn"}}));
    const session=makeSession(server,200);
    try{
      await session.startThread();await session.resumeThread("policy");await session.forkThread("policy");await session.startTurn({threadId:"policy",text:"test"});
      for(const method of ["thread/start","thread/resume","thread/fork","turn/start"]){
        const params=server.inbound.find(m=>m.method===method)!.params!;
        expect(params.approvalPolicy).toBe("never");
        if(method==='turn/start')expect(params.sandboxPolicy).toEqual({type:"dangerFullAccess"});else expect(params.sandbox).toBe("danger-full-access");
      }
    }finally{session.close();}
 });
