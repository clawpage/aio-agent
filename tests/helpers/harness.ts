import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { bootstrap } from "../../src/server/index.js";
import { loadConfig, type Config } from "../../src/server/config.js";
import { Logger } from "../../src/server/logger.js";
import type { AppContext } from "../../src/server/context.js";
import type { CodexModel, SandboxAccount } from "../../src/server/codex/sandboxCodex.js";
import type { CodexSessionLike } from "../../src/server/codex/manager.js";
import type { SandboxContainer } from "../../src/server/docker/sandbox.js";
import { createApp, handleUpgrade } from "../../src/server/http/server.js";

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SandboxScript {
  /** Payload returned by /v1/shell/exec (or a function of the request body). */
  shell?:
    | { success: boolean; message?: string; data?: Record<string, unknown> }
    | ((body: string) => { success: boolean; message?: string; data?: Record<string, unknown> });
  /** Paths that /v1/file/list should consider to exist. */
  existingPaths?: string[];
  /** Payload returned by /v1/shell/view (defaults to a completed/0 result). */
  shellView?: { success: boolean; data?: Record<string, unknown> };
  /** Make /v1/file/write return a structured FileOperationError. */
  writeError?: boolean;
  /** Payload returned by POST /v1/browser/tabs (defaults to a success envelope). */
  browserTab?: { success: boolean; message?: string; data?: unknown };
  /** HTTP status returned by POST /v1/browser/tabs (defaults to 200). */
  browserTabStatus?: number;
}

export interface FakeSandbox {
  port: number;
  server: http.Server;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  script: SandboxScript;
  lastShellCommand: () => string;
  lastUploadBody: () => string;
  lastBrowserTabBody: () => string;
  close: () => Promise<void>;
}

/** Minimal stand-in for the AIO sandbox: echoes paths, sets cookies, supports WS echo. */
export async function startFakeSandbox(): Promise<FakeSandbox> {
  const requests: FakeSandbox["requests"] = [];
  const sandboxScript: SandboxScript = {};
  let lastShellCommand = "";
  let lastUploadBody = "";
  let lastBrowserTabBody = "";
  // In the default "everything exists" mode, model the real filesystem effect of
  // `rm -rf` so higher-level delete flows can verify removal. Tests that pin
  // `existingPaths` keep that list authoritative (used to assert unverified
  // deletion), so tracking only applies when it is unset.
  const removedPaths = new Set<string>();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers });
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
      return;
    }
    if (req.url?.startsWith("/set-cookie")) {
      res.writeHead(200, {
        "content-type": "text/html",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "set-cookie": ["jupyter_token=abc; Path=/; HttpOnly", "pa_session=evil; Path=/", "code=1; Domain=example.com; Path=/"],
      });
      res.end("<html><body>sandbox page</body></html>");
      return;
    }
    if (req.url === "/v1/shell/exec") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastShellCommand = body;
        if (!sandboxScript.existingPaths) {
          try {
            const command = (JSON.parse(body || "{}") as { command?: string }).command ?? "";
            const removed = /^rm -rf -- '(.*)'$/s.exec(command);
            if (removed) removedPaths.add(removed[1].replace(/'\\''/g, "'"));
          } catch {
            /* body was not JSON; nothing to model */
          }
        }
        const scripted = sandboxScript.shell ?? { success: true, data: { status: "completed", exit_code: 0, output: "" } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(typeof scripted === "function" ? scripted(body) : scripted));
      });
      return;
    }
    if (req.url === "/v1/shell/view") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(sandboxScript.shellView ?? { success: true, data: { status: "completed", exit_code: 0, output: "" } }),
      );
      return;
    }
    if (req.url === "/v1/file/upload") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastUploadBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { path: "uploaded" } }));
      });
      return;
    }
    if (req.url === "/v1/file/list") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const target = (JSON.parse(body || "{}") as { path?: string }).path ?? "";
        const exists = sandboxScript.existingPaths
          ? sandboxScript.existingPaths.includes(target)
          : !removedPaths.has(target);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          exists
            ? JSON.stringify({ success: true, data: { path: target, files: [] } })
            : JSON.stringify({ success: false, message: "No such path", data: { error_type: "not_found", path: target } }),
        );
      });
      return;
    }
    if (req.url === "/v1/file/write") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const target = (JSON.parse(body || "{}") as { file?: string }).file ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          sandboxScript.writeError
            ? JSON.stringify({ success: true, data: { error_type: "permission_denied", message: "EACCES", path: target } })
            : JSON.stringify({ success: true, data: { file: target, bytes_written: 0 } }),
        );
      });
      return;
    }
    if (req.url === "/v1/browser/tabs") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastBrowserTabBody = body;
        const payload = sandboxScript.browserTab ?? { success: true, message: "opened", data: { tabId: "tab_1" } };
        res.writeHead(sandboxScript.browserTabStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    if (req.url?.startsWith("/echo")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body,
          }),
        );
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const upgraded = new Set<Duplex>();
  server.on("upgrade", (req, socket) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    // Raw WebSocket-ish echo handshake for proxy tests.
    const key = req.headers["sec-websocket-key"] ?? "";
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${key}\r\n\r\n`,
    );
    socket.write("hello-from-sandbox");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    server,
    requests,
    script: sandboxScript,
    lastShellCommand: () => lastShellCommand,
    lastUploadBody: () => lastUploadBody,
    lastBrowserTabBody: () => lastBrowserTabBody,
    close: async () => {
      for (const socket of upgraded) socket.destroy();
      upgraded.clear();
      server.closeAllConnections?.();
      await withTimeout(new Promise<void>((resolve) => server.close(() => resolve())), 3000);
    },
  };
}

export interface ScriptedTurn {
  turnId: string;
  threadId: string;
  notifications?: Array<{ method: string; params: Record<string, unknown> }>;
  status?: string;
  /** When true, the turn never completes until `completeTurn` is called. */
  manual?: boolean;
}

/** Deterministic Codex double: records calls and replays scripted notifications. */
export class FakeCodex implements CodexSessionLike {
  ready = true;
  account: SandboxAccount | null = { email: "owner@example.com", planType: "prolite", type: "chatgpt" };
  lastError: string | null = null;
  startedThreads: Array<{ threadId: string; cwd?: string; model?: string }> = [];
  forkedThreads: Array<{ from: string; threadId: string; model?: string; modelProvider?: string }> = [];
  /** Provider each created/forked thread runs on (null = ChatGPT account). */
  threadProviders = new Map<string, string | null>();
  startedTurns: Array<{
    threadId: string;
    turnId: string;
    text: string;
    model?: string | null;
    /** Reasoning effort the turn was started with, when one was sent. */
    effort?: string | null;
    attachments?: Array<{ path: string; kind: string }>;
  }> = [];
  /** Summary mode passed on the most recent main turn. */
  lastStartTurnSummary: string | null | undefined = undefined;
  interrupted: Array<{ threadId: string; turnId: string }> = [];
  answers: Array<{ id: string; result: unknown }> = [];
  resumedThreads: string[] = [];
  #notificationHandler: ((method: string, params: unknown) => void) | null = null;
  #serverRequestHandler: ((id: string, method: string, params: unknown) => void) | null = null;
  #closedHandler: ((reason: string) => void) | null = null;
  #threadSeq = 0;
  #turnSeq = 0;
  #manualTurns = new Map<string, { threadId: string; resolve: () => void }>();
  /** Set to make startThread fail. */
  failStart = false;
  /** Scripted automatic-title behavior. */
  titleResult: string | null = "自动标题";
  /** When set, the title is derived from the input (to distinguish conversations). */
  titleResultFor: ((userText: string) => string | null) | null = null;
  titleCalls: string[] = [];
  failTitle = false;
  titleDelayMs = 0;
  /** When set, `startTurn` waits for it to resolve before returning a turn id. */
  startTurnGate: Promise<void> | null = null;

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#notificationHandler = handler;
  }

  onServerRequest(handler: (id: string, method: string, params: unknown) => void): void {
    this.#serverRequestHandler = handler;
  }

  onClosed(handler: (reason: string) => void): void {
    this.#closedHandler = handler;
  }

  /** Simulate the sandbox Codex process dying mid-turn. */
  emitClosed(reason = "exit code=1 signal=null"): void {
    this.ready = false;
    this.#closedHandler?.(reason);
  }

  async start(): Promise<void> {}

  async listModels(): Promise<CodexModel[]> {
    // Mirrors the real CLI: its own default is not the model this app runs.
    return [
      {
        id: "gpt-6-sol",
        model: "gpt-6-sol",
        displayName: "GPT-6-Sol",
        description: "test model",
        isDefault: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "test model",
        isDefault: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
      },
    ];
  }

  async startThread(opts: { cwd?: string; model?: string; modelProvider?: string }): Promise<{
    threadId: string;
    model: string;
    cwd: string;
    modelProvider: string | null;
  }> {
    if (this.failStart) throw new Error("thread start failed");
    const threadId = `thread_${++this.#threadSeq}`;
    this.startedThreads.push({ threadId, cwd: opts.cwd, model: opts.model });
    this.threadProviders.set(threadId, opts.modelProvider ?? null);
    return {
      threadId,
      model: opts.model ?? "gpt-5.5",
      cwd: opts.cwd ?? "/home/gem/workspace",
      modelProvider: opts.modelProvider ?? null,
    };
  }

  async forkThread(
    threadId: string,
    opts: { model?: string; modelProvider?: string; cwd?: string },
  ): Promise<{ threadId: string; model: string; cwd: string; modelProvider: string | null }> {
    const forkedId = `thread_${++this.#threadSeq}`;
    this.forkedThreads.push({ from: threadId, threadId: forkedId, model: opts.model, modelProvider: opts.modelProvider });
    this.threadProviders.set(forkedId, opts.modelProvider ?? null);
    return {
      threadId: forkedId,
      model: opts.model ?? "gpt-5.5",
      cwd: opts.cwd ?? "/home/gem/workspace",
      modelProvider: opts.modelProvider ?? null,
    };
  }

  async resumeThread(threadId: string): Promise<void> {
    this.resumedThreads.push(threadId);
  }

  async startTurn(params: {
    threadId: string;
    text: string;
    attachments?: Array<{ path: string; kind: "image" | "file"; name?: string }>;
    model?: string | null;
    effort?: string | null;
    clientUserMessageId?: string | null;
    summary?: "none" | "auto" | "concise" | "detailed" | null;
  }): Promise<string> {
    const turnId = `turn_${++this.#turnSeq}`;
    this.lastStartTurnSummary = params.summary;
    this.startedTurns.push({
      threadId: params.threadId,
      turnId,
      text: params.text,
      model: params.model,
      effort: params.effort,
      attachments: params.attachments,
    });
    if (this.startTurnGate) await this.startTurnGate;
    if (this.#manualTurns.has(params.threadId)) return turnId;
    return turnId;
  }

  /** Emit a scripted run for the most recent turn. */
  async runTurn(turnId: string, opts: { text?: string; status?: string } = {}): Promise<void> {
    const text = opts.text ?? "hello";
    const threadId = this.#threadForTurn(turnId);
    this.#notificationHandler?.("item/started", { threadId, turnId, item: { id: "i1", type: "agentMessage" } });
    this.#notificationHandler?.("item/agentMessage/delta", { threadId, turnId, itemId: "i1", delta: text.slice(0, 3) });
    this.#notificationHandler?.("item/agentMessage/delta", { threadId, turnId, itemId: "i1", delta: text.slice(3) });
    this.#notificationHandler?.("item/completed", { threadId, turnId, item: { id: "i1", type: "agentMessage", text } });
    this.completeTurn(turnId, opts.status ?? "completed");
  }

  #threadForTurn(turnId: string): string {
    return this.startedTurns.find((t) => t.turnId === turnId)?.threadId ?? "t";
  }

  /** Emit an arbitrary Codex notification to the manager. */
  emitNotification(method: string, params: Record<string, unknown>): void {
    this.#notificationHandler?.(method, params);
  }

  completeTurn(turnId: string, status = "completed"): void {
    this.#notificationHandler?.("turn/completed", { threadId: this.#threadForTurn(turnId), turn: { id: turnId, status } });
  }

  /** Hold a turn open until the test releases it (simulates a long-running agent). */
  holdTurn(threadId: string): void {
    this.#manualTurns.set(threadId, { threadId, resolve: () => undefined });
  }

  releaseTurn(threadId: string): void {
    const entry = this.#manualTurns.get(threadId);
    if (entry) {
      this.#manualTurns.delete(threadId);
      entry.resolve();
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId });
  }

  async generateTitle(userText: string): Promise<string | null> {
    this.titleCalls.push(userText);
    if (this.titleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.titleDelayMs));
    if (this.failTitle) throw new Error("title generation failed");
    if (this.titleResultFor) return this.titleResultFor(userText);
    return this.titleResult;
  }

  answer(id: string, result: unknown): boolean {
    this.answers.push({ id, result });
    return true;
  }

  close(): void {}

  emitServerRequest(id: string, method: string, params: Record<string, unknown>): void {
    this.#serverRequestHandler?.(id, method, params);
  }
}

export interface TestResponse {
  status: number;
  headers: {
    get(name: string): string | null;
    getSetCookie(): string[];
  };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface TestHarness {
  ctx: AppContext;
  server: http.Server;
  baseUrl: string;
  primaryPort: number;
  sandbox: FakeSandbox;
  codex: FakeCodex;
  dataDir: string;
  shutdown: () => Promise<void>;
  request: (
    pathname: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      host?: "primary" | "workspace";
      /** Escape hatch for Host-spoofing tests. */
      hostHeader?: string;
    },
  ) => Promise<TestResponse>;
}

/**
 * Raw client instead of fetch: `fetch` refuses to set the Host header, and Host
 * routing is exactly what this suite needs to exercise.
 */
function rawRequest(
  port: number,
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: pathname,
        headers: opts.headers ?? {},
        // No keep-alive: otherwise server.close() waits for idle sockets.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const rawSetCookie = (res.headers["set-cookie"] ?? []) as string[];
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (name: string) => {
                const value = res.headers[name.toLowerCase()];
                if (value === undefined) return null;
                return Array.isArray(value) ? (value[0] ?? null) : String(value);
              },
              getSetCookie: () => rawSetCookie,
            },
            json: async () => JSON.parse(body.toString("utf8") || "{}"),
            text: async () => body.toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function testConfig(dataDir: string, sandboxPort: number, extra: Record<string, string> = {}): Config {
  const env: Record<string, string> = {
    PA_PORT: "0",
    PA_BIND: "127.0.0.1",
    PA_DATA_DIR: dataDir,
    PA_DB_PATH: path.join(dataDir, "test.sqlite"),
    PA_OWNER_SECRET_PATH: path.join(dataDir, "owner-secret.txt"),
    PA_SANDBOX_PORT: String(sandboxPort),
    PA_SANDBOX_AUTOSTART: "0",
    PA_FILE_OP_TIMEOUT_SECONDS: "1",
    PA_OWNER_PASSWORD: "correct horse battery staple",
    PA_LOG_LEVEL: "error",
    ...extra,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return loadConfig();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export async function startHarness(extraEnv: Record<string, string> = {}): Promise<TestHarness> {
  const sandbox = await startFakeSandbox();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-agent-test-"));
  const cfg = testConfig(dataDir, sandbox.port, extraEnv);
  const codex = new FakeCodex();
  const containerStub = {
    name: cfg.sandbox.containerName,
    isReady: async () => true,
    inspect: async () => ({
      exists: true,
      running: true,
      healthy: true,
      image: cfg.sandbox.image,
      startedAt: null,
      managedLabel: "1",
      mounts: [],
    }),
  } as unknown as SandboxContainer;

  const log = new Logger("error", undefined, false);
  const { ctx, shutdown } = await bootstrap({ config: cfg, log, overrides: { codex, container: containerStub } });
  const app = createApp(ctx);
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => handleUpgrade(ctx, req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  // The config was built before we knew the ephemeral port; register it now so
  // Host/Origin validation exercises the same code path as production.
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
    if (!cfg.allowedHosts.includes(host)) cfg.allowedHosts.push(host);
  }
  for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
    if (!cfg.primaryOrigins.includes(origin)) cfg.primaryOrigins.push(origin);
  }
  if (!cfg.workspaceOrigins.includes(`http://127.0.0.1:${port}`)) cfg.workspaceOrigins.push(`http://127.0.0.1:${port}`);

  const request: TestHarness["request"] = (pathname, init = {}) => {
    const { host = "primary", hostHeader, headers: rawHeaders = {}, method, body } = init;
    const headers: Record<string, string> = { ...rawHeaders };
    const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    headers.Host = hostHeader ?? (host === "primary" ? `localhost:${port}` : `127.0.0.1:${port}`);
    if (!lower.has("origin")) {
      headers.Origin = host === "primary" ? `http://localhost:${port}` : `http://127.0.0.1:${port}`;
    }
    return rawRequest(port, pathname, { method, headers, body });
  };

  return {
    ctx,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    primaryPort: port,
    sandbox,
    codex,
    dataDir,
    shutdown: async () => {
      // Bound every cleanup step so a stuck socket cannot hang the suite.
      server.closeAllConnections();
      await withTimeout(new Promise<void>((resolve) => server.close(() => resolve())), 3000);
      await withTimeout(shutdown(), 3000);
      await sandbox.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    request,
  };
}

/** Open a raw TCP connection and send a WebSocket upgrade request. */
export function rawUpgrade(port: number, pathname: string, headers: Record<string, string>): Promise<{ statusLine: string; data: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("\r\n\r\n")) {
        const [head, ...rest] = buffer.split("\r\n\r\n");
        resolve({ statusLine: head.split("\r\n")[0], data: rest.join("\r\n\r\n") });
        socket.destroy();
      }
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve({ statusLine: buffer.split("\r\n")[0] ?? "", data: "" });
    }, 1500).unref?.();
  });
}

export async function login(h: TestHarness, password = "correct horse battery staple"): Promise<{ cookie: string; csrf: string }> {
  // Tests share one loopback IP; clear any lockout from a rate-limit test.
  h.ctx.db.prepare("DELETE FROM login_failures").run();
  const res = await h.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const csrf = /pa_csrf=([^;]+)/.exec(setCookie.join(";"))?.[1] ?? "";
  return { cookie, csrf: decodeURIComponent(csrf) };
}
