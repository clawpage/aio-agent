import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SandboxContainer } from "../docker/sandbox.js";
import { redact, type BrowserRuntime } from "./runtime.js";

/** Loopback MCP endpoint of the tab server inside every sandbox. */
export const TAB_SERVER_PORT = 8190;
export const TAB_SERVER_URL = `http://127.0.0.1:${TAB_SERVER_PORT}/mcp`;
/** Header that names the task (its execution conversation) on every tool call. */
export const TAB_TASK_HEADER = "X-AIO-Task";
const SCRIPT_NAME = "tab-server.cjs";
const KEY = /^[A-Za-z0-9_-]{1,80}$/;

/** What the agent manager needs: tab tools running, and a task's tabs closed when its turn ends. */
export interface TabServerLike {
  ensure(): Promise<void>;
  release(key: string): Promise<void>;
}

/**
 * Per-thread MCP wiring for an execution thread: the tab-scoped server under
 * the task's own identity, and the global-page browser server switched off so
 * parallel tasks can never steer each other's tabs.
 */
export function tabThreadConfig(key: string): Record<string, unknown> {
  return { mcp_servers: { aio_browser: { enabled: false }, aio_tabs: { url: TAB_SERVER_URL, http_headers: { [TAB_TASK_HEADER]: key } } } };
}

/** The same wiring for a Claude Code turn (`--mcp-config`). */
export function tabMcpServers(key: string): Record<string, unknown> {
  return { aio_tabs: { type: "http", url: TAB_SERVER_URL, headers: { [TAB_TASK_HEADER]: key } } };
}

/** Appended to an execution thread's instructions: browser work goes through its own tabs. */
export const TAB_POLICY =
  "浏览器操作只使用 aio_tabs 工具：每个任务有自己的标签页，可与其他任务并行；不要使用 `aio browser` 命令行或 /v1/browser 接口，它们操作整个浏览器的当前页面，会打断并行任务。";

export function withTabPolicy(instructions: string): string {
  return instructions.trim() ? `${instructions.trimEnd()}\n\n${TAB_POLICY}` : TAB_POLICY;
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

  /** Close a task's tabs. Best effort: a server that is gone has no tabs left to close. */
  async release(key: string): Promise<void> {
    if (!KEY.test(key)) return;
    const res = await this.#container.execInSandbox(
      ["curl", "-s", "-m", "10", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `http://127.0.0.1:${TAB_SERVER_PORT}/release`],
      { timeoutMs: 15_000, stdin: JSON.stringify({ key }) },
    );
    if (res.code !== 0) this.#log.debug("tab release skipped", { key, error: redact(res.stderr || res.stdout) });
  }
}
