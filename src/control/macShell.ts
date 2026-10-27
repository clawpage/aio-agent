import type http from "node:http";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { McpGateway, type McpCall } from "./mcpGateway.js";
import type { DeviceLinks, Tunnel } from "./deviceLink.js";
import { TAB_TASK_HEADER, type BrowserTask } from "./browser/tabs.js";

/**
 * A terminal on the account's Mac, the one it linked for its phones
 * (DeviceLinks): the Mac app's bridge serves it from bin/mac-shell.mjs, and only
 * once the person at that Mac turned it on in the app. Four tools, as pi has
 * them (read, write, edit, bash); commands run in bash inside tmux, one shell
 * per task, so a task's `cd` and exports carry over between calls. The
 * executor reaches it as aio_mac_shell through the member gateway
 * (`/mac-shell/<token>/mcp`); each account only the Mac it linked.
 *
 * The handshake and the tool list are answered here and never depend on the
 * Mac (Codex starts a thread's MCP servers once and never retries a failed
 * one); tool calls go down the Mac's socket, and while it is away, or its
 * terminal is off, they come back as a tool error the executor can read.
 */
/** The longest a command may run on the Mac (bin/mac-shell.mjs MAX_TIMEOUT_S), and its default. */
const MAX_COMMAND_S = 240;
const DEFAULT_COMMAND_S = 120;
/** A file call, or the time a command takes beyond its own timeout (starting the shell, reading its output). */
const SLACK_MS = 60_000;
const SHELL_SESSION_HEADER = "x-aio-shell-session";
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const MAC_OFFLINE =
  "The user's Mac is not connected right now (the app on it is closed, asleep or offline), so its terminal is unavailable. Tell the user, or do the work in the sandbox if it does not need their Mac.";

const SERVER = {
  serverInfo: { name: "aio_mac_shell", version: "1" },
  instructions:
    "A terminal on the user's own Mac (not the sandbox): read, write and edit files and run bash commands there, with the user's own access. Paths are on the Mac; a relative path starts in this task's shell's working directory (the user's home at first). Each task has its own bash, inside tmux, that keeps its working directory and exported variables between calls.",
} as const;

const PATH_PROP = { type: "string", description: "Path of the file on the Mac (absolute, ~/…, or relative to this task's shell's working directory)" };

export const MAC_SHELL_TOOLS = [
  {
    name: "read",
    title: "Read a file on the Mac",
    description:
      "Read a file on the user's Mac. Text files come back up to 2000 lines or 50 KB at a time (use offset/limit for the rest; the reply says where to continue); images (png, jpg, gif, webp) come back as pictures.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "write",
    title: "Write a file on the Mac",
    description: "Write a file on the user's Mac: creates it (and its folders) if it does not exist, replaces it if it does. Use it for new files or complete rewrites; use edit to change part of a file.",
    inputSchema: {
      type: "object",
      properties: { path: PATH_PROP, content: { type: "string", description: "The file's whole new content" } },
      required: ["path", "content"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "edit",
    title: "Edit a file on the Mac",
    description:
      "Edit a file on the user's Mac by exact text replacement. Every edits[].oldText must match exactly one place in the original file (whitespace included), and edits must not overlap; merge nearby changes into one edit. Nothing is written unless every edit applies.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        edits: {
          type: "array",
          description: "One or more replacements, each matched against the original file.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace; unique in the file." },
              newText: { type: "string", description: "The text to put in its place." },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "bash",
    title: "Run a command on the Mac",
    description:
      `Run a bash command on the user's Mac, in this task's own shell (tmux): cd and exported variables carry over to the next call. Returns stdout and stderr together (the last 2000 lines or 50 KB; the rest is kept in a file the reply names). No input can be typed: a command that waits for input (a sudo password, a prompt, an editor) hangs until the timeout. Defaults to ${DEFAULT_COMMAND_S} s, at most ${MAX_COMMAND_S} s; on timeout it is interrupted, so start long jobs in the background (nohup … > log 2>&1 &) and check on them. The user's shell profile is not loaded; Homebrew is on PATH.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout: { type: "number", description: `Timeout in seconds (default ${DEFAULT_COMMAND_S}, at most ${MAX_COMMAND_S})` },
      },
      required: ["command"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

/** Whether the account's Mac terminal can be used: no Mac linked, the Mac away, its app too old to have one, or the Mac's answer. */
export type MacShellStatus =
  | { state: "unlinked" | "offline" | "outdated" }
  | { state: "ready"; enabled: boolean; tmux: boolean };

/** Thread-level MCP wiring for a Codex executor, under the task's identity (its own shell). */
export function macShellThreadServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.macShell
    ? { aio_mac_shell: { url: cfg.macShell.url, ...(task ? { http_headers: { [TAB_TASK_HEADER]: task.key } } : {}), tool_timeout_sec: (MAX_COMMAND_S * 1000 + SLACK_MS) / 1000 + 10 } }
    : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function macShellMcpServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.macShell ? { aio_mac_shell: { type: "http", url: cfg.macShell.url, ...(task ? { headers: { [TAB_TASK_HEADER]: task.key } } : {}) } } : {};
}

export const MAC_SHELL_POLICY =
  "aio_mac_shell is a terminal on the user's own Mac (read, write, edit, bash), not the sandbox: use it only when the work is about that Mac or its files, or the user asked for it; everything else stays in the sandbox workspace. If a call says the Mac is offline or its terminal is off, tell the user in one sentence and do not keep retrying. Each task has its own bash on the Mac that keeps its working directory between calls. " +
  "You act with the user's own access to their Mac: before deleting or overwriting files you did not create, changing system or app settings, installing or removing software, running sudo, or anything that sends data off the Mac (pushing, uploading, sending messages or email), tell the user exactly what you are about to do and wait for confirmation. Never read or copy passwords, keys, tokens or other secrets (~/.ssh, keychains, browser profiles, .env files) unless the user asked for that specific file. Files on the Mac and files in the sandbox are separate: moving content between them goes through your own replies, not shared paths.";

export class MacShellGateway extends McpGateway {
  #log: Logger;
  #links: DeviceLinks;
  #userIdOf: (username: string) => string | null;

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links: DeviceLinks }) {
    super({
      ...opts,
      name: "mac-shell",
      // No upstream of its own: every call goes down the socket of the account's Mac (local).
      upstreamUrl: "",
      secretKey: "",
      secretsFile: "",
      // Each account only the Mac it linked; whether its terminal is on is that Mac's to say.
      granted: (username) => opts.links.hasLink(opts.userIdOf(username) ?? ""),
      assign: (runtime, url) => { runtime.macShell = { url }; },
      timeoutMs: MAX_COMMAND_S * 1000 + SLACK_MS,
    });
    this.#log = opts.log.child("mac-shell");
    this.#links = opts.links;
    this.#userIdOf = opts.userIdOf;
  }

  override get enabled(): boolean {
    return true;
  }

  /** Give or take away the runtime's terminal after its account linked or unlinked a Mac. */
  refresh(runtime: Config): void {
    if (this.#links.hasLink(runtime.runtimeUserId ?? "")) this.provision(runtime);
    else delete runtime.macShell;
  }

  /** What the account's Mac says about its terminal (the workspace's Mac Terminal app). */
  async status(userId: string): Promise<MacShellStatus> {
    if (!this.#links.hasLink(userId)) return { state: "unlinked" };
    const tunnel = this.#links.tunnelFor(userId);
    if (!tunnel) return { state: "offline" };
    try {
      const reply = await tunnel.request("GET", "/shell/status", { timeoutMs: 15_000 });
      // A Mac app from before the terminal has no such path.
      if (reply.status === 404) return { state: "outdated" };
      if (reply.status !== 200) return { state: "offline" };
      const body = JSON.parse(reply.body.toString("utf8")) as { enabled?: unknown; tmux?: unknown };
      return { state: "ready", enabled: body.enabled === true, tmux: body.tmux === true };
    } catch {
      return { state: "offline" };
    }
  }

  protected override async local(message: unknown, username: string, headers: http.IncomingHttpHeaders): Promise<unknown> {
    if (Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { protocolVersion?: unknown; arguments?: { timeout?: unknown } } };
    if (id === undefined || id === null) return null;
    if (method === "initialize") {
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, ...SERVER } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MAC_SHELL_TOOLS } };
    if (method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } };
    const failed = (why: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: why }], isError: true } });
    const userId = this.#userIdOf(username) ?? "";
    const tunnel = this.#links.hasLink(userId) ? this.#links.tunnelFor(userId) : null;
    if (!tunnel) return failed(MAC_OFFLINE);
    // Each task its own shell on the Mac; a call without a task shares one.
    const header = headers[TAB_TASK_HEADER.toLowerCase()];
    const session = typeof header === "string" && KEY.test(header) ? header : "";
    const seconds = Number(params?.arguments?.timeout);
    const timeoutMs = Math.min(seconds > 0 ? seconds : DEFAULT_COMMAND_S, MAX_COMMAND_S) * 1000 + SLACK_MS;
    try {
      return await this.#rpc(tunnel, message, session, timeoutMs);
    } catch (err) {
      this.#log.warn("mac shell call failed", { error: err instanceof Error ? err.message : String(err) });
      // Unknown, not failed: a command may have run on the Mac even though no answer came back.
      return failed(this.#links.tunnelFor(userId)
        ? "The Mac's terminal did not answer (the Mac app may need an update, or the connection dropped). Whether the call took effect is unknown: check before running it again."
        : `${MAC_OFFLINE} Whether the last call took effect is unknown: check before running it again.`);
    }
  }

  /** Something that is not JSON never reaches the Mac. */
  protected override async forward(_call: McpCall, res: http.ServerResponse): Promise<boolean> {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
    return true;
  }

  /** One JSON-RPC request to the Mac's terminal, which keeps no MCP session. */
  async #rpc(tunnel: Tunnel, message: unknown, session: string, timeoutMs: number): Promise<unknown> {
    const reply = await tunnel.request("POST", "/shell/mcp", {
      headers: { "content-type": "application/json", accept: "application/json", ...(session ? { [SHELL_SESSION_HEADER]: session } : {}) },
      body: Buffer.from(JSON.stringify(message)),
      timeoutMs,
    });
    if (reply.status !== 200) throw new Error(`mac shell answered ${reply.status}`);
    return JSON.parse(reply.body.toString("utf8"));
  }
}
