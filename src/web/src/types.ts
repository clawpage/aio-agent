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
  sandbox: { name: string; running: boolean; healthy: boolean; image: string | null; managed: boolean; setupError?: string | null };
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
}

/** One browser tab a task created, as the tab record keeps it. */
export interface TaskTab {
  id: string;
  title: string;
  url: string;
  lastUsed: number;
  finishedAt: number | null;
  holder: "ai" | "human";
  request: { reason: string; at: number } | null;
}

/** How well the dispatcher finds past tasks (see src/server/tasks/recall.ts). */
export interface RecallStats {
  days: number;
  dispatches: number;
  failed: number;
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
