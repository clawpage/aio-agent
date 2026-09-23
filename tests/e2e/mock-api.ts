import type { Page, Route } from "@playwright/test";

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
}

export async function mockConsole(page: Page, opts: MockConsoleOptions): Promise<void> {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route((url) => url.pathname === "/api/auth/session", (route) =>
    json(route, { authenticated: true, username: "owner" }),
  );
  await page.route((url) => url.pathname === "/api/status", (route) => json(route, opts.status ?? MOCK_STATUS));
  await page.route((url) => url.pathname === "/api/models", (route) => json(route, MOCK_MODELS));

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
}
