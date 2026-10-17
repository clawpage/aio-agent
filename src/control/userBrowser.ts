import type http from "node:http";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import type { Db } from "./db.js";
import type { SessionStore } from "./auth/sessions.js";
import { getUser } from "./auth/owner.js";
import { resolveRequest } from "./http/security.js";
import { endSocket } from "./http/proxy.js";
import { McpGateway, type McpCall } from "./mcpGateway.js";
import type { DeviceLinks, Tunnel, TunnelChannel } from "./deviceLink.js";
import { TAB_TASK_HEADER, TAB_TOOL_TIMEOUT_SEC, type BrowserTask } from "./browser/tabs.js";
import { USER_BROWSER_TOOLS } from "./userBrowserTools.js";

/**
 * An account's own Chrome, on the Mac it linked for its phones (DeviceLinks):
 * the Mac app's bridge serves it from bin/user-browser.mjs. It sits next to the
 * sandbox browser (aio_tabs), never in its place: the executor reaches it as
 * aio_user_browser through the member gateway (`/user-browser/<token>/mcp`),
 * prefers it, and falls back to aio_tabs whenever the Mac or its Chrome is not
 * there. Each account reaches only the Chrome on a Mac it linked.
 *
 * Every call names its task (the execution conversation, as for aio_tabs), so the
 * gateway knows the page each task works in. The person sees that page on the
 * task's card (a picture, or live in the console) and can take it over: the
 * agent is then shut out of it until they hand it back, and an agent that asked
 * for them (request_human) continues when they do.
 */
const TIMEOUT_MS = 110_000;
/** An agent waiting for the person waits this long (aio_tabs waits the same). */
const HUMAN_WAIT_MS = 30 * 60_000;
export const USER_BROWSER_SCREEN_PATH = "/api/user-browser/screen";
const MAC_OFFLINE =
  "The user's Mac is not connected right now (the app on it is closed, asleep or offline), so their own Chrome is unavailable. Use the sandbox browser (aio_tabs) for this task instead.";
const TAKEN_OVER =
  "The user has taken over this task's page in their Chrome and is operating it now. Call request_human to wait until they hand it back; do not act on the page meanwhile.";

const SERVER = {
  serverInfo: { name: "aio_user_browser", version: "1" },
  instructions:
    "The user's own Google Chrome on their Mac: their open tabs and signed-in accounts, on the screen in front of them. This is not the sandbox browser (aio_tabs). Start with list_pages; when a call reports that the user's browser is unavailable, use aio_tabs instead. Open your own pages with new_page and pass their pageId on every call.",
} as const;

/** The gateway's own tool: wait for the person to do a step in the task's page. */
const REQUEST_HUMAN_TOOL = {
  name: "request_human",
  title: "Ask the user to act in their Chrome",
  description:
    "Ask the user to do a step themselves in the page this task works in (sign in, solve a CAPTCHA, two-factor verification, payment details, a final confirmation). The task card shows the request and the page; the user takes it over, does the step, and hands it back. This call waits until they do (up to 30 minutes); then read the page again before continuing.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", description: "What the user should do, in one short sentence in the user's language." } },
    required: ["reason"],
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
};

/** Thread-level MCP wiring for a Codex executor, under the task's identity. */
export function userBrowserThreadServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.userBrowser
    ? { aio_user_browser: { url: cfg.userBrowser.url, ...(task ? { http_headers: { [TAB_TASK_HEADER]: task.key } } : {}), tool_timeout_sec: TAB_TOOL_TIMEOUT_SEC } }
    : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function userBrowserMcpServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.userBrowser ? { aio_user_browser: { type: "http", url: cfg.userBrowser.url, ...(task ? { headers: { [TAB_TASK_HEADER]: task.key } } : {}) } } : {};
}

export const USER_BROWSER_POLICY =
  "Two browsers are available: aio_user_browser is the user's own Google Chrome on their Mac (their open tabs and signed-in accounts; the user sees everything you do there), and aio_tabs is the sandbox browser in the cloud. For browser work, use the user's Chrome first: begin with its list_pages; if that or a later call says the user's browser is unavailable, switch to aio_tabs for the rest of this task without asking, and mention the switch in one sentence in your reply. Use aio_tabs from the start only when the work needs files from the workspace (uploading or downloading) or the user asked for the sandbox browser. " +
  "In the user's Chrome: open the page you work in with new_page and pass its pageId on every call; do not navigate, type into or close tabs the user already had open unless the user asked about that tab; close the pages you opened once you no longer need them, unless the user should look at the result. Prefer take_snapshot to read a page and act on its uids; take a screenshot only for what the snapshot does not show. The task card shows the user the page you work in and lets them take it over. " +
  "When a site asks for a password, a CAPTCHA, two-factor verification, a QR-code sign-in or payment details, or a final step only the user may take, call aio_user_browser's request_human with the reason and wait; after it returns, read the page again before continuing. If a call says the user has taken over the page, call request_human to wait for them. (aio_tabs' browser_login and browser_request_human are only for the sandbox browser.) " +
  "For steps with external effects or that are hard to undo, such as paying, placing orders, sending messages or posts, deleting content, or changing account or security settings, first tell the user what you are about to do and wait for confirmation. Files on the Mac are not reachable: never pass file paths.";

/** The page a task works in on the user's Chrome, and who drives it. */
interface TaskPage {
  pageId: number | null;
  title: string;
  url: string;
  holder: "ai" | "human";
  humanSince: number | null;
  request: { reason: string; at: number } | null;
  /** Agents waiting in request_human: resolved when the person hands the page back. */
  waiters: Set<() => void>;
}

/** What a task's card shows of it. */
export interface UserBrowserView {
  page: boolean;
  title: string;
  url: string;
  holder: "ai" | "human";
  request: string | null;
}

const KEY = /^[A-Za-z0-9_-]{1,80}$/;

export class UserBrowserGateway extends McpGateway {
  #cfg: Config;
  #log: Logger;
  #links: DeviceLinks;
  #userIdOf: (username: string) => string | null;
  /** account -> task key -> its page */
  #pages = new Map<string, Map<string, TaskPage>>();
  #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

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
    this.#cfg = opts.cfg;
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

  #page(userId: string, key: string, create = false): TaskPage | undefined {
    let own = this.#pages.get(userId);
    if (!own && create) this.#pages.set(userId, (own = new Map()));
    let page = own?.get(key);
    if (!page && create) own!.set(key, (page = { pageId: null, title: "", url: "", holder: "ai", humanSince: null, request: null, waiters: new Set() }));
    return page;
  }

  /** A task's page as its card shows it; null when the task never worked in the user's Chrome. */
  view(userId: string, key: string): UserBrowserView | null {
    const page = this.#page(userId, key);
    if (!page || (page.pageId === null && !page.request && page.holder === "ai")) return null;
    return { page: page.pageId !== null, title: page.title, url: page.url, holder: page.holder, request: page.request?.reason ?? null };
  }

  /** The person takes a task's page over (brought to the front, the agent shut out) or hands it back. */
  async control(userId: string, key: string, action: "take" | "release"): Promise<UserBrowserView | null> {
    const page = this.#page(userId, key);
    if (!page) return null;
    if (action === "take") {
      page.holder = "human";
      page.humanSince = Date.now();
      const tunnel = this.#links.tunnelFor(userId);
      if (tunnel && page.pageId !== null) await tunnel.request("POST", `/browser/front?page=${page.pageId}`, { timeoutMs: 20_000 }).catch(() => undefined);
    } else {
      page.holder = "ai";
      page.humanSince = null;
      page.request = null;
      for (const resolve of page.waiters) resolve();
      page.waiters.clear();
    }
    return this.view(userId, key);
  }

  /** A picture of a task's page now; null when the Mac or the page is not there. */
  async screenshot(userId: string, key: string): Promise<{ type: string; body: Buffer } | null> {
    const page = this.#page(userId, key);
    const tunnel = page?.pageId != null ? this.#links.tunnelFor(userId) : null;
    try {
      const reply = tunnel ? await tunnel.request("GET", `/browser/screenshot?page=${page!.pageId}`, { timeoutMs: 25_000 }) : null;
      return reply?.status === 200 ? { type: reply.headers["content-type"] ?? "image/jpeg", body: reply.body } : null;
    } catch {
      return null;
    }
  }

  /**
   * The handshake and the tool list never depend on the Mac (Codex starts a
   * thread's MCP servers once and never retries a failed one); only tool calls
   * go down to it, and while it is offline they come back as a tool error that
   * sends the executor to the sandbox browser.
   */
  protected override async local(message: unknown, username: string, headers: http.IncomingHttpHeaders): Promise<unknown> {
    if (Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { protocolVersion?: unknown; name?: unknown; arguments?: Record<string, unknown> } };
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
          if (Array.isArray(live?.result?.tools)) return { ...live, result: { ...live.result, tools: [...live.result.tools, REQUEST_HUMAN_TOOL] } };
        } catch (err) {
          this.#log.warn("browser tool list from the Mac failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { jsonrpc: "2.0", id, result: { tools: [...USER_BROWSER_TOOLS, REQUEST_HUMAN_TOOL] } };
    }
    const failed = (why: string) => method === "tools/call"
      ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: why }], isError: true } }
      : { jsonrpc: "2.0", id, error: { code: -32000, message: why } };
    const header = headers[TAB_TASK_HEADER.toLowerCase()];
    const key = typeof header === "string" && KEY.test(header) ? header : null;
    const tool = typeof params?.name === "string" ? params.name : "";
    if (method === "tools/call" && tool === "request_human") {
      if (!key) return failed("request_human is not available in this session; ask the user in your reply instead.");
      return this.#waitForHuman(id, userId, key, String(params?.arguments?.reason ?? "").trim().slice(0, 300));
    }
    if (method === "tools/call" && key && tool !== "list_pages" && this.#page(userId, key)?.holder === "human") return failed(TAKEN_OVER);
    if (!tunnel) return failed(MAC_OFFLINE);
    try {
      const answer = await this.#rpc(tunnel, message);
      if (method === "tools/call" && key) this.#track(userId, key, tool, params?.arguments ?? {}, answer);
      return answer;
    } catch (err) {
      this.#log.warn("browser call failed", { error: err instanceof Error ? err.message : String(err) });
      return failed(this.#links.tunnelFor(userId)
        ? "The browser bridge on the user's Mac did not answer (the Mac app may need an update). Use the sandbox browser (aio_tabs) for this task instead."
        : MAC_OFFLINE);
    }
  }

  /** Remember which page a task works in, from what it asked for and what came back. */
  #track(userId: string, key: string, tool: string, args: Record<string, unknown>, answer: unknown): void {
    const result = (answer as { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean } })?.result;
    if (!result || result.isError) return;
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    const page = this.#page(userId, key, tool === "new_page") ?? (typeof args.pageId === "number" ? this.#page(userId, key, true) : undefined);
    if (!page) return;
    if (tool === "new_page") page.pageId = Number(/^(\d+): .*\[selected\]\s*$/m.exec(text)?.[1] ?? NaN) || page.pageId;
    else if (tool === "close_page" && args.pageId === page.pageId) { page.pageId = null; page.title = ""; page.url = ""; return; }
    else if (typeof args.pageId === "number" && Number.isInteger(args.pageId)) page.pageId = args.pageId;
    if (page.pageId === null) return;
    const line = new RegExp(`^${page.pageId}: (.*) \\((https?:[^)\\s]*)\\)(?: \\[selected\\])?\\s*$`, "m").exec(text);
    if (line) { page.title = line[1]!.slice(0, 200); page.url = line[2]!.slice(0, 2000); }
  }

  /** request_human: show the request on the task's card and wait until the person hands the page back. */
  async #waitForHuman(id: unknown, userId: string, key: string, reason: string): Promise<unknown> {
    const page = this.#page(userId, key, true)!;
    if (page.holder === "ai") page.request = { reason: reason || "Please do this step in your Chrome.", at: Date.now() };
    const done = await new Promise<boolean>((resolve) => {
      const wake = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { page.waiters.delete(wake); resolve(false); }, HUMAN_WAIT_MS);
      timer.unref?.();
      page.waiters.add(wake);
    });
    if (!done && page.waiters.size === 0) page.request = null;
    const text = done
      ? "The user handed the page back. Read it again (take_snapshot) before continuing, and do not redo an action whose result is uncertain."
      : "The user did not hand the page back within 30 minutes. Tell them what is still needed and stop here.";
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(done ? {} : { isError: true }) } };
  }

  /** Something that is not JSON never reaches the Mac. */
  protected override async forward(_call: McpCall, res: http.ServerResponse): Promise<boolean> {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
    return true;
  }

  /** One JSON-RPC request to the Mac's browser bridge, which keeps the MCP session itself. */
  async #rpc(tunnel: Tunnel, message: unknown): Promise<unknown> {
    const reply = await tunnel.request("POST", "/browser/mcp", {
      headers: { "content-type": "application/json", accept: "application/json" },
      body: Buffer.from(JSON.stringify(message)),
      timeoutMs: TIMEOUT_MS,
    });
    if (reply.status !== 200) throw new Error(`browser bridge answered ${reply.status}`);
    return JSON.parse(reply.body.toString("utf8"));
  }

  /** Whether an upgrade is a console's live view of a task's page. */
  ownsUpgrade(req: http.IncomingMessage): boolean {
    return (req.url ?? "").split("?")[0] === USER_BROWSER_SCREEN_PATH;
  }

  /**
   * A task's page live, for its account's console (`?key=<task key>`): its session
   * on the primary origin, opened by the console itself (Origin), relayed to that
   * account's Mac. Input passes only while the person holds the page.
   */
  handleUpgrade(deps: { db: Db; sessions: SessionStore }, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const rec = resolveRequest({ cfg: this.#cfg, sessions: deps.sessions, req });
    const origin = (rec?.origin ?? "").replace(/\/+$/, "");
    const fromConsole = this.#cfg.primaryOrigins.some((o) => o.replace(/\/+$/, "") === origin);
    const session = rec?.kind === "primary" ? rec.session : null;
    const user = session && deps.sessions.isLive(session.id) ? getUser(deps.db, session.ownerId) : null;
    if (!fromConsole || !user) {
      this.#log.warn("browser screen refused", { origin: rec?.origin ?? null, kind: rec?.kind ?? null });
      return endSocket(socket, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    const key = new URL(req.url ?? "/", "http://console").searchParams.get("key") ?? "";
    const page = KEY.test(key) ? this.#page(user.id, key) : undefined;
    if (!page || page.pageId === null) return endSocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    this.#wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = this.#links.tunnelFor(user.id)?.socket(`/browser/screen?page=${page.pageId}`);
      this.#relay(client, upstream, () => deps.sessions.isLive(session!.id), () => page.holder === "human");
    });
  }

  #relay(client: WebSocket, channel: TunnelChannel | undefined, live: () => boolean, held: () => boolean): void {
    // No channel (the Mac is offline) fails at once.
    const gone = new EventEmitter();
    if (!channel) queueMicrotask(() => { gone.emit("error", new Error("the Mac is not connected")); gone.emit("close", 1011); });
    const events: EventEmitter = channel ?? gone;
    const upstream = { send: (data: string) => channel?.send(data, false), close: () => channel?.close() };
    const close = (code = 1011, reason = "") => {
      clearInterval(timer);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
      upstream.close();
    };
    const timer = setInterval(() => { if (!live()) close(1008, "signed out"); }, 100);
    events.on("message", (data: Buffer, binary: boolean) => {
      // A slow viewer skips pictures instead of piling them up.
      if (client.readyState === WebSocket.OPEN && !(binary && client.bufferedAmount > 1024 * 1024)) client.send(data, { binary });
    });
    // Watching is open to the account; acting on the page only while the person holds it.
    client.on("message", (data, binary) => { if (!binary && held()) upstream.send(data.toString("utf8")); });
    events.on("close", (code: number) => close(code === 1000 ? 1000 : 1011, "page closed"));
    events.on("error", (err: Error) => {
      this.#log.warn("browser screen unreachable", { error: err.message });
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", message: "unavailable" }));
      close();
    });
    client.on("close", () => close(1000));
    client.on("error", () => close());
  }
}
