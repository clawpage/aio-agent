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
import type { DeviceLinks, Tunnel, TunnelChannel } from "./deviceLink.js";
import { HUMAN_WAIT_HINT, TAB_TASK_HEADER } from "./browser/tabs.js";
import { USER_BROWSER_TOOLS } from "./userBrowserTools.js";
import { siteCovers, siteOfUrl, type Vault } from "./vault.js";
import { CLEAR_PASSWORDS_SCRIPT, loginSteps, MAX_MAC_LOGIN_TRIES, runMacLogin } from "./macLogin.js";
import type { LoginStep } from "./browser/tabs.js";
import type { EnvAnswer } from "./envs/catalog.js";

/**
 * An account's AI Chrome, on the Mac it linked for its phones (DeviceLinks):
 * the Mac app's bridge serves it from bin/user-browser.mjs (Google Chrome in a
 * profile of its own, headless, so it never gets in the way of the person at
 * the Mac; sign-ins made there stay). It sits next to the
 * sandbox browser (aio_tabs), never in its place: the executor reaches it
 * through aio_mac_native on the member gateway (MacNativeGateway), prefers it,
 * and falls back to aio_tabs whenever the Mac or its Chrome is not
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
  "The user's Mac is not connected right now (the app on it is closed, asleep or offline), so the AI's Chrome on it is unavailable. Use the sandbox browser (aio_tabs) for this task instead.";
const TAKEN_OVER =
  "The user has taken over this task's page and is operating it now. Call request_human to wait until they hand it back; do not act on the page meanwhile.";

export const USER_BROWSER_INSTRUCTIONS =
    "The AI's own Google Chrome on the user's Mac: a profile of its own that keeps the sign-ins the user made in it, running in the background (it never covers the user's screen); the user watches its pages from the console. This is not the sandbox browser (aio_tabs). Start with list_pages; when a call reports that this browser is unavailable, use aio_tabs instead. Open your own pages with new_page and pass their pageId on every call.";

/** The gateway's own tool: wait for the person to do a step in the task's page. */
export const REQUEST_HUMAN_TOOL = {
  name: "request_human",
  title: "Ask the user to act in the page",
  description:
    "Ask the user to do a step themselves in the page this task works in, only for what you cannot do even with their written permission (no saved account, a CAPTCHA you could not pass, a QR-code sign-in, a code only they have). Steps they authorized in the conversation you do yourself. The task card shows the request and the page; the user takes it over, does the step, and hands it back. This call waits until they do (up to 30 minutes); then read the page again before continuing. Use it instead of ending your turn to ask them: a turn that ends asking for a step in the page leaves the task waiting for a reply. " + HUMAN_WAIT_HINT,
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", description: "What the user should do, in one short sentence in the user's language." } },
    required: ["reason"],
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
};

/** The gateway's own tools: sign in with the person's password manager, then say whether it worked. */
const LOGIN_TOOLS = [
  {
    name: "browser_login",
    title: "Sign in with the password manager",
    description:
      "Sign in to the site of this task's page with the account the user saved in the password manager. First take_snapshot to see the sign-in form, then write steps: starting from a fresh load of the current page, open the sign-in form if needed, fill {{username}} into the account box and {{password}} into the password box (it must be a type=password box), and submit. The system puts the saved values in place of the placeholders and runs the steps; you never see them. Steps that worked on this site before are reused, so steps may be omitted. When it returns, read the page and call browser_login_report.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "number", description: "The page this task opened with new_page." },
        steps: {
          type: "array",
          description: "At most 15 steps, each {action: click|fill|press|wait|select, selector?: a CSS selector, value?, key?, ms?}; a value of {{username}} or {{password}} is replaced with the saved value. May be omitted.",
          items: { type: "object", properties: { action: { type: "string" }, selector: { type: "string" }, value: { type: "string" }, key: { type: "string" }, ms: { type: "number" } }, required: ["action"] },
        },
      },
      required: ["pageId"],
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "browser_login_report",
    title: "Report whether the sign-in worked",
    description: "After browser_login, read the page and report whether sign-in really succeeded: ok=true remembers the steps for this site; ok=false with a one-sentence note on where it got stuck.",
    inputSchema: { type: "object", properties: { pageId: { type: "number" }, ok: { type: "boolean" }, note: { type: "string" } }, required: ["pageId", "ok"] },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];
const OWN_TOOLS = [REQUEST_HUMAN_TOOL, ...LOGIN_TOOLS];
const SIGNING_IN = "The password manager is signing in on this page right now; wait for browser_login to return before using the page.";

export const USER_BROWSER_POLICY =
  "Two browsers are available: the browser tools of aio_mac_native (list_pages, new_page, take_snapshot, click, …) drive the AI's own Google Chrome on the user's Mac (a profile of its own that keeps the sign-ins the user made in it, on the user's home network; the user can watch every page you work in from the console), and aio_tabs is the sandbox browser in the cloud. For browser work, use the Mac's Chrome first: begin with aio_mac_native's list_pages; if that or a later call says this browser is unavailable, switch to aio_tabs for the rest of this task without asking, and mention the switch in one sentence in your reply. Use aio_tabs from the start only when the work needs files from the workspace (uploading or downloading) or the user asked for the sandbox browser. " +
  "In the Mac's Chrome: open the page you work in with new_page and pass its pageId on every call; pages you did not open belong to other tasks, so leave them alone; close the pages you opened once you no longer need them, unless the user should look at the result. Prefer take_snapshot to read a page and act on its uids; take a screenshot only for what the snapshot does not show. The task card shows the user the page you work in and lets them take it over. " +
  "When a site needs signing in with an account and password, call aio_mac_native's browser_login with your page's pageId (never type a password yourself, never read password boxes, never ask the user for the password), then read the page and call browser_login_report; on failure rewrite the steps from the step it names, at most 3 times. Call aio_mac_native's request_human (with the reason, and wait) only for what you cannot do even with the user's permission: no account saved, a CAPTCHA you could not pass, a QR-code sign-in, a code only they have, or a page that needs their judgment; after it returns, read the page again before continuing. If a call says the user has taken over the page, call request_human to wait for them. Never end your turn to ask the user to sign in or do any other step in the page (not even with ask_user): call request_human and wait in it, so the task carries on as soon as they hand the page back; end the turn about it only after request_human has timed out. (aio_tabs' browser_login and browser_request_human are only for the sandbox browser.) " +
  "The user's written authorization in the conversation outranks these rules: a step they told you to do (\"go ahead\", \"type it\", \"buy it\") you do yourself, including typing a code you generated or one they gave you, rather than handing the page over. Steps with external effects or that are hard to undo (paying, placing orders, sending messages or posts, deleting content, changing account or security settings, granting an app access) need that authorization: without it in this task, say once in the conversation exactly what you are about to do and wait for their answer. Files on the Mac are not reachable: never pass file paths.";

/** The page a task works in on the AI's Chrome, and who drives it. */
interface TaskPage {
  pageId: number | null;
  title: string;
  url: string;
  holder: "ai" | "human";
  humanSince: number | null;
  request: { reason: string; at: number } | null;
  /** Agents waiting in request_human: resolved when the person hands the page back. */
  waiters: Set<() => void>;
  /** Password manager sign-ins that did not work here, and the last one that was submitted (for browser_login_report). */
  loginTries: number;
  lastLogin: { site: string; steps: LoginStep[] | null; startUrl: string; source: "agent" | "kept" | "guess" } | null;
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
/** A page line of chrome-devtools-mcp's page list: `3: Title (https://…) [selected]`, or `2: about:blank` untitled. */
const PAGE_LINE = /^(\d+): (?:(.*) \((\S+)\)|(\S+))(?: \[selected\])?\s*$/;

/** One page of the AI's Chrome as the workspace's Mac browser lists it. */
export interface MacBrowserPage {
  id: number;
  title: string;
  url: string;
  /** Opened by the person in the workspace ("you"), worked in by a task ("task"), or neither (a popup, say). */
  owner: "you" | "task" | "none";
  /** The task's key (its execution conversation) when a task works in the page, and who drives it. */
  taskKey: string | null;
  holder: "ai" | "human" | null;
}

/** Whether the account's Mac browser can be used: no Mac linked, the Mac away, no Chrome on it, or ready. */
export type MacBrowserState = "unlinked" | "offline" | "unavailable" | "ready";

export class UserBrowserGateway {
  #cfg: Config;
  #log: Logger;
  #links: DeviceLinks;
  #userIdOf: (username: string) => string | null;
  #vaultFor: ((userId: string) => Promise<Vault>) | null;
  /** account -> the page the password manager is signing in on (no other call may touch it meanwhile) */
  #signingIn = new Map<string, number>();
  /** account -> task key -> its page */
  #pages = new Map<string, Map<string, TaskPage>>();
  #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  /** account -> the pages the person opened in the workspace's Mac browser */
  #own = new Map<string, Set<number>>();

  constructor(opts: { cfg: Config; log: Logger; userIdOf: (username: string) => string | null; links: DeviceLinks; vaultFor?: (userId: string) => Promise<Vault> }) {
    this.#cfg = opts.cfg;
    this.#log = opts.log.child("user-browser");
    this.#links = opts.links;
    this.#userIdOf = opts.userIdOf;
    this.#vaultFor = opts.vaultFor ?? null;
  }

  #page(userId: string, key: string, create = false): TaskPage | undefined {
    let own = this.#pages.get(userId);
    if (!own && create) this.#pages.set(userId, (own = new Map()));
    let page = own?.get(key);
    if (!page && create) own!.set(key, (page = { pageId: null, title: "", url: "", holder: "ai", humanSince: null, request: null, waiters: new Set(), loginTries: 0, lastLogin: null }));
    return page;
  }

  /** A task's page as its card shows it; null when the task never worked in the AI's Chrome. */
  view(userId: string, key: string): UserBrowserView | null {
    const page = this.#page(userId, key);
    if (!page || (page.pageId === null && !page.request && page.holder === "ai")) return null;
    return { page: page.pageId !== null, title: page.title, url: page.url, holder: page.holder, request: page.request?.reason ?? null };
  }

  /** The person takes a task's page over (the agent shut out, the person working in its live view) or hands it back. */
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

  /** The task working in one page of the account's Chrome, if any. */
  #taskOf(userId: string, pageId: number): { key: string; page: TaskPage } | null {
    for (const [key, page] of this.#pages.get(userId) ?? []) if (page.pageId === pageId) return { key, page };
    return null;
  }

  /** One tool call on the account's Mac for the person (the workspace's Mac browser): its text, or an Error. */
  async #personCall(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
    const tunnel = this.#links.hasLink(userId) ? this.#links.tunnelFor(userId) : null;
    if (!tunnel) throw new Error(MAC_OFFLINE);
    const answer = (await this.#rpc(tunnel, { jsonrpc: "2.0", id: `person-${Date.now()}`, method: "tools/call", params: { name, arguments: args } })) as {
      result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      error?: { message?: string };
    };
    const text = (answer.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (!answer.result || answer.result.isError) throw new Error(text || answer.error?.message || `${name} failed`);
    return text;
  }

  /** Every page open in the account's Chrome on its Mac, with who works in it (the workspace's Mac browser). */
  async macPages(userId: string): Promise<{ state: MacBrowserState; pages: MacBrowserPage[] }> {
    if (!this.#links.hasLink(userId)) return { state: "unlinked", pages: [] };
    if (!this.#links.tunnelFor(userId)) return { state: "offline", pages: [] };
    let text: string;
    try {
      text = await this.#personCall(userId, "list_pages", {});
    } catch (err) {
      this.#log.warn("mac browser pages not listed", { error: err instanceof Error ? err.message : String(err) });
      return { state: this.#links.tunnelFor(userId) ? "unavailable" : "offline", pages: [] };
    }
    const own = this.#own.get(userId) ?? new Set<number>();
    const pages: MacBrowserPage[] = [];
    for (const line of text.split("\n")) {
      const found = PAGE_LINE.exec(line.trim());
      if (!found) continue;
      const id = Number(found[1]);
      const url = found[3] ?? found[4]!;
      const task = this.#taskOf(userId, id);
      const owner = own.has(id) ? "you" : task ? "task" : "none";
      // Chrome's own first blank page is nobody's and shows nothing.
      if (owner === "none" && url === "about:blank") continue;
      pages.push({ id, title: (found[2] ?? "").slice(0, 200), url: url.slice(0, 2000), owner, taskKey: task?.key ?? null, holder: task?.page.holder ?? null });
    }
    // Pages the person opened that are gone (closed in a task, Chrome restarted) are forgotten.
    for (const id of own) if (!pages.some((p) => p.id === id)) own.delete(id);
    return { state: "ready", pages };
  }

  /** The person opens a page of their own (to sign in to a site, say): its id. */
  async openMacPage(userId: string, url: string): Promise<number> {
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) pages can be opened.");
    const text = await this.#personCall(userId, "new_page", { url });
    const id = Number(/^(\d+): .*\[selected\]\s*$/m.exec(text)?.[1] ?? NaN);
    if (!Number.isInteger(id)) throw new Error("the new page did not show up");
    let own = this.#own.get(userId);
    if (!own) this.#own.set(userId, (own = new Set()));
    own.add(id);
    return id;
  }

  /** The person closes a page no task works in. False when a task does (or it is not there). */
  async closeMacPage(userId: string, pageId: number): Promise<boolean> {
    if (this.#taskOf(userId, pageId)) return false;
    await this.#personCall(userId, "close_page", { pageId });
    this.#own.get(userId)?.delete(pageId);
    return true;
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
   * The browser's half of a tools/list or tools/call (MacNativeGateway answers the
   * handshake). The tool list never depends on the Mac (Codex starts a thread's MCP
   * servers once and never retries a failed one); only tool calls go down to it,
   * and while it is offline they come back as a tool error that sends the executor
   * to the sandbox browser.
   */
  async answer(message: unknown, username: string, headers: http.IncomingHttpHeaders): Promise<unknown> {
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } };
    const userId = this.#userIdOf(username) ?? "";
    const tunnel = this.#links.hasLink(userId) ? this.#links.tunnelFor(userId) : null;
    if (method === "tools/list") {
      if (tunnel) {
        try {
          const live = (await this.#rpc(tunnel, message)) as { result?: { tools?: unknown[] } };
          if (Array.isArray(live?.result?.tools)) return { ...live, result: { ...live.result, tools: [...live.result.tools, ...OWN_TOOLS] } };
        } catch (err) {
          this.#log.warn("browser tool list from the Mac failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { jsonrpc: "2.0", id, result: { tools: [...USER_BROWSER_TOOLS, ...OWN_TOOLS] } };
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
    if (method === "tools/call" && this.#signingIn.has(userId) && tool !== "list_pages") {
      // Nothing else acts on, or reads, the page while the password manager types into it; a call without a pageId could land on it.
      const target = params?.arguments?.pageId;
      if (target === undefined || target === this.#signingIn.get(userId)) return failed(SIGNING_IN);
    }
    if (method === "tools/call" && tool === "browser_login") {
      if (!key) return failed("browser_login is not available in this session; ask the user to sign in instead.");
      return this.#login(id, userId, key, params?.arguments ?? {});
    }
    if (method === "tools/call" && tool === "browser_login_report") {
      if (!key) return failed("browser_login_report is not available in this session.");
      return this.#loginReport(id, userId, key, params?.arguments ?? {});
    }
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

  /**
   * aio_env's browser on a Mac that answers it itself (device protocol 1, envs/registry.ts). The device
   * does the browsing; the console keeps what only it can: the page on the task's card, the person
   * taking it over, and request_human, which waits here for the person to hand the page back.
   */
  async envCall(userId: string, headers: http.IncomingHttpHeaders, tool: string, args: Record<string, unknown>, send: () => Promise<EnvAnswer>): Promise<EnvAnswer> {
    const header = headers[TAB_TASK_HEADER.toLowerCase()];
    const key = typeof header === "string" && KEY.test(header) ? header : null;
    if (tool === "browser_request_human") {
      if (!key) return { ok: false, code: "invalid", message: "request_human is not available in this session; ask the user in your reply instead." };
      const answer = (await this.#waitForHuman(0, userId, key, String(args.reason ?? "").trim().slice(0, 300))) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      const text = answer.result.content[0]!.text;
      return answer.result.isError ? { ok: false, message: text } : { ok: true, result: { text } };
    }
    if (key && this.#page(userId, key)?.holder === "human") return { ok: false, code: "busy", message: TAKEN_OVER };
    if (this.#signingIn.has(userId)) return { ok: false, code: "busy", message: SIGNING_IN };
    const answer = await send();
    const opened = answer.ok ? (answer.result ?? {}) as { page?: unknown; title?: unknown; url?: unknown } : null;
    if (key && tool === "browser_open" && opened && Number.isInteger(opened.page)) {
      const page = this.#page(userId, key, true)!;
      page.pageId = opened.page as number;
      page.title = String(opened.title ?? "").slice(0, 200);
      page.url = String(opened.url ?? "").slice(0, 2000);
    }
    return answer;
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

  /**
   * browser_login: the person's password manager signs in on the task's page, with
   * the one account saved for its site. The account and password go from the
   * vault straight into the page through the Mac's browser tools; the agent hears
   * only how it went.
   */
  async #login(id: unknown, userId: string, key: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = (text: string, isError = false) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
    const page = this.#page(userId, key);
    if (!page || page.pageId === null || args.pageId !== page.pageId) return reply("Pass the pageId of the page this task opened with new_page.", true);
    if (page.holder === "human") return reply(TAKEN_OVER, true);
    if (!this.#vaultFor) return reply("The password manager is not available here: call request_human to ask the user to sign in themselves.", true);
    if (page.loginTries >= MAX_MAC_LOGIN_TRIES) {
      return reply(`Signing in to this site has failed ${page.loginTries} times already. Do not call browser_login again: call request_human to ask the user to sign in themselves, and say which step it got stuck on.`, true);
    }
    const steps = loginSteps(args.steps);
    if (typeof steps === "string") return reply(`steps cannot be used: ${steps}. Fix them and call again.`, true);
    const pageId = page.pageId;
    let url = "";
    try {
      const listed = await this.#personCall(userId, "list_pages", {});
      for (const line of listed.split("\n")) {
        const found = PAGE_LINE.exec(line.trim());
        if (found && Number(found[1]) === pageId) url = found[3] ?? found[4]!;
      }
    } catch (err) {
      return reply(err instanceof Error ? err.message : MAC_OFFLINE, true);
    }
    const host = siteOfUrl(url);
    if (!host) return reply("This page is not a web page; first navigate_page to the site you want to sign in to.", true);
    const vault = await this.#vaultFor(userId);
    const entries = vault.matching(host);
    const google = entries.filter((e) => e.method === "google");
    const accounts = entries.filter((e) => e.method === "password");
    if (accounts.length === 0 && google.length === 1) {
      vault.used(google[0]!.id);
      const which = google[0]!.username ? `the Google account ${google[0]!.username}` : "the Google account already signed in to this browser";
      return reply(`The user saved "Sign in with Google" for ${host}, with ${which}. Click the site's Google sign-in button (such as 「使用 Google 登录」, "Continue with Google" or "Sign in with Google"; open the sign-in form first if you cannot find one); in Google's account chooser choose ${google[0]!.username ? "this account" : "the signed-in account"} and continue. Do not call browser_login again and do not enter any password; if Google asks for a password, a code or two-factor verification, call request_human.`); // i18n-exempt: button text the agent looks for on Chinese sites
    }
    if (accounts.length !== 1) {
      return reply(accounts.length
        ? `The password manager has ${accounts.length} accounts for ${host} and cannot tell which one to use: call request_human asking the user to sign in themselves in this page.`
        : `The password manager has no account for ${host}: call request_human asking the user to sign in themselves in this page (they can also save the account in the password manager for next time).`, true);
    }
    const entry = accounts[0]!;
    const password = vault.secret(entry.id);
    if (password === null) return reply("The saved password could not be read: call request_human asking the user to sign in themselves.", true);
    // The agent's steps start from where the page is; kept steps from where they worked; else the form is found as a person would.
    const kept = steps ? null : vault.script(host);
    const keptStart = kept && siteCovers(entry.site, siteOfUrl(kept.startUrl) ?? "") ? kept.startUrl : url;
    const plan = { site: entry.site, steps: steps ?? kept?.steps ?? null, startUrl: steps ? url : keptStart };
    const source = steps ? "agent" : kept ? "kept" : "guess";
    const call = (name: string, a: Record<string, unknown>) => this.#personCall(userId, name, a);
    this.#signingIn.set(userId, pageId);
    let outcome;
    try {
      outcome = await runMacLogin(call, pageId, plan, entry.username, password);
    } finally {
      await call("evaluate_script", { pageId, function: CLEAR_PASSWORDS_SCRIPT }).catch(() => undefined);
      this.#signingIn.delete(userId);
    }
    this.#log.info("mac sign-in", { site: host, result: outcome.result, source });
    const used = source === "kept" ? " (using the steps that worked on this site last time)" : "";
    if (outcome.result === "submitted") {
      vault.used(entry.id);
      page.lastLogin = { site: host, steps: plan.steps, startUrl: plan.startUrl, source };
      return reply(`The password manager filled in the account and password and submitted${used}. Read the page (take_snapshot) to confirm whether sign-in succeeded, then call browser_login_report. If the page says the account or password is wrong, report failure and tell the user to check it in the password manager; if a code or two-factor verification is still needed, call request_human.`);
    }
    if (outcome.result === "username_only") return reply("The password manager filled in the account and went on, but no password box appeared. Read the page, write steps, then call browser_login again.");
    page.loginTries++;
    const left = MAX_MAC_LOGIN_TRIES - page.loginTries;
    const why = outcome.error ?? "no account or password box was found on the page";
    return reply(left > 0
      ? `Sign-in did not complete${used}: ${why}.\nUse take_snapshot to see the sign-in form, rewrite steps (they start from a fresh load of the page and must open the sign-in form), then call browser_login again. Attempts left: ${left}.`
      : `Sign-in did not complete: ${why}. It has been tried ${MAX_MAC_LOGIN_TRIES} times. Do not call browser_login again: call request_human asking the user to sign in themselves, and say which step it got stuck on.`, true);
  }

  /** browser_login_report: steps that worked become the site's in the vault (shared with the sandbox browser's). */
  async #loginReport(id: unknown, userId: string, key: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = (text: string, isError = false) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
    const page = this.#page(userId, key);
    const last = page?.lastLogin;
    if (!page || !last || !this.#vaultFor) return reply("This page has not signed in with the password manager recently.", true);
    const ok = args.ok === true;
    if (last.source !== "guess" || !ok) (await this.#vaultFor(userId)).noteLogin({ site: last.site, steps: last.steps, startUrl: last.startUrl, ok, note: String(args.note ?? "").slice(0, 300) });
    page.lastLogin = null;
    if (ok) page.loginTries = 0;
    else page.loginTries++;
    return reply(ok ? "Noted: these steps will be used the next time you sign in to this site." : "Noted.");
  }

  /** request_human: show the request on the task's card and wait until the person hands the page back. */
  async #waitForHuman(id: unknown, userId: string, key: string, reason: string): Promise<unknown> {
    const page = this.#page(userId, key, true)!;
    if (page.holder === "ai") page.request = { reason: reason || "Please do this step in the page.", at: Date.now() };
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
   * A page live, for its account's console: a task's (`?key=<task key>`) or any
   * page of the account's Chrome by its id (`?page=<id>`, the workspace's Mac
   * browser). Its session on the primary origin, opened by the console itself
   * (Origin), relayed to that account's Mac. Input passes only while the person
   * holds the page: a page a task works in once taken over, any other page always.
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
    const query = new URL(req.url ?? "/", "http://console").searchParams;
    const key = query.get("key") ?? "";
    const byId = Number(query.get("page"));
    let pageId: number | null = null;
    let held: () => boolean;
    if (query.has("page")) {
      if (!Number.isInteger(byId) || byId <= 0 || !this.#links.hasLink(user.id)) return endSocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      pageId = byId;
      held = () => { const task = this.#taskOf(user.id, byId); return !task || task.page.holder === "human"; };
    } else {
      const page = KEY.test(key) ? this.#page(user.id, key) : undefined;
      if (!page || page.pageId === null) return endSocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      pageId = page.pageId;
      held = () => page.holder === "human";
    }
    this.#wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = this.#links.tunnelFor(user.id)?.socket(`/browser/screen?page=${pageId}`);
      this.#relay(client, upstream, () => deps.sessions.isLive(session!.id), held);
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
