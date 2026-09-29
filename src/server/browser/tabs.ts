import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SandboxContainer } from "../docker/sandbox.js";
import { redact, type BrowserRuntime } from "./runtime.js";
import type { BrowserRuntimeLike } from "./lifecycle.js";

/** Loopback MCP endpoint of the tab server inside every sandbox. */
export const TAB_SERVER_PORT = 8190;
export const TAB_SERVER_URL = `http://127.0.0.1:${TAB_SERVER_PORT}/mcp`;
/** Header that names the task (its execution conversation) on every tool call. */
export const TAB_TASK_HEADER = "X-AIO-Task";
/** Percent-encoded task title, recorded against every tab the task creates. */
export const TAB_TASK_TITLE_HEADER = "X-AIO-Task-Title";

/** The task an execution thread works for: tabs are recorded against it. */
export interface BrowserTask {
  key: string;
  title: string;
}

function taskHeaders(task: BrowserTask): Record<string, string> {
  return { [TAB_TASK_HEADER]: task.key, [TAB_TASK_TITLE_HEADER]: encodeURIComponent(task.title.slice(0, 120)) };
}
const SCRIPT_NAME = "tab-server.cjs";
const KEY = /^[A-Za-z0-9_-]{1,80}$/;

/** One tab as the control plane sees it (the tab server's ownership record). */
export interface TabRecord {
  id: string;
  key: string;
  title: string;
  url: string;
  createdAt: number;
  lastUsed: number;
  finishedAt: number | null;
  /** Who drives the tab right now: the task's agent, or a person who took it over. */
  holder: "ai" | "human";
  humanSince: number | null;
  /** The agent asked a person to act in this tab, and is waiting for it back. */
  request: { reason: string; at: number } | null;
}

/** A person's action goes to the tab they took over; `task` (its key) and `tab` narrow it to one. */
export interface PersonTarget {
  task?: string;
  tab?: string;
}
export type PersonResult = { status: number; body: Record<string, unknown> };

/** What the control plane needs from the tab server. */
export interface TabServerLike {
  ensure(): Promise<void>;
  /** A task's turn ended: its tabs stay (a follow-up continues on them) until destroyed on demand. */
  finish(key: string): Promise<void>;
  /** Destroy every finished task's tabs, e.g. before the browser is released for idleness. */
  prune(): Promise<void>;
  /** A task's tabs (or every recorded tab), with who controls each and any pending request for a person. */
  list(key?: string): Promise<TabRecord[]>;
  /** A person takes a task's tab (brought to the front, agents shut out) or hands it back. */
  control(key: string, tab: string, action: "take" | "release"): Promise<TabRecord | null>;
  /** A current preview of one of the task's tabs. */
  screenshot(key: string, tab: string): Promise<{ mimeType: string; data: string; url: string; title: string } | null>;
  /** Type text or press a key, for a person, into a tab they took over (the latest one unless `tab`/`task` name it). */
  input(input: PersonTarget & { text?: string; key?: string }): Promise<PersonResult>;
  /** Tap (x, y as 0..1 of the viewport), scroll or go back, for a person, in a tab they took over. */
  pointer(input: PersonTarget & { action: "click" | "scroll" | "back"; x?: number; y?: number; dy?: number }): Promise<PersonResult>;
}

/** An agent asking a person for help waits up to 30 minutes; the MCP clients must wait a bit longer. */
export const TAB_TOOL_TIMEOUT_SEC = 31 * 60;

/**
 * Per-thread MCP wiring for an execution thread: the tab-scoped server under
 * the task's own identity, and the global-page browser server switched off so
 * parallel tasks can never steer each other's tabs.
 */
export function tabThreadConfig(task: BrowserTask): Record<string, unknown> {
  return { mcp_servers: { aio_browser: { enabled: false }, aio_tabs: { url: TAB_SERVER_URL, http_headers: taskHeaders(task), tool_timeout_sec: TAB_TOOL_TIMEOUT_SEC } } };
}

/** The same wiring for a Claude Code turn (`--mcp-config`). */
export function tabMcpServers(task: BrowserTask): Record<string, unknown> {
  return { aio_tabs: { type: "http", url: TAB_SERVER_URL, headers: taskHeaders(task) } };
}

/** Appended to an execution thread's instructions: browser work goes through its own tabs. */
export const TAB_POLICY =
  "浏览器操作只使用 aio_tabs 工具：你只能操作本任务创建的标签页，其他任务的标签页只能只读查看，可与其他任务并行；不要使用 `aio browser` 命令行或 /v1/browser 接口，它们操作整个浏览器的当前页面，会打断并行任务。" +
  "遇到登录、验证码、二次验证、输入密码或支付信息、付款、下单、发送消息、修改账号设置等需要用户本人完成或不可撤销的最后一步，调用 browser_request_human 说明原因并等待用户交还，不要在对话里索要密码或验证码，也不要替用户完成付款或下单；交还后先读取页面确认状态再继续，结果不确定的操作不要自动重做。";

export function withTabPolicy(instructions: string): string {
  return instructions.trim() ? `${instructions.trimEnd()}\n\n${TAB_POLICY}` : TAB_POLICY;
}

/**
 * The browser is only released for idleness when no task, viewer or pin holds
 * it; finished tasks' tabs are destroyed right before that snapshot, so they are
 * never saved and later restored as tabs nobody owns.
 */
export function pruneBeforeSnapshot(runtime: BrowserRuntimeLike, tabs: TabServerLike): BrowserRuntimeLike {
  return {
    status: (opts) => runtime.status(opts),
    snapshot: async (opts) => {
      await tabs.prune().catch(() => undefined);
      return runtime.snapshot(opts);
    },
    stop: (opts) => runtime.stop(opts),
    wake: (opts) => runtime.wake(opts),
  };
}

/**
 * Keeps the tab server running inside the sandbox. The script lives in the
 * root-managed browser tool directory next to the vendored playwright-core, runs
 * as the sandbox user on loopback, and is restarted when its version changes.
 */
export class TabServer implements TabServerLike {
  #cfg: Config;
  #log: Logger;
  #container: SandboxContainer;
  #runtime: BrowserRuntime;
  #ensuring: Promise<void> | null = null;

  constructor(cfg: Config, log: Logger, container: SandboxContainer, runtime: BrowserRuntime) {
    this.#cfg = cfg;
    this.#log = log.child("browser-tabs");
    this.#container = container;
    this.#runtime = runtime;
  }

  #script(): { body: string; version: string } {
    const body = fs.readFileSync(path.join(import.meta.dirname, "scripts", SCRIPT_NAME), "utf8");
    return { body, version: createHash("sha256").update(body).digest("hex").slice(0, 16) };
  }

  get scriptPath(): string {
    return path.posix.join(this.#cfg.browser.toolDir, SCRIPT_NAME);
  }

  async #health(): Promise<{ version?: string; pid?: number } | null> {
    const res = await this.#container.execInSandbox(["curl", "-s", "-m", "3", `http://127.0.0.1:${TAB_SERVER_PORT}/healthz`], { timeoutMs: 10_000 });
    if (res.code !== 0) return null;
    try {
      return JSON.parse(res.stdout) as { version?: string; pid?: number };
    } catch {
      return null;
    }
  }

  /** Single-flight: provision the script if needed, then make sure the right version answers. */
  ensure(): Promise<void> {
    this.#ensuring ??= this.#doEnsure().finally(() => {
      this.#ensuring = null;
    });
    return this.#ensuring;
  }

  async #doEnsure(): Promise<void> {
    const { body, version } = this.#script();
    const health = await this.#health();
    if (health?.version === version) return;
    await this.#runtime.ensureScripts();
    await this.#container.writeFileInSandbox(this.scriptPath, body, { user: "root" });
    const chmod = await this.#container.execInSandbox(["chmod", "0755", this.scriptPath], { timeoutMs: 15_000, user: "root" });
    if (chmod.code !== 0) throw new Error(`无法安装浏览器标签页服务：${redact(chmod.stderr || chmod.stdout)}`);
    if (health?.pid) {
      // An older version is still listening: stop exactly that process before starting the new one.
      await this.#container.execInSandbox(["kill", String(health.pid)], { timeoutMs: 10_000 });
    }
    const started = await this.#container.execDetached(["sh", "-c", 'exec node "$1" >>/tmp/aio-tabs.log 2>&1', "sh", this.scriptPath], {
      env: {
        AIO_TABS_VERSION: version,
        AIO_TABS_PORT: String(TAB_SERVER_PORT),
        AIO_TABS_PLAYWRIGHT: path.posix.join(this.#cfg.browser.toolDir, "playwright-core"),
        AIO_TABS_OUTPUT: path.posix.join(this.#cfg.sandbox.containerWorkspaceDir, ".scratch", "artifacts", "browser"),
      },
    });
    if (started.code !== 0) throw new Error(`无法启动浏览器标签页服务：${redact(started.stderr || started.stdout)}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await this.#health())?.version === version) {
        this.#log.info("browser tab server running", { version });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("浏览器标签页服务启动后未在超时内就绪");
  }

  /** Best effort: a server that is gone has no tabs left to mark or close. */
  async #post(route: string, body: unknown): Promise<void> {
    const res = await this.#container.execInSandbox(
      ["curl", "-s", "-f", "-m", "20", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `http://127.0.0.1:${TAB_SERVER_PORT}${route}`],
      { timeoutMs: 25_000, stdin: JSON.stringify(body) },
    );
    if (res.code !== 0) this.#log.debug("tab server call skipped", { route, error: redact(res.stderr || res.stdout) });
  }

  async finish(key: string): Promise<void> {
    if (KEY.test(key)) await this.#post("/finish", { key });
  }

  async prune(): Promise<void> {
    await this.#post("/prune", {});
  }

  async #get<T>(route: string): Promise<T | null> {
    const res = await this.#container.execInSandbox(["curl", "-s", "-f", "-m", "20", `http://127.0.0.1:${TAB_SERVER_PORT}${route}`], { timeoutMs: 25_000 });
    if (res.code !== 0) return null;
    try {
      return JSON.parse(res.stdout) as T;
    } catch {
      return null;
    }
  }

  async list(key?: string): Promise<TabRecord[]> {
    if (key !== undefined && !KEY.test(key)) return [];
    return (await this.#get<{ tabs: TabRecord[] }>(key ? `/tabs?key=${key}` : "/tabs"))?.tabs ?? [];
  }

  async control(key: string, tab: string, action: "take" | "release"): Promise<TabRecord | null> {
    if (!KEY.test(key) || !/^t\d{1,9}$/.test(tab)) return null;
    const res = await this.#container.execInSandbox(
      ["curl", "-s", "-f", "-m", "20", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `http://127.0.0.1:${TAB_SERVER_PORT}/control`],
      { timeoutMs: 25_000, stdin: JSON.stringify({ key, tab, action }) },
    );
    if (res.code !== 0) return null;
    try {
      return (JSON.parse(res.stdout) as { tab: TabRecord }).tab;
    } catch {
      return null;
    }
  }

  async input(input: PersonTarget & { text?: string; key?: string }): Promise<PersonResult> {
    return this.#person("/input", input);
  }

  async pointer(input: PersonTarget & { action: "click" | "scroll" | "back"; x?: number; y?: number; dy?: number }): Promise<PersonResult> {
    return this.#person("/pointer", input);
  }

  async #person(route: "/input" | "/pointer", body: PersonTarget & object): Promise<PersonResult> {
    if ((body.task !== undefined && !KEY.test(body.task)) || (body.tab !== undefined && !/^t\d{1,9}$/.test(body.tab))) {
      return { status: 404, body: { error: "no_tab", message: "这个标签页已经关闭或不属于该任务" } };
    }
    // A person may act before any task turn has started the current server version.
    try {
      await this.ensure();
    } catch {
      return { status: 503, body: { error: "unavailable", message: "浏览器输入暂不可用，请稍后重试" } };
    }
    const res = await this.#container.execInSandbox(
      ["curl", "-s", "-m", "20", "-w", "\n%{http_code}", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `http://127.0.0.1:${TAB_SERVER_PORT}${route}`],
      { timeoutMs: 25_000, stdin: JSON.stringify(body) },
    );
    const cut = res.stdout.lastIndexOf("\n");
    const status = Number(res.stdout.slice(cut + 1));
    if (res.code !== 0 || !status) return { status: 503, body: { error: "unavailable", message: "浏览器输入暂不可用，请稍后重试" } };
    try {
      return { status, body: JSON.parse(res.stdout.slice(0, cut)) as Record<string, unknown> };
    } catch {
      return { status: 502, body: { error: "bad_response" } };
    }
  }

  async screenshot(key: string, tab: string): Promise<{ mimeType: string; data: string; url: string; title: string } | null> {
    if (!KEY.test(key) || !/^t\d{1,9}$/.test(tab)) return null;
    return await this.#get(`/screenshot?tab=${tab}&key=${key}`);
  }
}
