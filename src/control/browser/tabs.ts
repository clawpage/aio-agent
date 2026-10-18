import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import type { SandboxContainer } from "../sandbox/container.js";
import { redact, type BrowserRuntime } from "./runtime.js";
import type { BrowserRuntimeLike } from "./lifecycle.js";
import { LastPages, type LastPage } from "./lastPages.js";
import { t } from "../i18n/index.js";

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
/** A Chromium target id (32 hex digits today). */
const TARGET = /^[A-Fa-f0-9]{16,64}$/;

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
  /** The agent asked a person to act in this tab, or asked the vault to sign in (`kind`), and is waiting. */
  request: { reason: string; at: number; kind?: "login"; site?: string; steps?: LoginStep[]; url?: string } | null;
  /** What the agent said about its last sign-in on this tab: the steps it used and whether they worked. */
  loginReport?: { site: string; steps: LoginStep[] | null; startUrl: string; source: string; ok: boolean; note: string; at: number } | null;
}

/** One page open in the browser, as the person's tab overview shows it. */
export interface OverviewPage {
  /** Chromium's target id: how the overview names a page, registered or not. */
  target: string;
  title: string;
  url: string;
  /** The tab record behind the page, if any: a task's tab or the person's own; null for a page nobody owns. */
  tab: string | null;
  owner: "task" | "person" | null;
  /** The owning task's title. */
  task: string | null;
  holder: "ai" | "human" | null;
  /** The page a console keeps on top of the desktop right now. */
  front: boolean;
}

/** One sign-in step the agent wrote; `value` may be the placeholder {{username}} or {{password}}. */
export interface LoginStep { action: "click" | "fill" | "press" | "wait" | "select"; selector?: string; value?: string; key?: string; ms?: number }

/** The tab server's key for links a person opens from a reply: theirs alone, invisible to agents. */
export const PERSON_KEY = "person";

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
  /** Sign in for the person on a tab whose agent asked the vault: the account goes into the page, never back. */
  login(key: string, tab: string, account: { site: string; username: string; password: string; steps?: LoginStep[]; startUrl?: string } | { site: string; method: "google"; username: string }): Promise<PersonResult>;
  /** A current preview of one of the task's tabs. */
  screenshot(key: string, tab: string): Promise<{ mimeType: string; data: string; url: string; title: string } | null>;
  /** Type text or press a key, for a person, into a tab they took over (the latest one unless `tab`/`task` name it). */
  input(input: PersonTarget & { text?: string; key?: string }): Promise<PersonResult>;
  /** Tap (x, y as 0..1 of the viewport), scroll or go back, for a person, in a tab they took over. */
  pointer(input: PersonTarget & { action: "click" | "scroll" | "back" | "focus"; x?: number; y?: number; dy?: number }): Promise<PersonResult>;
  /** Open a link for a person in a tab of their own, in its own window. */
  open(url: string): Promise<PersonResult>;
  /** Close a tab the person opened. */
  close(tab: string): Promise<PersonResult>;
  /** Every page open in the browser, for the person's overview (null when the browser cannot be asked). */
  overview?(): Promise<OverviewPage[] | null>;
  /** A small current preview of one page of the overview. */
  overviewShot?(target: string): Promise<{ mimeType: string; data: string } | null>;
  /** Bring one page of the overview to the front of the desktop for the person. */
  front?(target: string): Promise<PersonResult>;
  /** The page a task's browser last showed, kept after its tab is closed. */
  lastPage?(key: string): LastPage | null;
  /** The picture of that page, if one was kept. */
  lastShot?(key: string): Buffer | null;
  /** Open that page again as a new tab of the task, held by the person. */
  reopen?(key: string, url: string, title: string): Promise<PersonResult>;
}

/**
 * The tab server answers in English with a stable `error` code (its words are
 * what agents read); what a person reads is worded here, in their language. An
 * unknown code keeps the server's text.
 */
function worded(body: Record<string, unknown>, login?: "google" | "password"): Record<string, unknown> {
  const m = t().browser.tabs;
  let message: string | undefined;
  if (typeof body.message === "string") {
    switch (body.error) {
      case "no_tab": message = m.noTab; break;
      case "no_page": message = m.pageClosed; break;
      case "no_request": message = m.noRequest; break;
      case "busy": message = m.loginBusy; break;
      case "site_changed": message = login === "google" ? m.siteChanged : m.siteChangedNotFilled; break;
      case "not_held": message = m.notHeld(String(body.task ?? "")); break;
      case "no_held_tab": message = m.noHeldTab; break;
      case "too_long": message = m.tooLong; break;
      case "unavailable": message = body.reason === "memory_tight" ? m.memoryTight : body.reason === "window_missing" ? m.windowMissing : undefined; break;
    }
  }
  // A sign-in step that failed: the person sees which step, in their words.
  const failure = body.failure as { code?: unknown; step?: unknown; label?: unknown; type?: unknown; detail?: unknown } | undefined;
  let error: string | undefined;
  if (typeof body.error === "string" && failure && typeof failure === "object") {
    const step = Number(failure.step), label = String(failure.label ?? "");
    if (failure.code === "not_password") error = m.loginNotPassword(step, label, String(failure.type ?? ""));
    else if (failure.code === "step_failed") error = m.loginStepFailed(step, label, String(failure.detail ?? ""));
  }
  return message === undefined && error === undefined ? body : { ...body, ...(message !== undefined ? { message } : {}), ...(error !== undefined ? { error } : {}) };
}

/** A request the agent left without words (a sign-in, or no reason given) is worded for the person reading it. */
function withReasons(tabs: TabRecord[]): TabRecord[] {
  return tabs.map((tab) => !tab.request || tab.request.reason ? tab : {
    ...tab,
    request: { ...tab.request, reason: tab.request.kind === "login" ? t().browser.tabs.signIn(tab.request.site ?? "") : t().browser.tabs.needsYou },
  });
}

/** The tab a task's card shows: one waiting for the person, then one they hold, then the most recently used. */
export function shownTab(tabs: TabRecord[]): TabRecord | undefined {
  return tabs.find((t) => t.request && t.holder === "ai") ?? tabs.find((t) => t.holder === "human") ?? [...tabs].sort((a, b) => b.lastUsed - a.lastUsed)[0];
}

/** An agent asking a person for help waits up to 30 minutes; the MCP clients must wait a bit longer. */
export const TAB_TOOL_TIMEOUT_SEC = 31 * 60;
/**
 * A vault sign-in's longest run: a 24 s load, 15 steps of up to 16 s (a password
 * box is checked, then filled), 9.5 s to settle. Waiting less gives up on a run
 * that is still typing; the vault would then ask again into the same page.
 */
export const LOGIN_TIMEOUT_SEC = 300;

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
  "Every execution task may use its own aio_tabs browser tools when the user's request calls for it; `browser` in the dispatch resources is only a hint to wake the browser early, and its absence does not mean there is no browser permission. Actual tool calls check and recover the browser as needed. When you need to look something up on the web, get product images or fill in forms, call the tools directly; do not claim you lack permission based only on the resource list. If a call actually fails, use the tool's error to explain what was not done. " +
  "In the sandbox browser, use only the aio_tabs tools: you can act only on tabs this task created; other tasks' tabs are read-only to you, and you can run in parallel with other tasks. Do not use the `aio browser` command line or the /v1/browser API: they act on the whole browser's current page and would disrupt parallel tasks. " +
  "Each user has only this one browser, and it holds the user's signed-in sessions: do not start a browser of your own (for example Playwright/Puppeteer launch, headless Chrome or a new user data directory), which would have none of those sessions, and do not clear cookies or site data. " +
  "When checking flights, dates or products in bulk, reuse this task's pages: read and save the results, then change the URL, keeping at most 3 pages open at once. If pages respond slowly or memory is reported tight, first close your own pages that you have finished reading; do not keep opening new pages or polling repeatedly. Never close pages the user has taken over or pages of other tasks. " +
  "When a site requires signing in, call browser_login: first look at the sign-in form, write steps (open the sign-in entry, fill {{username}} into the account box and {{password}} into the password box, submit); the password manager substitutes the values the user saved and runs them. You never see the values, and you must not fill in, read or ask the user for the password yourself; steps that worked before are reused automatically. Then read the page and use browser_login_report to report whether it succeeded; on failure, rewrite steps based on the step that failed and retry, at most 3 times; if it still fails, call browser_request_human. If the user saved Google sign-in for this site, it tells you to click the Google button and which account to choose. " +
  "For CAPTCHAs, two-factor verification, QR-code sign-in, payment details, paying, placing an order, sending a message, changing account settings and other final steps that the user must complete themselves or that cannot be undone, call browser_request_human with the reason and wait for the user to hand control back. Do not ask for passwords or verification codes in the conversation, and do not complete payments or orders on the user's behalf. After the user hands back, read the page to confirm its state before continuing, and do not automatically redo an action whose result is uncertain.";

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
 * root-managed browser tool directory next to the vendored patchright-core, runs
 * as the sandbox user on loopback, and is restarted when its version changes.
 */
export class TabServer implements TabServerLike {
  #cfg: Config;
  #log: Logger;
  #container: SandboxContainer;
  #runtime: BrowserRuntime;
  #ensuring: Promise<void> | null = null;
  #pages: LastPages;

  constructor(cfg: Config, log: Logger, container: SandboxContainer, runtime: BrowserRuntime) {
    this.#cfg = cfg;
    this.#log = log.child("browser-tabs");
    this.#container = container;
    this.#runtime = runtime;
    this.#pages = new LastPages(cfg.dataDir);
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
    let health = await this.#health();
    if (health?.version === version) return;
    if (!health) {
      // A server whose event loop is stuck still holds the port, so a new one could never
      // listen: ask once more, then stop exactly this script's process (nothing else matches).
      await new Promise((resolve) => setTimeout(resolve, 1000));
      health = await this.#health();
      if (health?.version === version) return;
      if (!health) await this.#container.execInSandbox(["pkill", "-KILL", "-f", "-x", `node ${this.scriptPath}`], { timeoutMs: 10_000 });
    }
    await this.#runtime.ensureScripts();
    await this.#container.writeFileInSandbox(this.scriptPath, body, { user: "root" });
    const chmod = await this.#container.execInSandbox(["chmod", "0755", this.scriptPath], { timeoutMs: 15_000, user: "root" });
    if (chmod.code !== 0) throw new Error(t().browser.tabs.installFailed(redact(chmod.stderr || chmod.stdout)));
    if (health?.pid) {
      // An older version is still listening: stop exactly that process before starting the new one.
      await this.#container.execInSandbox(["kill", String(health.pid)], { timeoutMs: 10_000 });
    }
    const started = await this.#container.execDetached(["sh", "-c", 'exec node "$1" >>/tmp/aio-tabs.log 2>&1', "sh", this.scriptPath], {
      env: {
        ...(this.#cfg.browser.readyGateway ? { AIO_TABS_READY_URL: this.#cfg.browser.readyGateway.url, AIO_TABS_READY_TOKEN: this.#cfg.browser.readyGateway.token } : {}),
        AIO_TABS_VERSION: version,
        AIO_TABS_PORT: String(TAB_SERVER_PORT),
        AIO_TABS_PLAYWRIGHT: path.posix.join(this.#cfg.browser.toolDir, "patchright-core"),
        AIO_TABS_OUTPUT: path.posix.join(this.#cfg.sandbox.containerWorkspaceDir, ".scratch", "artifacts", "browser"),
      },
    });
    if (started.code !== 0) throw new Error(t().browser.tabs.startFailed(redact(started.stderr || started.stdout)));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await this.#health())?.version === version) {
        this.#log.info("browser tab server running", { version });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(t().browser.tabs.startTimeout);
  }

  /** Best effort: a server that is gone has no tabs left to mark or close. */
  async #post(route: string, body: unknown): Promise<void> {
    const res = await this.#container.execInSandbox(
      ["curl", "-s", "-f", "-m", "20", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `http://127.0.0.1:${TAB_SERVER_PORT}${route}`],
      { timeoutMs: 25_000, stdin: JSON.stringify(body) },
    );
    // A /finish that never lands leaves the task's tabs counted as a running task's, kept from every cleanup.
    if (res.code !== 0) this.#log.warn("tab server call failed", { route, error: redact(res.stderr || res.stdout) });
  }

  async finish(key: string): Promise<void> {
    if (!KEY.test(key)) return;
    // The page it ends on is kept: the tab itself is closed a few minutes after the task finishes.
    const tab = shownTab(await this.list(key).catch(() => []));
    if (tab) await this.screenshot(key, tab.id).catch(() => null);
    await this.#post("/finish", { key });
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

  #listing: Promise<TabRecord[]> | null = null;

  async list(key?: string): Promise<TabRecord[]> {
    if (key !== undefined && !KEY.test(key)) return [];
    if (key) return withReasons((await this.#get<{ tabs: TabRecord[] }>(`/tabs?key=${key}`))?.tabs ?? []);
    // Every feed read wants the whole record: concurrent ones share one sandbox call.
    this.#listing ??= this.#get<{ tabs: TabRecord[] }>("/tabs").then((r) => r?.tabs ?? []).finally(() => { this.#listing = null; });
    return withReasons(await this.#listing);
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

  async pointer(input: PersonTarget & { action: "click" | "scroll" | "back" | "focus"; x?: number; y?: number; dy?: number }): Promise<PersonResult> {
    return this.#person("/pointer", input);
  }

  async open(url: string): Promise<PersonResult> {
    // The tab is named in the person's language until the page gives its own title.
    return this.#person("/open", { url, title: t().browser.tabs.openedPage } as PersonTarget & { url: string });
  }

  async close(tab: string): Promise<PersonResult> {
    return this.#person("/close", { tab });
  }

  async login(key: string, tab: string, account: { site: string; username: string; password: string; steps?: LoginStep[]; startUrl?: string } | { site: string; method: "google"; username: string }): Promise<PersonResult> {
    if (!KEY.test(key)) return { status: 404, body: { error: "no_tab", message: t().browser.tabs.noTab } };
    // The account travels on stdin, never in a command line; filling and submitting can take a while.
    return this.#person("/login", { key, tab, ...account } as unknown as PersonTarget & object, LOGIN_TIMEOUT_SEC, "method" in account ? "google" : "password");
  }

  async #person(route: "/input" | "/pointer" | "/open" | "/close" | "/login" | "/reopen", body: PersonTarget & object, seconds = 20, login?: "google" | "password"): Promise<PersonResult> {
    if ((body.task !== undefined && !KEY.test(body.task)) || (body.tab !== undefined && !/^t\d{1,9}$/.test(body.tab))) {
      return { status: 404, body: { error: "no_tab", message: t().browser.tabs.noTab } };
    }
    // A person may act before any task turn has started the current server version.
    try {
      await this.ensure();
    } catch {
      return { status: 503, body: { error: "unavailable", message: t().browser.tabs.inputUnavailable } };
    }
    const res = await this.#container.execInSandbox(
      ["curl", "-s", "-m", String(seconds), "-w", "\n%{http_code}", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `http://127.0.0.1:${TAB_SERVER_PORT}${route}`],
      { timeoutMs: (seconds + 5) * 1000, stdin: JSON.stringify(body) },
    );
    const cut = res.stdout.lastIndexOf("\n");
    const status = Number(res.stdout.slice(cut + 1));
    if (res.code !== 0 || !status) return { status: 503, body: { error: "unavailable", message: t().browser.tabs.inputUnavailable } };
    try {
      return { status, body: worded(JSON.parse(res.stdout.slice(0, cut)) as Record<string, unknown>, login) };
    } catch {
      return { status: 502, body: { error: "bad_response" } };
    }
  }

  async screenshot(key: string, tab: string): Promise<{ mimeType: string; data: string; url: string; title: string } | null> {
    if (!KEY.test(key) || !/^t\d{1,9}$/.test(tab)) return null;
    const shot = await this.#get<{ mimeType: string; data: string; url: string; title: string }>(`/screenshot?tab=${tab}&key=${key}`);
    if (shot) this.#pages.save(key, shot, Buffer.from(shot.data, "base64"));
    return shot;
  }

  lastPage(key: string): LastPage | null {
    return this.#pages.get(key);
  }

  lastShot(key: string): Buffer | null {
    return this.#pages.shot(key);
  }

  async reopen(key: string, url: string, title: string): Promise<PersonResult> {
    if (!KEY.test(key) || !/^https?:\/\//i.test(url)) return { status: 400, body: { error: "bad_request" } };
    return this.#person("/reopen", { key, url, title: title || t().browser.tabs.reopenedPage } as unknown as PersonTarget & object, 40);
  }

  async overview(): Promise<OverviewPage[] | null> {
    // The overview may be the first thing that needs the current server version.
    try { await this.ensure(); } catch { return null; }
    return (await this.#get<{ pages: OverviewPage[] }>("/overview"))?.pages ?? null;
  }

  async overviewShot(target: string): Promise<{ mimeType: string; data: string } | null> {
    if (!TARGET.test(target)) return null;
    return await this.#get(`/overview/shot?target=${target}`);
  }

  async front(target: string): Promise<PersonResult> {
    if (!TARGET.test(target)) return { status: 404, body: { error: "no_page", message: t().browser.tabs.pageClosed } };
    const res = await this.#container.execInSandbox(
      ["curl", "-s", "-m", "20", "-w", "\n%{http_code}", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", `http://127.0.0.1:${TAB_SERVER_PORT}/overview/front`],
      { timeoutMs: 25_000, stdin: JSON.stringify({ target }) },
    );
    const cut = res.stdout.lastIndexOf("\n");
    const status = Number(res.stdout.slice(cut + 1));
    if (res.code !== 0 || !status) return { status: 503, body: { error: "unavailable", message: t().browser.tabs.unavailable } };
    try {
      return { status, body: worded(JSON.parse(res.stdout.slice(0, cut)) as Record<string, unknown>) };
    } catch {
      return { status: 502, body: { error: "bad_response" } };
    }
  }
}
