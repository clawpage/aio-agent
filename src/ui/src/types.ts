export interface AgentEvent {
  id: number;
  type: string;
  turnId: string | null;
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  title: string;
  codex_thread_id: string | null;
  model: string | null;
  cwd: string | null;
  status: string;
  archived: number;
  created_at: number;
  updated_at: number;
  turnCount?: number;
}

export interface Turn {
  id: string;
  conversation_id: string;
  status: string;
  codex_turn_id: string | null;
  input_text: string;
  attachments_json: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface ApprovalRequest {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  codex_request_id: string;
  method: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: number;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  /** Codex provider for this model; null/absent means the ChatGPT account. */
  modelProvider?: string | null;
}

/**
 * Unified owner settings applied to every later message. `null` means "use the
 * model's own default" (model) or "use the model's default effort" (effort).
 */
export interface AgentSettings {
  model: string | null;
  effort: string | null;
}

/** One model as the settings page needs it to validate an effort choice. */
export interface SettingsModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  /** Present for catalog entries that are not plain ChatGPT models. */
  inputModalities?: string[];
  modelProvider?: string | null;
}

export interface SettingsResponse {
  settings: AgentSettings;
  defaultModel: string;
  models: SettingsModel[];
  /**
   * Whether the stored model is still offered by the catalog. `null` when the
   * catalog is unknown, so the UI must not claim it is unusable.
   */
  savedModelAvailable: boolean | null;
}

export interface StatusResponse {
  agent: {
    sessionReady: boolean;
    account: { email: string | null; planType: string | null; type: string } | null;
    activeTurnId: string | null;
    activeConversationId: string | null;
    activeTurns?: Array<{ conversationId: string; turnId: string; codexTurnId: string | null; threadId: string | null }>;
    capacity?: number;
    queuedTurns: number;
    lastError: string | null;
  };
  hostAuth: {
    ok: boolean;
    authMethod: string | null;
    email: string | null;
    planType: string | null;
    error: string | null;
    expiresAt: number | null;
  };
  sandbox: { name: string; running: boolean; healthy: boolean; image: string | null; managed: boolean; setupError?: string | null; idle?: "parking" | "parked" | "waking" | null };
  workspaceOrigin: string;
}

export interface CapabilityGroup {
  id: string;
  title: string;
  description: string;
  surfaces: Array<{ label: string; path: string; kind: "page" | "api" }>;
  endpoints: Array<{ method: string; path: string; summary: string }>;
  available: boolean | null;
  note?: string;
}

export interface CapabilitiesResponse {
  inventory: {
    generatedAt: number;
    sandboxVersion: string | null;
    groups: CapabilityGroup[];
    openApiPathCount: number | null;
  };
  mcpServers: string[];
  skills: Array<{ name: string; description?: string }>;
  jupyter: unknown;
  code: unknown;
  workspaceOrigin: string;
}

export interface Attachment {
  path: string;
  name: string;
  kind: "image" | "file";
  size: number;
}

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size: number | null;
  modified_time: string | null;
  extension: string;
}

/** Tool readiness reported by the sandbox document service. */
export interface DocumentReadiness {
  enabled: boolean;
  ready: boolean;
  previewReady: boolean;
  authoringReady: boolean;
  version: string | null;
  tools: Record<string, boolean>;
  python: Record<string, boolean>;
  missing: string[];
  error: string | null;
  checkedAt: number;
}

/** Preview metadata for one workspace document (page count, truncation, size). */
export interface DocumentInfo {
  path: string;
  kind: string;
  size: number;
  renderable: boolean;
  textPreviewable: boolean;
}

export interface DocumentRender {
  path: string;
  kind: string;
  pageCount: number;
  totalPages: number;
  truncated: boolean;
  size: number;
}

export interface Task {
  waitReason?: { label: string; message: string } | null;
  clarification?: string | null;
  /** Answers to tap for a pending question. */
  options?: string[] | null;
  description?: string | null;
  mergedInto?: string | null;
  mergedTitle?: string | null;
  revision: number;
  id: string;
  title: string;
  text: string;
  conversationId: string;
  status: string;
  result: string | null;
  error: string | null;
  attachments: Attachment[];
  relatedTaskId: string | null;
  relatedTaskTitle?: string | null;
  dependencies: string[];
  approvals: number;
  createdAt: number;
  startedAt?: number | null;
  completedAt: number | null;
  /** Present when the task has browser tabs: its agent's tabs, a request for you, or you in control. */
  browser?: { tabs: number; request: string | null; human: boolean };
  /** Set on a run a schedule started (nobody typed it then). */
  schedule?: { id: string; title: string; rule: string; builtin?: string } | null;
}

/** A scheduled or recurring task, created by asking in the main session. */
export interface Schedule {
  id: string;
  title: string;
  instruction: string;
  rule: string;
  status: "active" | "paused" | "done";
  timezone: string;
  nextRunAt: number | null;
  nextRunText: string | null;
  lastRunAt: number | null;
  lastTask: { id: string; status: string } | null;
  runCount: number;
  createdAt: number;
  /** Set on a schedule every account gets (the daily feed): it can be paused, not deleted. */
  builtin?: string | null;
  /** The daily feed only: whether the person worded its instruction, and what it keeps in mind. */
  feed?: { customized: boolean; memory: Array<{ id: string; kind: "care" | "avoid" | "note"; text: string; source: "user" | "feed" }> };
}

/** One browser tab a task created, as the tab record keeps it. */
export interface TaskTab {
  id: string;
  title: string;
  url: string;
  lastUsed: number;
  finishedAt: number | null;
  holder: "ai" | "human";
  /** The agent waits for the person; `kind: "login"` is a sign-in the password vault can answer. */
  request: { reason: string; at: number; kind?: "login"; site?: string } | null;
}

/** Sign-in steps the agent wrote for a site and the vault keeps (counts only; the steps stay on the server). */
export interface VaultScript { site: string; steps: number; successes: number; failures: number; lastNote: string | null; updatedAt: number }

/** An account saved in the password vault. The password is fetched only when the person asks to see it. */
export interface VaultEntry {
  id: string;
  site: string;
  /** Google: no password; the agent uses the site's Google button (with `username` as the Google account, if any). */
  method: "password" | "google";
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

/** How well the dispatcher finds past tasks (see src/control/tasks/recall.ts). */
/** A one-time register code (owner settings). */
export interface Invite {
  code: string;
  note: string;
  createdAt: number;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
}

export interface RecallStats {
  days: number;
  dispatches: number;
  failed: number;
  repaired: number;
  withRecall: number;
  avgRecalled: number;
  searchRate: number;
  avgRounds: number;
  chosen: number;
  chosenFromRecall: number;
  chosenFromSearch: number;
  labelled: number;
  recallAtCap: number | null;
  mrr: number | null;
  cap: number;
  avgLatencyMs: number;
  p90PromptChars: number;
}

/** Owner debug: how one message was dispatched, step by step. */
export type DispatchStep =
  | { kind: "context"; at: number; timeline: string; candidates: number }
  | { kind: "jev"; at: number; criteria: Record<string, string>; result?: { choice: string; probabilities: Record<string, number>; confident: boolean; latencyMs: number; scores?: Record<string, number>; suggestion?: { kind: string; taskId: string | null; probability: number } }; error?: string }
  | { kind: "timing"; at: number; round: number; timing: { model?: string; effort?: string; queueMs?: number; contextMs?: number; jevMs?: number; sandboxMs?: number; connectionMs?: number; threadStartMs?: number; turnStartMs?: number; firstTextMs?: number; finishMs?: number; classifierMs?: number; totalMs?: number; attempts?: number } }
  | { kind: "ask"; at: number; round: number; prompt: string; answer: string | null; searched?: string[]; correction?: string }
  | { kind: "plan"; at: number; plan: Record<string, unknown>; repairs: string[] }
  | { kind: "failed"; at: number; reason: string };

export interface DispatchLogEntry {
  at: number;
  latencyMs: number;
  rounds: number;
  promptChars: number;
  failed: boolean;
  failReason: string | null;
  repairs: string[];
  candidates: Array<{ id: string; source: string; rank?: number; score?: number; title: string | null }>;
  searches: string[];
  chosen: { related: string[]; appendTo: string | null; resume?: string | null };
  jev: { choice: string; probability: number; confident: boolean; latencyMs: number; scores?: Record<string, number>; suggestion?: { kind: string; taskId: string | null; probability: number } } | { error: string } | null;
  steps: DispatchStep[];
}

export interface DispatchLog {
  task: { id: string; title: string; text: string; status: string };
  entries: DispatchLogEntry[];
}
