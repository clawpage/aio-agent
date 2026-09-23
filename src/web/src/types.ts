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
