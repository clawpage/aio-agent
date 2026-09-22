import type {
  ApprovalRequest,
  Attachment,
  CapabilitiesResponse,
  Conversation,
  FileEntry,
  ModelInfo,
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

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const csrf = cookie("pa_csrf");
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (csrf) headers["x-csrf-token"] = csrf;
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    credentials: "same-origin",
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
  session: () => request<{ authenticated: boolean; username: string | null; expiresAt?: number; secure?: boolean }>("/api/auth/session"),
  login: (password: string) => request<{ ok: boolean; username: string; expiresAt: number }>("/api/auth/login", { method: "POST", body: { password } }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: {} }),
  refresh: () => request<{ ok: boolean; expiresAt: number }>("/api/auth/refresh", { method: "POST", body: {} }),
  status: () => request<StatusResponse>("/api/status"),

  conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
  createConversation: (title?: string) => request<{ conversation: Conversation }>("/api/conversations", { method: "POST", body: { title: title ?? "" } }),
  updateConversation: (id: string, patch: { title?: string; archived?: boolean }) =>
    request<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  conversation: (id: string) =>
    request<{ conversation: Conversation; turns: Turn[]; approvals: ApprovalRequest[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  events: async (id: string, since = 0) =>
    (await request<{ events: import("./types").AgentEvent[] }>(`/api/conversations/${encodeURIComponent(id)}/events?format=json&since=${since}`)).events,
  submitTurn: (id: string, body: { text: string; clientMessageId: string; attachments?: Attachment[]; model?: string | null; effort?: string | null }) =>
    request<{ turn: Turn; duplicate: boolean }>(`/api/conversations/${encodeURIComponent(id)}/turns`, { method: "POST", body }),
  interrupt: (id: string) =>
    request<{ ok: boolean; status: string; message: string }>(`/api/conversations/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: {} }),

  approvals: () => request<{ approvals: ApprovalRequest[] }>("/api/approvals"),
  respond: (requestId: string, decision: string, extra?: unknown) =>
    request<{ ok: boolean; message: string }>(`/api/approvals/${encodeURIComponent(requestId)}/respond`, { method: "POST", body: { decision, extra } }),

  models: () => request<{ models: ModelInfo[] }>("/api/models"),
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

  sandboxRequest: (method: string, path: string, body?: unknown) =>
    request<{ status: number; contentType: string | null; body: string }>("/api/sandbox/request", { method: "POST", body: { method, path, body } }),
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
