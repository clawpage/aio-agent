import type http from "node:http";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { McpGateway, type McpCall } from "./mcpGateway.js";
import type { DeviceLinks } from "./deviceLink.js";
import { TAB_TASK_HEADER, TAB_TOOL_TIMEOUT_SEC, type BrowserTask } from "./browser/tabs.js";
import type { PhoneGateway } from "./phone.js";
import { PHONE_SERVER } from "./phoneTools.js";
import { USER_BROWSER_INSTRUCTIONS, type UserBrowserGateway } from "./userBrowser.js";
import { MAC_SHELL_INSTRUCTIONS, MAC_SHELL_TOOLS, MAX_COMMAND_S, SLACK_MS, type MacShellGateway } from "./macShell.js";

/**
 * Everything on the account's Mac (the one it linked, DeviceLinks) as one MCP
 * server, aio_mac_native: the phone plugged into it (PhoneGateway, mobile_*
 * tools), the AI's Chrome on it (UserBrowserGateway: list_pages, click, …,
 * request_human) and its terminal (MacShellGateway: read, write, edit, bash).
 * The executor reaches it through the member gateway (`/mac-native/<token>/mcp`);
 * each account only the Mac it linked. A call goes to the part its tool belongs to.
 *
 * The handshake and the tool list never depend on the Mac (Codex starts a
 * thread's MCP servers once and never retries a failed one); while the Mac is
 * away each part lists its recorded tools and its calls come back as tool errors.
 */
const SHELL_TOOLS = new Set(MAC_SHELL_TOOLS.map((t) => t.name));

const SERVER = {
  serverInfo: { name: "aio_mac_native", version: "1" },
  instructions: [
    "The user's own Mac (not the sandbox), in three parts:",
    `- Phone (mobile_* tools): the Android phone plugged into the Mac by USB. ${PHONE_SERVER.instructions}`,
    `- Browser (list_pages, new_page, take_snapshot, click, …, request_human): ${USER_BROWSER_INSTRUCTIONS}`,
    `- Terminal (read, write, edit, bash): ${MAC_SHELL_INSTRUCTIONS}`,
  ].join("\n\n"),
} as const;

/** The longest any part may take: the browser's request_human waits for the person. */
const TIMEOUT_SEC = Math.max(TAB_TOOL_TIMEOUT_SEC, (MAX_COMMAND_S * 1000 + SLACK_MS) / 1000 + 10);

/** Thread-level MCP wiring for a Codex executor, under the task's identity (its page and its shell). */
export function macNativeThreadServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.macNative
    ? { aio_mac_native: { url: cfg.macNative.url, ...(task ? { http_headers: { [TAB_TASK_HEADER]: task.key } } : {}), tool_timeout_sec: TIMEOUT_SEC } }
    : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function macNativeMcpServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.macNative ? { aio_mac_native: { type: "http", url: cfg.macNative.url, ...(task ? { headers: { [TAB_TASK_HEADER]: task.key } } : {}) } } : {};
}

export class MacNativeGateway extends McpGateway {
  #phone: PhoneGateway;
  #browser: UserBrowserGateway;
  #shell: MacShellGateway;
  #links: DeviceLinks;

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links: DeviceLinks; phone: PhoneGateway; browser: UserBrowserGateway; shell: MacShellGateway }) {
    super({
      ...opts,
      name: "mac-native",
      // No upstream of its own: every call goes down the socket of the account's Mac (local).
      upstreamUrl: "",
      secretKey: "",
      secretsFile: "",
      // Each account only the Mac it linked; whether its terminal is on is that Mac's to say.
      granted: (username) => opts.links.hasLink(opts.userIdOf(username) ?? ""),
      assign: (runtime, url) => { runtime.macNative = { url }; },
      timeoutMs: TIMEOUT_SEC * 1000,
    });
    this.#phone = opts.phone;
    this.#browser = opts.browser;
    this.#shell = opts.shell;
    this.#links = opts.links;
  }

  override get enabled(): boolean {
    return true;
  }

  /** Give or take away the runtime's Mac tools after its account linked or unlinked a Mac. */
  refresh(runtime: Config): void {
    if (this.#links.hasLink(runtime.runtimeUserId ?? "")) this.provision(runtime);
    else delete runtime.macNative;
  }

  protected override async local(message: unknown, username: string, headers: http.IncomingHttpHeaders): Promise<unknown> {
    if (Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { protocolVersion?: unknown; name?: unknown } };
    // Notifications (initialized, cancelled) have nothing to answer.
    if (id === undefined || id === null) return null;
    if (method === "initialize") {
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, ...SERVER } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") {
      const parts = await Promise.all([this.#phone.answer(message, username), this.#browser.answer(message, username, headers), this.#shell.answer(message, username, headers)]);
      return { jsonrpc: "2.0", id, result: { tools: parts.flatMap((p) => (p as { result?: { tools?: unknown[] } }).result?.tools ?? []) } };
    }
    if (method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } };
    const tool = typeof params?.name === "string" ? params.name : "";
    if (tool.startsWith("mobile_")) return this.#phone.answer(message, username);
    if (SHELL_TOOLS.has(tool)) return this.#shell.answer(message, username, headers);
    return this.#browser.answer(message, username, headers);
  }

  /** Something that is not JSON never reaches the Mac. */
  protected override async forward(_call: McpCall, res: http.ServerResponse): Promise<boolean> {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
    return true;
  }
}
