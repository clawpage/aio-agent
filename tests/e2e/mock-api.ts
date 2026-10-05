import type { Page, Route } from "@playwright/test";
import { taskBucket, type TaskCounts, type TaskFilter } from "../../src/common/taskList";
import type { Task } from "../../src/ui/src/types";

/**
 * Fully mocked control-plane API for the local Playwright run. Every route the
 * console calls is fulfilled here, so a spec driven by
 * `playwright.local.config.ts` can never reach a real deployment while still
 * exercising the real web bundle.
 *
 * The conversation list is mutable: POST/PATCH update the in-memory objects so
 * create, rename, archive and restore flows behave like the server. The mock
 * mirrors the small set of server rules the UI depends on (an empty create
 * reuses an active blank default, and a duplicate default title is a 409), but
 * the authoritative rules live in the unit/integration suites.
 */

export interface MockConversation {
  id: string;
  title: string;
  codex_thread_id: string | null;
  model: string | null;
  cwd: string | null;
  status: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

export const DEFAULT_TITLE = "新会话";

export function makeConversation(id: string, title = "E2E 会话"): MockConversation {
  const now = Date.now();
  return { id, title, codex_thread_id: null, model: null, cwd: null, status: "idle", archived: 0, created_at: now, updated_at: now };
}

export const MOCK_STATUS = {
  agent: {
    sessionReady: true,
    account: { email: "owner@example.com", planType: "prolite", type: "chatgpt" },
    activeTurnId: null,
    activeConversationId: null,
    activeTurns: [],
    capacity: 3,
    queuedTurns: 0,
    lastError: null,
  },
  hostAuth: { ok: true, authMethod: "chatgpt", email: "owner@example.com", planType: "prolite", error: null, expiresAt: null },
  sandbox: { name: "personal-agent-sandbox", running: true, healthy: true, image: "test", managed: true },
  workspaceOrigin: "http://127.0.0.1:4289",
};

/** One model as `/api/settings` reports it (validation shape for the page). */
export interface MockSettingsModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  /** Present on catalog entries that are not plain ChatGPT models. */
  inputModalities?: string[];
  modelProvider?: string | null;
}

export const MOCK_SETTINGS_MODELS: MockSettingsModel[] = [
  { id: "gpt-6-sol", displayName: "GPT-6-Sol", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
  { id: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: ["minimal", "low"], defaultReasoningEffort: "low" },
];

export const MOCK_DEFAULT_MODEL = "gpt-6-sol";

export const MOCK_MODELS = {
  models: [
    {
      id: "gpt-6-sol",
      displayName: "GPT-6-Sol",
      description: "test model",
      isDefault: true,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
    },
  ],
};

/** A minimal SSE stream that ends with `replay.complete`. */
export function replayOnly(): string {
  return `retry: 3000\n\nevent: replay.complete\ndata: ${JSON.stringify({ lastEventId: 0, replayed: 0 })}\n\n`;
}

export interface MockConsoleOptions {
  conversations: MockConversation[];
  /** Raw SSE body keyed by conversation id (defaults to an empty replay). */
  sse?: Record<string, string>;
  /** Observe a POST /api/browser/tabs call; the response is always a success. */
  onBrowserTab?: (url: string) => void;
  /** Override the status payload (for example to mark a conversation running). */
  status?: unknown;
  /** Fail the next PATCH /api/conversations/:id once, then clear the override. */
  failPatchOnce?: { status: number; error?: string; message: string };
  /** Unified settings the server holds; the mock mutates it on a successful PUT. */
  settings?: { model: string | null; effort: string | null };
  /** Fail the next PUT /api/settings once, then clear the override. */
  failSettingsOnce?: { status: number; error?: string; message: string };
  /** Model catalog `/api/settings` reports; an empty list disables saving. */
  settingsModels?: MockSettingsModel[];
  /** Observe a PUT /api/settings body. */
  onSaveSettings?: (body: { model: string | null; effort: string | null }) => void;
  /**
   * Serve the browser lifecycle endpoints too. Off by default so existing specs
   * keep a strict mock; the browser lifecycle spec opts in.
   */
  browser?: MockBrowserOptions;
}

/** Mutable browser lifecycle state the mocked control plane serves. */
export interface MockBrowserState {
  state: string;
  browserRunning: boolean | null;
  restorePending: boolean;
  idleRemainingMs: number | null;
  pins: Array<{ id: string; note: string; createdAt: number; expiresAt: number | null }>;
  lastErrorCode: string | null;
  lastError: string | null;
  unrestoredTabCount: number | null;
}

export interface MockBrowserOptions {
  /** A fixed, safe reason for a browser whose idle snapshot was refused. */
  snapshotBlockReason?: string;
  /** Start from released ("asleep") instead of the default awake state. */
  startAsleep?: boolean;
  /** Observe every state transition the mock serves, for assertions. */
  onChange?: (state: MockBrowserState) => void;
}

const BROWSER_STATE_LABELS: Record<string, string> = {
  awake: "浏览器已就绪",
  idle: "浏览器空闲中，即将释放",
  snapshotting: "正在保存浏览器状态",
  asleep: "浏览器已释放，等待按需恢复",
  restoring: "正在恢复浏览器",
  error: "浏览器状态异常",
};

/** A lifecycle payload shaped exactly like `browserStatusPayload` on the server. */
export function browserStatusPayload(state: MockBrowserState, viewers: number, turns = 0, calls = 0) {
  return {
    enabled: true,
    state: state.state,
    stateLabel: BROWSER_STATE_LABELS[state.state] ?? state.state,
    idleDeadline: state.idleRemainingMs === null ? null : Date.now() + state.idleRemainingMs,
    idleRemainingMs: state.idleRemainingMs,
    idleMinutes: state.idleRemainingMs === null ? null : Math.ceil(state.idleRemainingMs / 60_000),
    since: Date.now() - 1000,
    epoch: 1,
    leases: { turns, viewers, calls, holds: state.pins.length, pins: state.pins.length },
    viewers,
    holds: state.pins.length,
    pins: state.pins,
    held: turns + viewers + calls + state.pins.length > 0,
    browserRunning: state.browserRunning,
    snapshotAt: null,
    restoredSnapshotAt: null,
    restorePending: state.restorePending,
    lastError: state.lastError,
    lastErrorCode: state.lastErrorCode,
    lastSnapshotWarnings: [],
    unrestoredTabCount: state.unrestoredTabCount,
  };
}

export async function mockConsole(page: Page, opts: MockConsoleOptions): Promise<void> {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route((url) => url.pathname === "/api/auth/session", (route) =>
    json(route, { authenticated: true, username: "owner" }),
  );
  await page.route((url) => url.pathname === "/api/status", (route) => json(route, opts.status ?? MOCK_STATUS));
  await page.route((url) => url.pathname === "/api/models", (route) => json(route, MOCK_MODELS));

  await page.route('**/api/settings/soul',route=>json(route,{content:'# SOUL.md\n你是个人助理。',revision:'initial',defaultContent:'# SOUL.md\n你是个人助理。',maxBytes:65536}));
  await page.route((url) => url.pathname === "/api/settings/invites", (route) => json(route, { invites: [] }));
  await page.route((url) => url.pathname === "/api/settings/recall", (route) => {
    const days = Number(new URL(route.request().url()).searchParams.get("days"));
    return json(route, { stats: { days, dispatches: days === 30 ? 120 : 34, failed: 1, repaired: 3, withRecall: 21, avgRecalled: 2.4, searchRate: 0.12, avgRounds: 1.15, chosen: 18, chosenFromRecall: 7, labelled: 6, recallAtCap: 0.83, mrr: 0.71, cap: 4, avgLatencyMs: 4200, p90PromptChars: 23800 } });
  });
  // Unified settings: GET returns the stored choice plus the catalog; PUT mirrors
  // the server's validation (unknown model / unsupported effort -> 400).
  const settingsState = opts.settings ?? { model: null, effort: null };
  const settingsModels = opts.settingsModels ?? MOCK_SETTINGS_MODELS;
  await page.route((url) => url.pathname === "/api/settings", (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      const savedModelAvailable =
        settingsModels.length === 0 ? null : settingsState.model === null || settingsModels.some((m) => m.id === settingsState.model);
      return json(route, { settings: settingsState, defaultModel: MOCK_DEFAULT_MODEL, models: settingsModels, savedModelAvailable });
    }
    if (opts.failSettingsOnce) {
      const failure = opts.failSettingsOnce;
      opts.failSettingsOnce = undefined;
      return json(route, { error: failure.error ?? "server_error", message: failure.message }, failure.status);
    }
    const body = JSON.parse(request.postData() ?? "{}") as { model?: unknown; effort?: unknown };
    const model = typeof body.model === "string" && body.model ? body.model : null;
    const effort = typeof body.effort === "string" && body.effort ? body.effort : null;
    if (model && !settingsModels.some((m) => m.id === model)) {
      return json(route, { error: "invalid_settings", message: "未知的模型，请刷新后重试" }, 400);
    }
    const target = settingsModels.find((m) => m.id === model);
    if (effort && (!target || !target.supportedReasoningEfforts.includes(effort))) {
      return json(route, { error: "invalid_settings", message: "该模型不支持这个思考强度" }, 400);
    }
    settingsState.model = model;
    settingsState.effort = effort;
    opts.onSaveSettings?.({ model, effort });
    return json(route, { ok: true, settings: { model, effort } });
  });

  // Active by default; `?archived=1` also returns archived conversations, like
  // the server.
  await page.route((url) => url.pathname === "/api/conversations", (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      const includeArchived = new URL(request.url()).searchParams.get("archived") === "1";
      const conversations = includeArchived ? opts.conversations : opts.conversations.filter((c) => c.archived === 0);
      return json(route, { conversations });
    }
    const body = JSON.parse(request.postData() ?? "{}") as { title?: string };
    const title = (body.title ?? "").trim();
    if (!title) {
      const existing = opts.conversations.find((c) => c.archived === 0 && c.title === DEFAULT_TITLE);
      if (existing) return json(route, { conversation: existing, reused: true }, 200);
    }
    const conversation = makeConversation(
      `conv_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title || DEFAULT_TITLE,
    );
    opts.conversations.unshift(conversation);
    return json(route, { conversation, reused: false }, 201);
  });

  // Kill the list from the more general per-conversation routes so `/events`
  // and `/turns` are matched first (Playwright uses the most recent match).
  await page.route((url) => url.pathname.startsWith("/api/conversations/"), (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/")[3] ?? "";
    if (request.method() === "PATCH") {
      if (opts.failPatchOnce) {
        const failure = opts.failPatchOnce;
        opts.failPatchOnce = undefined;
        return json(route, { error: failure.error ?? "server_error", message: failure.message }, failure.status);
      }
      const conversation = opts.conversations.find((c) => c.id === id);
      if (!conversation) return json(route, { error: "not_found" }, 404);
      const body = JSON.parse(request.postData() ?? "{}") as { title?: string; archived?: boolean };
      if (typeof body.title === "string") {
        const title = body.title.trim().slice(0, 200) || "会话";
        // Mirror the server: only one active blank default may hold "新会话".
        if (title === DEFAULT_TITLE && conversation.archived === 0) {
          const other = opts.conversations.find((c) => c.id !== id && c.archived === 0 && c.title === DEFAULT_TITLE);
          if (other) {
            return json(
              route,
              { error: "conversation_conflict", message: "已有一个活跃的空白默认会话，请先给它命名或归档" },
              409,
            );
          }
        }
        conversation.title = title;
      }
      if (typeof body.archived === "boolean") conversation.archived = body.archived ? 1 : 0;
      conversation.updated_at = Date.now();
      return json(route, { conversation });
    }
    const conversation = opts.conversations.find((c) => c.id === id) ?? null;
    return json(route, { conversation, turns: [], approvals: [] });
  });
  await page.route((url) => url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/events"), (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      body: opts.sse?.[id] ?? replayOnly(),
    });
  });
  await page.route((url) => url.pathname === "/api/browser/tabs", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { url?: string };
    opts.onBrowserTab?.(body.url ?? "");
    return json(route, { ok: true, message: "已打开", data: null });
  });
  await page.route((url) => url.pathname === "/api/workspace/ticket", (route) =>
    json(route, {
      ticket: "test-ticket",
      origin: "http://127.0.0.1:4289",
      url: "http://127.0.0.1:4289/browser-ui?ticket=test-ticket",
      expiresAt: Date.now() + 60_000,
    }),
  );

  if (opts.browser) {
    // The mock tracks viewer ids so a spec can prove a hidden panel released its
    // lease and a reopened one re-claimed it, without a real container.
    const state: MockBrowserState = {
      state: opts.browser.startAsleep ? "asleep" : "awake",
      browserRunning: opts.browser.startAsleep ? false : true,
      restorePending: Boolean(opts.browser.startAsleep),
      idleRemainingMs: opts.browser.startAsleep ? null : 240_000,
      pins: [],
      lastErrorCode: opts.browser.snapshotBlockReason ? "snapshot_blocked" : null,
      lastError: opts.browser.snapshotBlockReason ?? null,
      unrestoredTabCount: null,
    };
    const viewers = new Set<string>();
    const publish = () => opts.browser?.onChange?.(state);
    const payload = () => browserStatusPayload(state, viewers.size);

    await page.route((url) => url.pathname === "/api/browser/status", (route) => {
      // Read-only: it must never change `state`.
      return json(route, { status: payload() });
    });
    await page.route((url) => url.pathname === "/api/browser/viewer/heartbeat", (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { id?: string; generation?: number };
      if (!body.id) return json(route, { error: "bad_viewer_id", message: "缺少有效的观看标识" }, 400);
      viewers.add(body.id);
      publish();
      return json(route, { ok: true, generation: body.generation ?? 1, status: payload() });
    });
    await page.route((url) => url.pathname === "/api/browser/viewer/release", (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { id?: string };
      if (body.id) viewers.delete(body.id);
      publish();
      return json(route, { ok: true, status: payload() });
    });
    await page.route((url) => url.pathname === "/api/browser/pin", (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { note?: string; ttlMs?: number; ui?: boolean };
      const pin = { id: `pin_${state.pins.length + 1}`, note: body.ui ? "UI 手动保留浏览器" : body.note ?? "手动保留", createdAt: Date.now(), expiresAt: null };
      state.pins.push(pin);
      state.idleRemainingMs = null;
      publish();
      return json(route, { ok: true, pin, status: payload() });
    });
    await page.route((url) => url.pathname === "/api/browser/pin/release", (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { id?: string; ui?: boolean };
      state.pins = state.pins.filter((p) => p.id !== body.id && !(body.ui && p.note === "UI 手动保留浏览器"));
      state.idleRemainingMs = 240_000;
      publish();
      return json(route, { ok: true, status: payload() });
    });
    await page.route((url) => url.pathname === "/api/browser/wake", (route) => {
      state.state = "awake";
      state.browserRunning = true;
      state.restorePending = false;
      state.idleRemainingMs = 240_000;
      publish();
      return json(route, { ok: true, status: payload() });
    });
  }
}

/**
 * GET /api/tasks over a spec's own rows, by the server's rules: counts over every
 * row (narrowed only by the search), the person's turn and running work first
 * under "all", then newest first. The cursor here is just an offset.
 */
export async function mockTaskList(page: Page, source: () => Task[]): Promise<void> {
  await page.route((url) => url.pathname === "/api/tasks", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const u = new URL(route.request().url());
    const filter = (u.searchParams.get("filter") ?? "all") as TaskFilter;
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    const limit = Number(u.searchParams.get("limit") ?? 30);
    const offset = Number(u.searchParams.get("cursor") ?? 0);
    const bucket = (t: Task) => taskBucket(t.status, Boolean(t.browser?.request));
    const at = (t: Task) => t.completedAt ?? t.createdAt;
    const rank = (t: Task) => (filter === "all" ? ({ attention: 0, working: 1 } as Record<string, number>)[bucket(t)] ?? 2 : 0);
    const found = source().filter((t) => !t.mergedInto && (!q || [t.title, t.text, t.description, t.clarification, t.result, t.schedule?.title].some((s) => s?.toLowerCase().includes(q))));
    const counts: TaskCounts = { all: found.length, attention: 0, working: 0, done: 0, stopped: 0 };
    for (const t of found) counts[bucket(t)]++;
    const list = found.filter((t) => filter === "all" || bucket(t) === filter).sort((a, b) => rank(a) - rank(b) || at(b) - at(a) || (a.id < b.id ? 1 : -1));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ counts, tasks: list.slice(offset, offset + limit), nextCursor: offset + limit < list.length ? String(offset + limit) : null }) });
  });
}
