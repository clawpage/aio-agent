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
  Schedule,
  Turn,
} from "./types";
import { API_VERSION, apiCompatible } from "../../common/version";
import { locale, t, type Locale } from "./i18n";
import { clientPlatform, setAnalyticsSender } from "./analytics";

/**
 * Where the control plane's API lives. Empty (the default) means this page's own
 * origin, which is how the web console is served; a packaged app sets
 * VITE_AIO_API_BASE at build time to talk to a control plane elsewhere.
 */
export const API_BASE = String(import.meta.env.VITE_AIO_API_BASE ?? "").replace(/\/$/, "");
/** Same-origin pages send their cookies only to themselves; a remote API needs them sent across. */
export const API_CREDENTIALS: RequestCredentials = API_BASE ? "include" : "same-origin";

/** An API path (`/api/...`) as a URL this page can request or embed. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** A short message for responses that carry no usable JSON message. */
export function friendlyStatusMessage(status: number): string {
  switch (status) {
    case 401:
      return t.app.httpErrors.unauthorized;
    case 403:
      return t.app.httpErrors.forbidden;
    case 404:
      return t.app.httpErrors.notFound;
    case 413:
      return t.app.httpErrors.tooLarge;
    case 429:
      return t.app.httpErrors.rateLimited;
    case 502:
    case 503:
    case 504:
      return t.app.httpErrors.unavailable;
    default:
      return t.app.httpErrors.other(status);
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

/** The browser's IANA time zone, e.g. "Asia/Shanghai"; empty when it cannot tell. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
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
  init: { method?: string; body?: unknown; signal?: AbortSignal; cache?: RequestCache; keepalive?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const csrf = cookie("pa_csrf");
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (csrf) headers["x-csrf-token"] = csrf;
  headers["x-client-platform"] = clientPlatform();
  // The control plane writes its messages in this console's language.
  headers["x-aio-locale"] = locale;
  const res = await fetch(apiUrl(path), {
    method: init.method ?? "GET",
    headers,
    credentials: API_CREDENTIALS,
    signal: init.signal,
    cache: init.cache,
    keepalive: init.keepalive,
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

/** A camera as the card needs it (HaCameras' CameraInfo). */
export interface CameraInfo { entity: string; name: string; state: string; live: boolean; ptz: boolean; recordings: boolean; events: boolean }

export type PointerInput = { action: "click"; x: number; y: number } | { action: "scroll"; dy: number } | { action: "back" } | { action: "focus" };
/** `current`: the tab the page's key is on now (a link may have opened a new window). */
export type PointerResult = { title: string; url: string; editable?: boolean; current?: string };

/** One message the voice gadget sent, with its answer once there is one. */
export interface GadgetMessage { id: string; text: string; status: string; done: boolean; reply: string | null; error: string | null; createdAt: number; completedAt: number | null }

export const api = {
  supportRequest: (body: {kind: 'content' | 'deletion' | 'privacy'; taskId?: string; note: string}) => request<{id:string}>('/api/support/requests', {method:'POST',body}),
  supportQueue: () => request<{requests: Array<{id:string;kind:'content'|'deletion'|'privacy';account_username:string|null;account_email:string|null;username:string;email:string;title:string;content:string;note:string;status:string;decision:string|null;created_at:number}>}>('/api/settings/support', {cache:'no-store'}),
  reviewSupport: (id: string, decision: string) => request<{ok:true}>(`/api/settings/support/${encodeURIComponent(id)}/review`, {method:'POST',body:{decision}}),
  /** The account's phone (on a Mac it linked): offered at all, and which device is connected. */
  phoneScreenshotUrl: (at: number) => apiUrl(`/api/phone/screenshot?at=${at}`),
  /** The workspace's Mac browser: the pages of the AI's Chrome on the account's Mac, and the person's own pages there. */
  macShellStatus: () => request<import("./types").MacShellStatus>("/api/mac-shell/status", { cache: "no-store" }),
  macBrowserPages: () => request<{ state: "unlinked" | "offline" | "unavailable" | "ready"; pages: import("./types").MacBrowserPage[] }>("/api/user-browser/pages", { cache: "no-store" }),
  macBrowserOpen: (url: string) => request<{ page: number }>("/api/user-browser/pages", { method: "POST", body: { url } }),
  macBrowserClose: (page: number) => request<{ ok: boolean }>(`/api/user-browser/pages/${page}`, { method: "DELETE" }),
  phone: () => request<{ available: boolean; reachable?: boolean; device: { serial: string; model: string; name: string; android: string } | null }>("/api/phone", { cache: "no-store" }),
  /** Home Assistant cameras for camera cards (only accounts granted Home Assistant; others get 404). */
  camera: (entity: string, signal?: AbortSignal) => request<{ camera: CameraInfo; timeZone: string }>(`/api/cameras/${encodeURIComponent(entity)}`, { signal, cache: "no-store" }),
  cameraLive: (entity: string) => request<{ url: string }>(`/api/cameras/${encodeURIComponent(entity)}/live`, { cache: "no-store" }),
  cameraPlayback: (entity: string, at: string | number) => request<{ url: string; offset: number; start: number; end: number; next: number | null }>(`/api/cameras/${encodeURIComponent(entity)}/playback?at=${encodeURIComponent(String(at))}`, { cache: "no-store" }),
  cameraPtz: (entity: string, body: { direction: "left" | "right" | "up" | "down" }) => request<{ ok: true; done: string }>(`/api/cameras/${encodeURIComponent(entity)}/ptz`, { method: "POST", body }),
  cameraSnapshotUrl: (entity: string, at: number) => apiUrl(`/api/cameras/${encodeURIComponent(entity)}/snapshot?t=${at}`),
  cameraFrameUrl: (entity: string, at: string | number) => apiUrl(`/api/cameras/${encodeURIComponent(entity)}/frame?at=${encodeURIComponent(String(at))}`),
  gadgetHistory: (opts: { before?: number; limit?: number } = {}, signal?: AbortSignal) => request<{ account: string | null; messages: GadgetMessage[]; more: boolean }>(`/api/gadget/history?limit=${opts.limit ?? 50}${opts.before ? `&before=${opts.before}` : ''}`, { signal, cache: 'no-store' }),
  analytics: (days: number, signal?: AbortSignal) => request<import('../../common/analytics').AnalyticsReport>(`/api/analytics/report?days=${days}`, { signal, cache: 'no-store' }),
  usage: (days: number, signal?: AbortSignal) => request<import('../../common/usage').UsageReport>(`/api/usage?days=${days}`, { signal, cache: 'no-store' }),
  soul: () => request<{content:string;revision:string;defaultContent:string;maxBytes:number}>('/api/settings/soul'),
  recallStats: (days: number) => request<{ stats: import('./types').RecallStats }>(`/api/settings/recall?days=${days}`),
  dispatchLog: (taskId: string) => request<import('./types').DispatchLog>(`/api/settings/dispatch-log/${encodeURIComponent(taskId)}`),
  saveSoul: (body:{content:string;revision:string}) => request<{ok:true;content:string;revision:string}>('/api/settings/soul',{method:'PUT',body}),
  main: (before?: number, signal?: AbortSignal, limit?: number) => request<{ mode: "tasks"; tasks: import("./types").Task[]; nextBefore: number | null; version: string }>(`/api/main${before ? `?before=${before}` : limit ? `?limit=${limit}` : ""}`, { signal }),
  /** Clawpages: the account's published pages and mini apps, with their data tables. */
  clawpages: (signal?: AbortSignal) => request<{ pages: import("./types").Clawpage[] }>("/api/clawpages", { signal, cache: "no-store" }),
  /** An owner link: the page with a token (in its fragment) that opens every table to its owner for a while. */
  clawpageOpen: (page: string) => request<{ url: string }>(`/api/clawpages/${encodeURIComponent(page)}/open`, { method: "POST", body: {} }),
  /** A clawpage's cover picture; with its version the browser keeps it. */
  clawpageCoverUrl: (page: string, version?: number | null) => apiUrl(`/api/clawpages/${encodeURIComponent(page)}/cover${version ? `?v=${version}` : ""}`),
  clawpageDelete: (page: string) => request<void>(`/api/clawpages/${encodeURIComponent(page)}`, { method: "DELETE" }),
  /** Other people's agents allowed to maintain a clawpage. */
  clawpageCollaborators: (page: string) => request<{ collaborators: import("./types").ClawpageCollaborator[] }>(`/api/clawpages/${encodeURIComponent(page)}/collaborators`, { cache: "no-store" }),
  /** A new collaborator: its invitation (API and token) is shown once. */
  clawpageInvite: (page: string, label: string) =>
    request<import("./types").ClawpageCollaborator & { api: string; invitation: string }>(`/api/clawpages/${encodeURIComponent(page)}/collaborators`, { method: "POST", body: { label } }),
  clawpageRevoke: (page: string, id: string) => request<void>(`/api/clawpages/${encodeURIComponent(page)}/collaborators/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Earlier versions of a clawpage, newest first; restoring one makes it the live page again (files only). */
  clawpageVersions: (page: string) => request<{ versions: import("./types").ClawpageVersion[] }>(`/api/clawpages/${encodeURIComponent(page)}/versions`, { cache: "no-store" }),
  clawpageRestore: (page: string, at: number) => request<import("./types").Clawpage>(`/api/clawpages/${encodeURIComponent(page)}/versions/${at}/restore`, { method: "POST", body: {} }),
  clawpageRecords: (page: string, table: string, after?: string | null, signal?: AbortSignal) =>
    request<{ records: import("./types").ClawpageRecord[]; nextCursor: string | null }>(`/api/clawpages/${encodeURIComponent(page)}/tables/${encodeURIComponent(table)}?limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`, { signal, cache: "no-store" }),
  clawpageExportUrl: (page: string, table: string) => apiUrl(`/api/clawpages/${encodeURIComponent(page)}/tables/${encodeURIComponent(table)}/export`),
  clawpagePermission: (page: string, table: string, permission: import("./types").ClawpagePermission) =>
    request<import("./types").ClawpageTable>(`/api/clawpages/${encodeURIComponent(page)}/tables/${encodeURIComponent(table)}`, { method: "PATCH", body: { permission } }),
  clawpageDropTable: (page: string, table: string) => request<void>(`/api/clawpages/${encodeURIComponent(page)}/tables/${encodeURIComponent(table)}`, { method: "DELETE" }),
  /** Signing in to a clawpage (any account's): the page and who would sign in, then the way back with the sign-in. */
  clawpageSsoPage: (q: { owner: string; page: string; return: string }) =>
    request<import("./types").ClawpageSsoPage>(`/api/clawpage-sso/page?${new URLSearchParams(q)}`, { cache: "no-store" }),
  clawpageSsoGrant: (q: { owner: string; page: string; return: string }) => request<{ url: string }>("/api/clawpage-sso/grant", { method: "POST", body: q }),
  clawpageDeleteRecord: (page: string, table: string, key: string) =>
    request<void>(`/api/clawpages/${encodeURIComponent(page)}/tables/${encodeURIComponent(table)}/records/${encodeURIComponent(key)}`, { method: "DELETE" }),
  /** The files page: the main session's messages that hold files, newest first; older ones by `before`. */
  mainFiles: (before?: number, signal?: AbortSignal) => request<{ messages: import("./types").FileMessage[]; nextBefore: number | null }>(`/api/main/files${before ? `?before=${before}` : ""}`, { signal, cache: "no-store" }),
  /** The live first page, unless it is still the version the caller holds. */
  mainSince: (version: string | null) => request<{ mode: "tasks"; unchanged: true; version: string } | { mode: "tasks"; unchanged?: undefined; tasks: import("./types").Task[]; nextBefore: number | null; version: string }>(`/api/main${version ? `?v=${encodeURIComponent(version)}` : ""}`),
  /** The task list: counts by status and one filtered page; `cursor` continues where the last page ended. */
  taskPage: (q: { filter: import("../../common/taskList").TaskFilter; query: string; cursor: string | null; limit: number }, signal?: AbortSignal) =>
    request<import("../../common/taskList").TaskListPage<import("./types").Task>>(`/api/tasks?${new URLSearchParams({ filter: q.filter, limit: String(q.limit), ...(q.query ? { q: q.query } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) })}`, { signal, cache: "no-store" }),
  // The console language travels with each message: the agents write for the person in it.
  submitTask: (body: { text: string; clientMessageId: string; attachments: Attachment[]; relatedTaskId: string | null }) => request<{ task: import("./types").Task; duplicate: boolean }>("/api/tasks", { method: "POST", body: { ...body, locale } }),
  // keepalive: the page reloads into the new language right away, and the request outlives it.
  setAccountLocale: (next: Locale) => request<{ ok: true }>("/api/account/locale", { method: "PUT", body: { locale: next }, keepalive: true }),
  /** The language this console opened in; the account takes it once, and never over a choice made in settings. */
  syncAccountLocale: (current: Locale) => request<{ ok: true; applied: boolean }>("/api/account/locale", { method: "PUT", body: { locale: current, sync: true } }),
  archiveTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/archive`, { method: "POST", body: {} }),
  stopTask: (id: string) => request<{ok:boolean}>(`/api/tasks/${encodeURIComponent(id)}/stop`, {method:"POST",body:{}}),
  retryTaskPlanning: (id: string) => request<{ok:boolean}>(`/api/tasks/${encodeURIComponent(id)}/retry-planning`, {method:"POST",body:{}}),
  task: (id: string) => request<{ task: import("./types").Task }>(`/api/tasks/${encodeURIComponent(id)}`, { cache: "no-store" }),
  taskBrowser: (id: string) => request<{ tabs: import("./types").TaskTab[] }>(`/api/tasks/${encodeURIComponent(id)}/browser`),
  taskBrowserControl: (id: string, tab: string, action: "take" | "release") => request<{ tab: import("./types").TaskTab }>(`/api/tasks/${encodeURIComponent(id)}/browser/control`, { method: "POST", body: { tab, action } }),
  taskBrowserPointer: (id: string, tab: string, input: PointerInput) =>
    request<PointerResult>(`/api/tasks/${encodeURIComponent(id)}/browser/pointer`, { method: "POST", body: { tab, ...input } }),
  /** The person's own tabs: links opened from a reply. */
  personBrowserPointer: (tab: string, input: PointerInput) => request<PointerResult>("/api/browser/person/pointer", { method: "POST", body: { tab, ...input } }),
  personBrowserClose: (tab: string) => request<{ closed: string }>("/api/browser/person/close", { method: "POST", body: { tab } }),
  /** Answer a task's sign-in request from the vault: a saved account, or one typed now (saved unless `save` is false). */
  taskBrowserLogin: (id: string, tab: string, account: { entryId: string } | { username: string; password: string; save: boolean } | { method: "google"; username: string; save: boolean }) =>
    request<{ result: string; error?: string }>(`/api/tasks/${encodeURIComponent(id)}/browser/login`, { method: "POST", body: { tab, ...account } }),
  vault: (site?: string) => request<{ entries: import("./types").VaultEntry[]; scripts?: import("./types").VaultScript[] }>(`/api/vault${site ? `?site=${encodeURIComponent(site)}` : ""}`, { cache: "no-store" }),
  vaultCreate: (entry: { site: string; username: string; password?: string; method?: "password" | "google" }) => request<{ entry: import("./types").VaultEntry }>("/api/vault", { method: "POST", body: entry }),
  vaultUpdate: (id: string, entry: { site?: string; username?: string; password?: string; method?: "password" | "google" }) => request<{ entry: import("./types").VaultEntry }>(`/api/vault/${encodeURIComponent(id)}`, { method: "PUT", body: entry }),
  vaultDelete: (id: string) => request<{ ok: boolean }>(`/api/vault/${encodeURIComponent(id)}`, { method: "DELETE" }),
  vaultForgetScript: (site: string) => request<{ ok: boolean }>(`/api/vault/scripts/${encodeURIComponent(site)}`, { method: "DELETE" }),
  vaultReveal: (id: string) => request<{ password: string }>(`/api/vault/${encodeURIComponent(id)}/reveal`, { method: "POST", body: {} }),
  taskBrowserLastShotUrl: (id: string, at: number) => apiUrl(`/api/tasks/${encodeURIComponent(id)}/browser/last-shot?at=${at}`),
  taskBrowserReopen: (id: string) => request<{ tab: import("./types").TaskTab }>(`/api/tasks/${encodeURIComponent(id)}/browser/reopen`, { method: "POST", body: {} }),
  taskUserBrowserScreenshotUrl: (id: string, at: number) => apiUrl(`/api/tasks/${encodeURIComponent(id)}/user-browser/screenshot?at=${at}`),
  taskUserBrowserControl: (id: string, action: "take" | "release") => request<{ userBrowser: import("./types").UserBrowserState }>(`/api/tasks/${encodeURIComponent(id)}/user-browser/control`, { method: "POST", body: { action } }),
  taskBrowserScreenshotUrl: (id: string, tab: string, at: number) => apiUrl(`/api/tasks/${encodeURIComponent(id)}/browser/screenshot?tab=${encodeURIComponent(tab)}&at=${at}`),
  session: (signal?: AbortSignal) => request<{ authenticated: boolean; role?: "owner" | "member"; username: string | null; email?: string | null; expiresAt?: number; secure?: boolean; inviteEmail?: string | null; registrationRequiresInvite?: boolean }>("/api/auth/session", {signal,cache:"no-store"}),
  /** `email` is the account's email, or the username of an account from before email. */
  // Signing in tells the server the browser's time zone: the daily feed follows it.
  login: (password: string, email = "owner") => request<{ ok: boolean; username: string; expiresAt: number }>("/api/auth/login", { method: "POST", body: { password, email, timeZone: browserTimeZone() } }),
  register: (account: { email: string; password: string; inviteCode: string }) => request<{ ok: boolean; username: string; expiresAt: number }>("/api/auth/register", { method: "POST", body: { ...account, timeZone: browserTimeZone() } }),
  googlePending: (signal?: AbortSignal) => request<{enabled: boolean; pending: {email: string} | null}>("/api/auth/google/pending", {cache: "no-store", signal}),
  googleStart: (native: boolean) => request<{url: string}>("/api/auth/google/start", {method: "POST", body: {native, timeZone: browserTimeZone()}}),
  googleRedeem: (ticket: string) => request<{authenticated: boolean; pending?: {email: string}}>("/api/auth/google/redeem", {method: "POST", body: {ticket}}),
  googleRegister: (account: {inviteCode: string}) => request<{ok: boolean}>("/api/auth/google/register", {method: "POST", body: account}),
  googleCancel: () => request<{ok: boolean}>("/api/auth/google/cancel", {method: "POST"}),
  deviceLinks: () => request<{ links: import("./types").DeviceLink[] }>("/api/device-links", { cache: "no-store" }),
  createDeviceLink: (name: string) => request<{ link: import("./types").DeviceLink; token: string }>("/api/device-links", { method: "POST", body: { name } }),
  deleteDeviceLink: (id: string) => request<{ ok: boolean }>(`/api/device-links/${encodeURIComponent(id)}`, { method: "DELETE" }),
  invites: () => request<{ invites: import("./types").Invite[] }>("/api/settings/invites", { cache: "no-store" }),
  createInvite: (note: string) => request<{ invite: import("./types").Invite }>("/api/settings/invites", { method: "POST", body: { note } }),
  revokeInvite: (code: string) => request<{ ok: boolean }>(`/api/settings/invites/${encodeURIComponent(code)}`, { method: "DELETE" }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: {} }),
  refresh: () => request<{ ok: boolean; expiresAt: number }>("/api/auth/refresh", { method: "POST", body: {} }),
  status: () => request<StatusResponse>("/api/status"),
  schedules: () => request<{ schedules: Schedule[] }>("/api/schedules", { cache: "no-store" }),
  knowledge: () => request<import("./types").KnowledgeOverview>("/api/knowledge", { cache: "no-store" }),
  knowledgeNode: (id: string) => request<{ node: import("./types").KnowledgeNode }>(`/api/knowledge/nodes/${encodeURIComponent(id)}`, { cache: "no-store" }),
  knowledgeDeleteNode: (id: string) => request<{ ok: boolean }>(`/api/knowledge/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  knowledgeDeleteDomain: (name: string) => request<{ ok: boolean; deleted: number }>(`/api/knowledge/domains/${encodeURIComponent(name)}`, { method: "DELETE" }),
  knowledgeSettings: (enabled: boolean) => request<{ enabled: boolean }>("/api/knowledge/settings", { method: "POST", body: { enabled } }),
  pushInfo: () => request<{ supported: boolean; publicKey?: string; devices?: number }>("/api/push", { cache: "no-store" }),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<{ ok: boolean; devices: number }>("/api/push/subscribe", { method: "POST", body: { subscription } }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: boolean }>("/api/push/unsubscribe", { method: "POST", body: { endpoint } }),
  pushTest: () => request<{ sent: number }>("/api/push/test", { method: "POST", body: {} }),
  scheduleUpdate: (id: string, changes: { title?: string; instruction?: string; schedule?: import("./types").ScheduleSpec; needsBrowser?: boolean }) =>
    request<{ message: string; schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: changes }),
  scheduleAction: (id: string, action: "pause" | "resume" | "cancel" | "run") =>
    request<{ message?: string; schedule: Schedule | null }>(`/api/schedules/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {} }),
  /** The console is on screen: keeps the account's container up, and starts a stopped one. */
  presence: (endpoint?: string) => request<{ ok: boolean }>("/api/presence", { method: "POST", body: endpoint ? { attended: true, endpoint } : { attended: true } }),

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
  /** The latest turns of a conversation (before an event id, for older ones); `more` is absent from a control plane that sends everything. */
  eventsTail: (id: string, before?: number, signal?: AbortSignal) =>
    request<{ events: import("./types").AgentEvent[]; more?: boolean }>(`/api/conversations/${encodeURIComponent(id)}/events?format=json&tail=200${before ? `&before=${before}` : ""}`, { signal, cache: "no-store" }),
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
  /** Every page open in the workspace browser, a small preview of one, and bringing one to the front. */
  browserOverview: () => request<{ pages: import("./types").OverviewPage[] }>("/api/browser/overview"),
  browserOverviewShotUrl: (target: string, at: number) => apiUrl(`/api/browser/overview/shot?target=${encodeURIComponent(target)}&at=${at}`),
  browserFront: (target: string) => request<{ target: string }>("/api/browser/overview/front", { method: "POST", body: { target } }),
  openBrowserTab: (url: string, signal?: AbortSignal) =>
    request<{ ok: boolean; message: string; data: unknown; tab?: import("./types").TaskTab }>("/api/browser/tabs", { method: "POST", body: { url }, signal }),
  /** Open a workspace HTML page in full in a new tab of the sandbox's Chromium (no inline size cap). */
  openBrowserFile: (path: string, signal?: AbortSignal) =>
    request<{ ok: boolean; tab: import("./types").TaskTab }>("/api/browser/files", { method: "POST", body: { path }, signal }),
  capabilities: () => request<CapabilitiesResponse>("/api/capabilities"),
  /** Voice input: whether a speech recognizer is configured, and what a WAV recording says. */
  asr: () => request<{ enabled: boolean; locales?: string[] }>("/api/asr"),
  transcribe: (wav: Uint8Array, microphone?: import("./voice").MicrophoneInfo) => {
    let binary = "";
    for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
    return request<{ text: string }>("/api/asr", { method: "POST", body: { audioBase64: btoa(binary), microphone } });
  },
  sandboxContext: () => request<{ context: string | null }>("/api/sandbox/context"),

  ticket: (next = "/") => request<{ ticket: string; origin: string; url: string; expiresAt: number }>("/api/workspace/ticket", { method: "POST", body: { next } }),

  upload: (file: File, dir?: string) =>
    new Promise<Attachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(t.app.fileReadFailed));
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
  downloadUrl: (path: string) => apiUrl(`/api/files/download?path=${encodeURIComponent(path)}`),

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
    apiUrl(`/api/documents/page?path=${encodeURIComponent(path)}&page=${page}`),
  /**
   * Inline image URL. Not the download endpoint: that one is octet-stream with an
   * attachment disposition, which an `<img>` will not render. The server sniffs
   * the bytes and refuses anything that is not really an image.
   */
  documentImageUrl: (path: string) => apiUrl(`/api/documents/image?path=${encodeURIComponent(path)}`),
  /** A web picture in a message, fetched by the account's own sandbox (https only). */
  webImageUrl: (url: string) => apiUrl(`/api/documents/web-image?url=${encodeURIComponent(url)}`),
  /** Audio or video, streamed with byte ranges for the native players. */
  documentMediaUrl: (path: string) => apiUrl(`/api/documents/media?path=${encodeURIComponent(path)}`),
  createTerminalSession: () => request<{id:string}>("/api/sandbox/shell-sessions", {method:"POST",body:{}}),
  closeTerminalSession: (id:string) => request<{ok:boolean}>(`/api/sandbox/shell-sessions/${encodeURIComponent(id)}`, {method:"DELETE"}),
  terminalSessions: (signal?: AbortSignal) => request<{sessions:Array<{id:string;status:string;workingDir:string;lastUsedAt:string|null}>}>("/api/sandbox/shell-sessions", {signal}),
  convertDocument: (path: string, format: string) =>
    request<{ path: string; bytes: number }>("/api/documents/convert", { method: "POST", body: { path, format } }),
  documentHtmlUrl: (path: string) => apiUrl(`/api/documents/html?path=${encodeURIComponent(path)}`),
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
  /** Never released for idleness: logins stay in the one live browser. */
  resident?: boolean;
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
export const UI_KEEP_ALIVE_NOTE = "UI 手动保留浏览器"; // i18n-exempt: protocol token matched by the server's pin note

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
  const source = new EventSource(apiUrl(`/api/conversations/${encodeURIComponent(conversationId)}/events?since=${since}`), { withCredentials: Boolean(API_BASE) });
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
    // A supplement steered into the running turn, shown as the person's message.
    "turn.input_appended",
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

/**
 * `mismatch` is null when this page and the control plane speak compatible API versions, else
 * a message for the person; `answered` says whether the control plane has the version endpoint at all. A page cached from an older or newer release is told
 * to reload instead of half-working.
 */
export async function versionMismatch(): Promise<{ answered: boolean; mismatch: string | null }> {
  try {
    const v = await request<{ api: number; apiMin: number }>("/api/version", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (apiCompatible(API_VERSION, v.api, v.apiMin)) return { answered: true, mismatch: null };
    return { answered: true, mismatch: t.app.versionMismatch(API_VERSION, v.apiMin, v.api, v.api < API_VERSION ? "server" : "ui") };
  } catch {
    // An older control plane has no version endpoint; it is served as before (see App's legacy mode).
    return { answered: false, mismatch: null };
  }
}

setAnalyticsSender((name, props) => request("/api/analytics", { method: "POST", body: { name, props }, keepalive: true }));
