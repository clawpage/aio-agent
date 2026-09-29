import type {
  AgentSettings,
  ApprovalRequest,
  Attachment,
  CapabilitiesResponse,
  Conversation,
  FileEntry,
  ModelInfo,
  SettingsResponse,
  StatusResponse,
  Turn,
} from "./types";

/** Short Chinese fallback for responses that carry no usable JSON message. */
export function friendlyStatusMessage(status: number): string {
  switch (status) {
    case 401:
      return "登录已失效，请重新登录";
    case 403:
      return "请求被拒绝";
    case 404:
      return "接口不存在";
    case 413:
      return "内容过大";
    case 429:
      return "请求过于频繁，已被限流，请稍后再试";
    case 502:
    case 503:
    case 504:
      return "服务暂时不可用，请稍后重试";
    default:
      return `请求失败（HTTP ${status}）`;
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cookie(name: string): string {
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const csrf = cookie("pa_csrf");
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (csrf) headers["x-csrf-token"] = csrf;
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    credentials: "same-origin",
    signal: init.signal,
    cache: init.cache,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON bodies happen when an edge/proxy answers instead of our API
      // (rate limiting, maintenance pages). Never surface raw HTML in the UI.
      parsed = null;
    }
  }
  if (!res.ok) {
    const body = (parsed ?? {}) as { error?: string; message?: string };
    const readable =
      typeof body.message === "string" && body.message.trim().length > 0 && body.message.length <= 300
        ? body.message
        : friendlyStatusMessage(res.status);
    throw new ApiError(res.status, body.error ?? "error", readable);
  }
  return (parsed ?? {}) as T;
}

export const api = {
  soul: () => request<{content:string;revision:string;defaultContent:string;maxBytes:number}>('/api/settings/soul'),
  saveSoul: (body:{content:string;revision:string}) => request<{ok:true;content:string;revision:string}>('/api/settings/soul',{method:'PUT',body}),
  main: (before?: number) => request<{ mode: "tasks"; tasks: import("./types").Task[]; nextBefore: number | null }>(`/api/main${before ? `?before=${before}` : ""}`),
  submitTask: (body: { text: string; clientMessageId: string; attachments: Attachment[]; relatedTaskId: string | null }) => request<{ task: import("./types").Task; duplicate: boolean }>("/api/tasks", { method: "POST", body }),
  stopTask: (id: string) => request<{ok:boolean}>(`/api/tasks/${encodeURIComponent(id)}/stop`, {method:"POST",body:{}}),
  retryTaskPlanning: (id: string) => request<{ok:boolean}>(`/api/tasks/${encodeURIComponent(id)}/retry-planning`, {method:"POST",body:{}}),
  session: (signal?: AbortSignal) => request<{ authenticated: boolean; role?: "owner" | "member"; username: string | null; expiresAt?: number; secure?: boolean }>("/api/auth/session", {signal,cache:"no-store"}),
  login: (password: string, username = "owner") => request<{ ok: boolean; username: string; expiresAt: number }>("/api/auth/login", { method: "POST", body: { password, username } }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: {} }),
  refresh: () => request<{ ok: boolean; expiresAt: number }>("/api/auth/refresh", { method: "POST", body: {} }),
  status: () => request<StatusResponse>("/api/status"),

  conversations: (includeArchived = false) =>
    request<{ conversations: Conversation[] }>(`/api/conversations${includeArchived ? "?archived=1" : ""}`),
  createConversation: (title?: string) =>
    request<{ conversation: Conversation; reused: boolean }>("/api/conversations", { method: "POST", body: { title: title ?? "" } }),
  updateConversation: (id: string, patch: { title?: string; archived?: boolean }) =>
    request<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  conversation: (id: string) =>
    request<{ conversation: Conversation; turns: Turn[]; approvals: ApprovalRequest[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  events: async (id: string, since = 0) =>
    (await request<{ events: import("./types").AgentEvent[] }>(`/api/conversations/${encodeURIComponent(id)}/events?format=json&since=${since}`)).events,
  submitTurn: (id: string, body: { text: string; clientMessageId: string; attachments?: Attachment[] }) =>
    request<{ turn: Turn; duplicate: boolean }>(`/api/conversations/${encodeURIComponent(id)}/turns`, { method: "POST", body }),
  interrupt: (id: string) =>
    request<{ ok: boolean; status: string; message: string }>(`/api/conversations/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: {} }),

  approvals: () => request<{ approvals: ApprovalRequest[] }>("/api/approvals"),
  respond: (requestId: string, decision: string, extra?: unknown) =>
    request<{ ok: boolean; message: string }>(`/api/approvals/${encodeURIComponent(requestId)}/respond`, { method: "POST", body: { decision, extra } }),

  models: () => request<{ models: ModelInfo[] }>("/api/models"),

  /** Unified owner settings applied to every later message. */
  settings: () => request<SettingsResponse>("/api/settings"),
  saveSettings: (body: AgentSettings) =>
    request<{ ok: boolean; settings: AgentSettings }>("/api/settings", { method: "PUT", body }),

  /** Open a link in a new tab of the sandbox's real Chromium (validated server-side). */
  openBrowserTab: (url: string) =>
    request<{ ok: boolean; message: string; data: unknown }>("/api/browser/tabs", { method: "POST", body: { url } }),
  capabilities: () => request<CapabilitiesResponse>("/api/capabilities"),
  sandboxContext: () => request<{ context: string | null }>("/api/sandbox/context"),

  ticket: (next = "/") => request<{ ticket: string; origin: string; url: string; expiresAt: number }>("/api/workspace/ticket", { method: "POST", body: { next } }),

  upload: (file: File, dir?: string) =>
    new Promise<Attachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.onload = () => {
        void (async () => {
          try {
            const contentBase64 = String(reader.result).split(",")[1] ?? "";
            const result = await request<Attachment>("/api/sandbox/upload", {
              method: "POST",
              body: { name: file.name, mime: file.type, contentBase64, dir },
            });
            resolve(result);
          } catch (err) {
            reject(err);
          }
        })();
      };
      reader.readAsDataURL(file);
    }),

  listFiles: (path: string) => request<{ path: string; files: FileEntry[] }>(`/api/files/list?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => request<{ path: string; content: string }>(`/api/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) => request<{ ok: boolean }>("/api/files/write", { method: "POST", body: { path, content } }),
  deleteFile: (path: string) => request<{ ok: boolean }>("/api/files/delete", { method: "POST", body: { path } }),
  mkdir: (path: string) => request<{ ok: boolean }>("/api/files/mkdir", { method: "POST", body: { path } }),
  downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,

  /**
   * Sandbox document tools. The control plane validates the path (lexically and
   * with `realpath` inside the container) and only ever returns rasterised PNG
   * pages or short text — never raw Office/PDF bytes.
   */
  documentReadiness: (refresh = false) =>
    request<import("./types").DocumentReadiness>(`/api/documents/readiness${refresh ? "?refresh=1" : ""}`),
  provisionDocuments: () =>
    request<{ ok: boolean; message: string; readiness: import("./types").DocumentReadiness }>("/api/documents/provision", {
      method: "POST",
      body: {},
    }),
  documentInfo: (path: string) =>
    request<import("./types").DocumentInfo>(`/api/documents/info?path=${encodeURIComponent(path)}`),
  documentRender: (path: string, signal?: AbortSignal) =>
    request<import("./types").DocumentRender>(`/api/documents/render?path=${encodeURIComponent(path)}`, { signal }),
  documentPageUrl: (path: string, page: number) =>
    `/api/documents/page?path=${encodeURIComponent(path)}&page=${page}`,
  /**
   * Inline image URL. Not the download endpoint: that one is octet-stream with an
   * attachment disposition, which an `<img>` will not render. The server sniffs
   * the bytes and refuses anything that is not really an image.
   */
  documentImageUrl: (path: string) => `/api/documents/image?path=${encodeURIComponent(path)}`,
  documentVideoUrl: (path: string) => `/api/documents/video?path=${encodeURIComponent(path)}`,
  createTerminalSession: () => request<{id:string}>("/api/sandbox/shell-sessions", {method:"POST",body:{}}),
  closeTerminalSession: (id:string) => request<{ok:boolean}>(`/api/sandbox/shell-sessions/${encodeURIComponent(id)}`, {method:"DELETE"}),
  terminalSessions: (signal?: AbortSignal) => request<{sessions:Array<{id:string;status:string;workingDir:string;lastUsedAt:string|null}>}>("/api/sandbox/shell-sessions", {signal}),
  convertDocument: (path: string, format: string) =>
    request<{ path: string; bytes: number }>("/api/documents/convert", { method: "POST", body: { path, format } }),
  documentHtmlUrl: (path: string) => `/api/documents/html?path=${encodeURIComponent(path)}`,
  documentText: (path: string, signal?: AbortSignal) =>
    request<{ path: string; text: string; size: number; truncated: boolean }>(
      `/api/documents/text?path=${encodeURIComponent(path)}`,
      { signal },
    ),

  sandboxRequest: (method: string, path: string, body?: unknown) =>
    request<{ status: number; contentType: string | null; body: string }>("/api/sandbox/request", { method: "POST", body: { method, path, body } }),
};

export interface BrowserLifecycleStateView {
  enabled: boolean;
  state: string;
  stateLabel: string;
  idleDeadline: number | null;
  idleRemainingMs: number | null;
  idleMinutes: number | null;
  since: number;
  epoch: number;
  leases: { turns: number; viewers: number; calls: number; holds: number; pins: number };
  viewers: number;
  holds: number;
  pins: Array<{ id: string; note: string; createdAt: number; expiresAt: number | null }>;
  held: boolean;
  browserRunning: boolean | null;
  snapshotAt: number | null;
  restoredSnapshotAt: number | null;
  restorePending: boolean;
  lastError: string | null;
  lastErrorCode: string | null;
  lastSnapshotWarnings: Array<{ code: string; message: string; tabIndex: number | null }>;
  unrestoredTabCount: number | null;
}

/**
 * Browser lifecycle control-plane client.
 *
 * `status` is a read-only poll and deliberately never renews the lease; heartbeats
 * come only from a visible panel. Keeping them separate is what lets the idle
 * countdown actually reach zero while the UI is open.
 */
/** Fixed note of the panel's own keep-awake pin; mirrors the server constant. */
export const UI_KEEP_ALIVE_NOTE = "UI 手动保留浏览器";

export const browserApi = {
  status: () => request<{ status: BrowserLifecycleStateView }>("/api/browser/status"),
  heartbeat: (id: string, generation: number) =>
    request<{ ok: boolean; generation: number; status: BrowserLifecycleStateView }>("/api/browser/viewer/heartbeat", {
      method: "POST",
      body: { id, generation },
    }),
  releaseViewer: (id: string, generation: number) =>
    request<{ ok: boolean }>("/api/browser/viewer/release", { method: "POST", body: { id, generation } }),
  /**
   * The browser panel's keep-awake switch, identified by a fixed server-side note
   * rather than by a client-held id, so a reload or a second window re-derives the
   * same pin from `status().pins` and can always release it. A caller that wants a
   * script/operator pin passes its own note.
   */
  pinUi: () =>
    request<{ ok: boolean; pin: { id: string; note: string; expiresAt: number | null }; status: BrowserLifecycleStateView }>(
      "/api/browser/pin",
      { method: "POST", body: { ui: true } },
    ),
  unpinUi: () =>
    request<{ ok: boolean; status: BrowserLifecycleStateView }>("/api/browser/pin/release", {
      method: "POST",
      body: { ui: true },
    }),
  pin: (note: string, ttlMs?: number) =>
    request<{ ok: boolean; pin: { id: string; note: string; expiresAt: number | null } }>("/api/browser/pin", {
      method: "POST",
      body: ttlMs === undefined ? { note } : { note, ttlMs },
    }),
  unpin: (id: string) => request<{ ok: boolean }>("/api/browser/pin/release", { method: "POST", body: { id } }),
  wake: () => request<{ ok: boolean; status: BrowserLifecycleStateView }>("/api/browser/wake", { method: "POST", body: {} }),
};

/** Open an authenticated EventSource for a conversation, resuming from `since`. */
export function openEventStream(
  conversationId: string,
  since: number,
  handlers: {
    onEvent: (event: import("./types").AgentEvent) => void;
    onOpen?: () => void;
    onError?: () => void;
    onRevoked?: () => void;
  },
): () => void {
  const source = new EventSource(`/api/conversations/${encodeURIComponent(conversationId)}/events?since=${since}`);
  const handle = (raw: MessageEvent) => {
    try {
      handlers.onEvent(JSON.parse(raw.data) as import("./types").AgentEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  // Named SSE events need explicit listeners; keep a generic listener for the rest.
  source.addEventListener("replay.complete", () => handlers.onOpen?.());
  source.addEventListener("session.revoked", () => handlers.onRevoked?.());
  const knownTypes = [
    "conversation.created",
    "conversation.title_updated",
    "turn.queued",
    "turn.started",
    "turn.codex_started",
    "turn.finished",
    "turn.failed",
    "turn.cancelled",
    "turn.interrupt_requested",
    "turn.reconciled",
    "thread.started",
    "stream.delta",
    "approval.requested",
    "approval.resolved",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "error",
    "warning",
  ];
  for (const type of knownTypes) source.addEventListener(type, handle as EventListener);
  source.onmessage = handle;
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}
