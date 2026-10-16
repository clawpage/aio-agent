import type http from "node:http";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { McpGateway, type McpCall } from "./mcpGateway.js";
import type { DeviceLinks } from "./deviceLink.js";
import { USER_BROWSER_TOOLS } from "./userBrowserTools.js";

/**
 * An account's own Chrome, on the Mac it linked for its phones (DeviceLinks):
 * the Mac app's bridge serves it from bin/user-browser.mjs. It sits next to the
 * sandbox browser (aio_tabs), never in its place: the executor reaches it as
 * aio_user_browser through the member gateway (`/user-browser/<token>/mcp`),
 * prefers it, and falls back to aio_tabs whenever the Mac or its Chrome is not
 * there. Each account reaches only the Chrome on a Mac it linked.
 */
const TIMEOUT_MS = 110_000;
const MAC_OFFLINE =
  "The user's Mac is not connected right now (the app on it is closed, asleep or offline), so their own Chrome is unavailable. Use the sandbox browser (aio_tabs) for this task instead.";

const SERVER = {
  serverInfo: { name: "aio_user_browser", version: "1" },
  instructions:
    "The user's own Google Chrome on their Mac: their open tabs and signed-in accounts, on the screen in front of them. This is not the sandbox browser (aio_tabs). Start with list_pages; when a call reports that the user's browser is unavailable, use aio_tabs instead. Open your own pages with new_page and pass their pageId on every call.",
} as const;

/** Thread-level MCP wiring for a Codex executor. */
export function userBrowserThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.userBrowser ? { aio_user_browser: { url: cfg.userBrowser.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 10 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function userBrowserMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.userBrowser ? { aio_user_browser: { type: "http", url: cfg.userBrowser.url } } : {};
}

export const USER_BROWSER_POLICY =
  "Two browsers are available: aio_user_browser is the user's own Google Chrome on their Mac (their open tabs and signed-in accounts; the user sees everything you do there), and aio_tabs is the sandbox browser in the cloud. For browser work, use the user's Chrome first: begin with its list_pages; if that or a later call says the user's browser is unavailable, switch to aio_tabs for the rest of this task without asking, and mention the switch in one sentence in your reply. Use aio_tabs from the start only when the work needs files from the workspace (uploading or downloading) or the user asked for the sandbox browser. " +
  "In the user's Chrome: open the pages you work in with new_page and pass their pageId on every call; do not navigate, type into or close tabs the user already had open unless the user asked about that tab; close the pages you opened once you no longer need them, unless the user should look at the result. Prefer take_snapshot to read a page and act on its uids; take a screenshot only for what the snapshot does not show. browser_login and browser_request_human exist only in aio_tabs: in the user's Chrome the user is usually signed in already; when a site asks for a password, a CAPTCHA, two-factor verification or payment details, stop and ask the user to do that step in their Chrome, then read the page again after they reply. " +
  "For steps with external effects or that are hard to undo, such as paying, placing orders, sending messages or posts, deleting content, or changing account or security settings, first tell the user what you are about to do and wait for confirmation. Files on the Mac are not reachable: never pass file paths.";

export class UserBrowserGateway extends McpGateway {
  #log: Logger;
  #links: DeviceLinks;
  #userIdOf: (username: string) => string | null;

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links: DeviceLinks }) {
    super({
      ...opts,
      name: "user-browser",
      // No upstream of its own: every call goes down the socket of the account's Mac (local).
      upstreamUrl: "",
      secretKey: "",
      secretsFile: "",
      // Each account only its own Chrome: one on a Mac it linked.
      granted: (username) => opts.links.hasLink(opts.userIdOf(username) ?? ""),
      assign: (runtime, url) => { runtime.userBrowser = { url }; },
      timeoutMs: TIMEOUT_MS,
    });
    this.#log = opts.log.child("user-browser");
    this.#links = opts.links;
    this.#userIdOf = opts.userIdOf;
  }

  override get enabled(): boolean {
    return true;
  }

  /** Give or take away the runtime's browser tools after its account linked or unlinked a Mac. */
  refresh(runtime: Config): void {
    if (this.#links.hasLink(runtime.runtimeUserId ?? "")) this.provision(runtime);
    else delete runtime.userBrowser;
  }

  /**
   * The handshake and the tool list never depend on the Mac (Codex starts a
   * thread's MCP servers once and never retries a failed one); only tool calls
   * go down to it, and while it is offline they come back as a tool error that
   * sends the executor to the sandbox browser.
   */
  protected override async local(message: unknown, username: string): Promise<unknown> {
    if (Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { protocolVersion?: unknown } };
    if (id === undefined || id === null) return null;
    if (method === "initialize") {
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, ...SERVER } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    const userId = this.#userIdOf(username) ?? "";
    const tunnel = this.#links.hasLink(userId) ? this.#links.tunnelFor(userId) : null;
    if (method === "tools/list") {
      if (tunnel) {
        try {
          const live = (await this.#rpc(tunnel, message)) as { result?: { tools?: unknown[] } };
          if (Array.isArray(live?.result?.tools)) return live;
        } catch (err) {
          this.#log.warn("browser tool list from the Mac failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { jsonrpc: "2.0", id, result: { tools: USER_BROWSER_TOOLS } };
    }
    const failed = (why: string) => method === "tools/call"
      ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: why }], isError: true } }
      : { jsonrpc: "2.0", id, error: { code: -32000, message: why } };
    if (!tunnel) return failed(MAC_OFFLINE);
    try {
      return await this.#rpc(tunnel, message);
    } catch (err) {
      this.#log.warn("browser call failed", { error: err instanceof Error ? err.message : String(err) });
      return failed(this.#links.tunnelFor(userId)
        ? "The browser bridge on the user's Mac did not answer (the Mac app may need an update). Use the sandbox browser (aio_tabs) for this task instead."
        : MAC_OFFLINE);
    }
  }

  /** Something that is not JSON never reaches the Mac. */
  protected override async forward(_call: McpCall, res: http.ServerResponse): Promise<boolean> {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
    return true;
  }

  /** One JSON-RPC request to the Mac's browser bridge, which keeps the MCP session itself. */
  async #rpc(tunnel: NonNullable<ReturnType<DeviceLinks["tunnelFor"]>>, message: unknown): Promise<unknown> {
    const reply = await tunnel.request("POST", "/browser/mcp", {
      headers: { "content-type": "application/json", accept: "application/json" },
      body: Buffer.from(JSON.stringify(message)),
      timeoutMs: TIMEOUT_MS,
    });
    if (reply.status !== 200) throw new Error(`browser bridge answered ${reply.status}`);
    return JSON.parse(reply.body.toString("utf8"));
  }
}
