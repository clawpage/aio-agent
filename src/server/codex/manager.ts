import {readSoul} from '../soul.js';
import { EventEmitter } from "node:events";
import type { Db } from "../db.js";
import { getMeta, setMeta } from "../db.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexModel, SandboxAccount } from "./sandboxCodex.js";
import type { HostTokenSource } from "./hostTokens.js";
import { BridgeModel, CHATGPT_PROVIDER_ID } from "../bridgeModel.js";
import { AutoTitler, DEFAULT_CONVERSATION_TITLE, TITLE_UPDATED_EVENT, manualTitleMetaKey } from "./autoTitle.js";
import {
  effectiveAgentSettings,
  readAgentSettings,
  validateAgentSettings,
  writeAgentSettings,
  type AgentSettings,
  type SettingsValidation,
  type ValidatableModel,
} from "../settings.js";

/**
 * Narrow view of the sandbox Codex process that the manager depends on. Keeping
 * this explicit lets tests drive the manager with a scripted double.
 */
export interface CodexSessionLike {
  readonly ready: boolean;
  readonly account: SandboxAccount | null;
  readonly lastError: string | null;
  onNotification(handler: (method: string, params: unknown) => void): void;
  onServerRequest(handler: (id: string, method: string, params: unknown) => void): void;
  onClosed(handler: (reason: string) => void): void;
  start(): Promise<void>;
  listModels(): Promise<CodexModel[]>;
  startThread(opts: {
    cwd?: string;
    model?: string;
    modelProvider?: string;
    developerInstructions?: string;
  }): Promise<{ threadId: string; model: string; cwd: string; modelProvider: string | null }>;
  forkThread(
    threadId: string,
    opts: { model?: string; modelProvider?: string; cwd?: string; developerInstructions?: string },
  ): Promise<{ threadId: string; model: string; cwd: string; modelProvider: string | null }>;
  resumeThread(threadId: string, developerInstructions?: string): Promise<void>;
  startTurn(params: {
    threadId: string;
    text: string;
    attachments?: Array<{ path: string; kind: "image" | "file"; name?: string }>;
    model?: string | null;
    effort?: string | null;
    cwd?: string | null;
    clientUserMessageId?: string | null;
    /** Reasoning summary mode; `none` opts out entirely. */
    summary?: "none" | "auto" | "concise" | "detailed" | null;
  }): Promise<string>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  steerTurn?(params: {threadId:string;expectedTurnId:string;text:string;attachments?:TurnAttachment[]}): Promise<void>;
  /** One throwaway, tool-free run used only for automatic conversation titles. */
  generateTitle(userText: string): Promise<string | null>;
  planTask?(prompt: string, developerInstructions?: string): Promise<string | null>;
  answer(id: string, result: unknown): boolean;
  close(): void;
}
import { randomId } from "../auth/passwords.js";

export interface ConversationRow {
  id: string;
  title: string;
  codex_thread_id: string | null;
  model: string | null;
  /** Codex provider the current thread runs on; null means the ChatGPT one. */
  model_provider: string | null;
  cwd: string | null;
  status: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface TurnAttachment {
  path: string;
  kind: "image" | "file";
  name?: string;
}

export interface TurnRow {
  id: string;
  conversation_id: string;
  status: string;
  codex_turn_id: string | null;
  input_text: string;
  attachments_json: string;
  client_message_id: string;
  cancel_requested: number;
  browser_required: number;
  /** Model frozen at submit time so queued turns never follow a later change. */
  model: string | null;
  effort: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface AgentEvent {
  id: number;
  conversationId: string;
  turnId: string | null;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface PendingRequestRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  codex_request_id: string;
  method: string;
  payload: unknown;
  status: string;
  created_at: number;
}

/**
 * Item lifecycle notifications that the bridge model may re-send verbatim (same
 * thread/turn/item and identical payload, ~1s apart). Only these are candidates
 * for persisted-event deduplication; deltas, turn, warning and approval events
 * keep their existing behaviour.
 */
const ITEM_LIFECYCLE_METHODS = new Set(["item/started", "item/completed"]);

const DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  // Model-generated reasoning summaries only. Raw chain-of-thought
  // (`item/reasoning/textDelta`) is deliberately not surfaced.
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/mcpToolCall/progress",
]);

const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/**
 * The model every conversation defaulted to before this deployment. Conversations
 * still carrying it were never an explicit user choice (there was no other model
 * to pick), so they are moved to the configured default exactly once.
 */
export const LEGACY_DEFAULT_MODEL = "gpt-5.5";

/** `meta` key recording that the one-time default-model migration already ran. */
export const MODEL_MIGRATION_KEY = "model_default_migration_v1";

/** Maximum length of a hand-typed conversation title; mirrored by the API and UI. */
export const CONVERSATION_TITLE_MAX_CHARS = 200;

/** Raised when a caller supplies a title the server refuses to persist verbatim. */
export class InvalidConversationTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConversationTitleError";
  }
}

/**
 * Trim and validate a user-supplied conversation title. Blank and over-long
 * titles are rejected instead of being silently rewritten, so a direct manager
 * call follows exactly the same contract as `PATCH /conversations/:id`.
 */
export function normalizeConversationTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new InvalidConversationTitleError("标题不能为空");
  if (title.length > CONVERSATION_TITLE_MAX_CHARS) {
    throw new InvalidConversationTitleError(`标题最长 ${CONVERSATION_TITLE_MAX_CHARS} 个字符`);
  }
  return title;
}

/**
 * Raised when a turn was already handed to Codex but its outcome can no longer be
 * determined (transport failure / process death). Such turns are never retried
 * automatically because the sandbox may already have performed side effects.
 */
export class TurnOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnOutcomeUnknownError";
  }
}

/** Raised when a clientMessageId is reused for a materially different submission. */
export class TurnConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnConflictError";
  }
}

/**
 * Raised when a submission cannot run on the selected model at all — currently
 * an image attachment sent to the text-only bridge model. Refusing it in the
 * control plane gives the user a clear Chinese message instead of a remote
 * Codex failure halfway through the turn.
 */
export class TurnInputUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnInputUnsupportedError";
  }
}

export interface SubmitTurnInput {
  /** Internal resource plan only; legacy/HTTP turns stay conservative. */
  requiresBrowser?: boolean;
  /** Internal dispatcher snapshot; never accepted from HTTP request fields. */
  frozenSettings?: { model: string; effort: string | null };
  conversationId: string;
  text: string;
  clientMessageId: string;
  attachments?: TurnAttachment[];
  model?: string | null;
  effort?: string | null;
  cwd?: string | null;
}

export interface ActiveTurn {
  conversationId: string;
  turnId: string;
  codexTurnId: string | null;
  threadId: string | null;
}

export interface AgentStatus {
  sessionReady: boolean;
  account: { email: string | null; planType: string | null; type: string } | null;
  activeTurnId: string | null;
  activeConversationId: string | null;
  /** Every turn currently executing, one per conversation. */
  activeTurns: ActiveTurn[];
  /** Maximum number of concurrently executing main turns. */
  capacity: number;
  queuedTurns: number;
  lastError: string | null;
}

/**
 * Owns conversation persistence, the single sandbox execution queue, streamed
 * event log and approval lifecycle. Browser disconnects never affect execution:
 * events are written to SQLite first and streamed to whoever is connected.
 */
/**
 * Narrow view of the browser lifecycle the manager depends on.
 *
 * A managed turn protects the sandbox browser for its whole duration: the lease
 * is reserved synchronously (before any await) so no idle timer can release a
 * Chromium the turn is about to drive, and browser-dependent turns await `ready()` before execution. Internal tasks
 * with no browser resource skip recovery; adding browser work gates the steer. Keeping the
 * dependency optional lets existing tests drive the manager with no browser.
 */
export interface BrowserGateLike {
  /** Reserve a hold for one whole turn; returns the release function. */
  reserveTurn(): () => void;
  /** Resolve once the browser is awake and restored; rejects fail-closed. */
  ready(): Promise<void>;
}

export class AgentManager {
  readonly events = new EventEmitter();
  #db: Db;
  #cfg: Config;
  #log: Logger;
  #codex: CodexSessionLike;
  #hostTokens: HostTokenSource;
  #titles: AutoTitler;
  #bridge: BridgeModel | null;

  #activeTurns = new Map<string, ActiveTurn>();
  #capacity: number;
  #deltaBuffers = new Map<string, { conversationId: string; turnId: string | null; itemId: string; kind: string; text: string }>();
  #deltaTimer: NodeJS.Timeout | null = null;
  #completionWaiters = new Map<string, () => void>();
  #completedTurns = new Map<string, { status: string }>();
  #lastError: string | null = null;
  #approvalTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Last observed model catalog. Kept so a synchronous submit can validate and
   * resolve the unified owner settings without an extra round trip to Codex.
   * Refreshed by `listModels()` (the settings page loads it) and best-effort at
   * init; an empty cache simply skips effort re-validation.
   */
  #modelCatalog: CodexModel[] = [];
  /**
   * Incremented whenever the sandbox Codex connection dies. A turn captures the
   * value before starting; if it changed, the outcome is unknown and must not be
   * waited on (the completion notification can never arrive).
   */
  #codexGeneration = 0;
  /** Optional browser lifecycle gate; absent means no browser release management. */
  #browser: BrowserGateLike | null;

  constructor(deps: {
    cfg: Config;
    db: Db;
    log: Logger;
    codex: CodexSessionLike;
    hostTokens: HostTokenSource;
    /** Optional: when present, every managed turn protects the sandbox browser. */
    browser?: BrowserGateLike | null;
    /** Optional bridge model; absent means every turn runs on ChatGPT. */
    bridge?: BridgeModel | null;
  }) {
    this.#cfg = deps.cfg;
    this.#db = deps.db;
    this.#log = deps.log.child("agent");
    this.#codex = deps.codex;
    this.#hostTokens = deps.hostTokens;
    this.#browser = deps.browser ?? null;
    this.#bridge = deps.bridge ?? null;
    this.#capacity = Math.max(1, deps.cfg.agent.maxConcurrentTurns);
    this.#titles = new AutoTitler({
      cfg: deps.cfg,
      db: deps.db,
      log: deps.log,
      codex: deps.codex,
      appendEvent: (conversationId, turnId, type, payload) => {
        this.#appendEvent(conversationId, turnId, type, payload);
      },
    });
    this.events.setMaxListeners(0);
  }

  async init(): Promise<void> {
    this.#reconcileInterrupted();
    this.#migrateLegacyDefaultModel();
    this.#backfillTurnModels();
    this.#archiveDuplicateBlankConversations();
    this.#codex.onNotification((method, params) => this.#handleNotification(method, params));
    this.#codex.onServerRequest((id, method, params) => this.#handleServerRequest(id, method, params));
    this.#codex.onClosed((reason) => this.#handleCodexClosed(reason));
    // Resume queue processing if the previous process died mid-queue.
    this.#pump();
    // Prime the model catalog so a submit can re-validate a stored effort without
    // the user having to open the config page first. Best-effort: a cold sandbox
    // simply leaves the cache empty and the stored value is kept as-is.
    void this.refreshModelCatalog();
    // If the session is already up (tests / warm start), catch up old titles now;
    // otherwise startSandboxRuntime does it once the session is established.
    if (this.#codex.ready) this.#titles.scheduleBackfill();
  }

  /** Queue bounded catch-up titles for default-named conversations (idempotent). */
  scheduleTitleBackfill(): void {
    this.#titles.scheduleBackfill();
  }

  /** Await all currently-queued automatic title runs (used by tests). */
  async waitForAutoTitles(): Promise<void> {
    await this.#titles.drain();
  }

  /**
   * Anything left running/queued after a restart is marked explicitly instead of
   * being silently retried, so the user always sees what happened.
   */
  #reconcileInterrupted(): void {
    const stale = this.#db
      .prepare("SELECT id, conversation_id, status FROM turns WHERE status IN ('running','queued')")
      .all() as unknown as { id: string; conversation_id: string; status: string }[];
    for (const turn of stale) {
      if (turn.status === "running") {
        // Outcome is genuinely unknown: the sandbox may have already performed
        // side effects. Never auto-retry this; make the user verify first.
        this.#db
          .prepare("UPDATE turns SET status = 'unknown', error = ?, completed_at = ? WHERE id = ?")
          .run("服务重启时该轮次正在执行，执行结果未知，可能已在沙箱内产生操作", Date.now(), turn.id);
        this.#appendEvent(turn.conversation_id, turn.id, "turn.reconciled", {
          turnId: turn.id,
          reason: "server_restart_while_running",
          status: "unknown",
          message:
            "服务重启时该轮次正在执行，执行结果未知，可能已在沙箱内产生操作（文件、进程、浏览器状态）。请先核对沙箱状态，确认后再重新发送；系统不会自动重放该轮次。",
        });
      } else {
        this.#db
          .prepare("UPDATE turns SET status = 'interrupted', error = ?, completed_at = ? WHERE id = ?")
          .run("服务重启导致排队中的轮次被取消", Date.now(), turn.id);
        this.#appendEvent(turn.conversation_id, turn.id, "turn.reconciled", {
          turnId: turn.id,
          reason: "server_restart_before_start",
          status: "interrupted",
          message: "服务重启导致该轮次尚未开始即被取消，可以安全地重新发送。",
        });
      }
    }
    const pending = this.#db.prepare("SELECT id, conversation_id FROM server_requests WHERE status = 'pending'").all() as {
      id: string;
      conversation_id: string;
    }[];
    for (const req of pending) {
      this.#db.prepare("UPDATE server_requests SET status = 'expired', resolved_at = ? WHERE id = ?").run(Date.now(), req.id);
      this.#appendEvent(req.conversation_id, null, "approval.resolved", { requestId: req.id, decision: "expired" });
    }
    this.#db.prepare("UPDATE conversations SET status = 'idle' WHERE status = 'running'").run();
    this.#db.prepare("UPDATE agent_state SET active_turn_id = NULL, active_conversation_id = NULL, queue_json = '[]', updated_at = ? WHERE id = 1").run(
      Date.now(),
    );
    if (stale.length || pending.length) {
      this.#log.warn("reconciled interrupted work after restart", { turns: stale.length, approvals: pending.length });
    }
  }

  /**
   * One-time correction of the previous default model.
   *
   * Runs before any turn can be submitted and is recorded in `meta`, so it never
   * runs twice: a model the user picks deliberately from now on (including
   * `gpt-5.5`) is respected forever. Only the `model` column changes — history,
   * threads and events are untouched.
   */
  #migrateLegacyDefaultModel(): void {
    if (getMeta(this.#db, MODEL_MIGRATION_KEY)) return;
    const target = this.#cfg.agent.defaultModel;
    const res = this.#db.prepare("UPDATE conversations SET model = ? WHERE model = ?").run(target, LEGACY_DEFAULT_MODEL);
    setMeta(
      this.#db,
      MODEL_MIGRATION_KEY,
      JSON.stringify({ from: LEGACY_DEFAULT_MODEL, to: target, changed: Number(res.changes), at: Date.now() }),
    );
    if (res.changes) {
      this.#log.info("migrated conversations off the legacy default model", {
        from: LEGACY_DEFAULT_MODEL,
        to: target,
        conversations: Number(res.changes),
      });
    }
  }

  /**
   * Backfill the frozen `turns.model` for rows created before that column
   * existed. The authoritative source is the `turn.queued` event snapshot, which
   * already carried the model the turn was accepted with. Only turns whose
   * queued event is missing fall back to the conversation's current model, and
   * the backfill is idempotent (it only touches rows still holding NULL).
   */
  #backfillTurnModels(): void {
    const rows = this.#db
      .prepare("SELECT id, conversation_id FROM turns WHERE model IS NULL")
      .all() as unknown as Array<{ id: string; conversation_id: string }>;
    if (!rows.length) return;
    const eventStmt = this.#db.prepare("SELECT payload FROM events WHERE conversation_id = ? AND turn_id = ? AND type = 'turn.queued' ORDER BY id ASC LIMIT 1");
    const convStmt = this.#db.prepare("SELECT model FROM conversations WHERE id = ?");
    const update = this.#db.prepare("UPDATE turns SET model = ? WHERE id = ? AND model IS NULL");
    let changed = 0;
    for (const row of rows) {
      let model: string | null = null;
      const event = eventStmt.get(row.conversation_id, row.id) as { payload: string } | undefined;
      if (event) {
        try {
          const parsed = JSON.parse(event.payload) as { model?: unknown };
          if (typeof parsed.model === "string" && parsed.model) model = parsed.model;
        } catch {
          /* corrupt payload: fall through to the conversation model */
        }
      }
      if (!model) {
        const conv = convStmt.get(row.conversation_id) as { model: string | null } | undefined;
        model = conv?.model ?? null;
      }
      if (model) changed += Number(update.run(model, row.id).changes);
    }
    if (changed) this.#log.info("backfilled frozen turn models", { turns: changed });
  }

  /**
   * Idempotent housekeeping: at most one active, zero-turn conversation may keep
   * the default "新会话" title. Older duplicates are archived (recoverable), never
   * deleted. A conversation with any message is never touched, and the newest
   * blank default (by created_at, then id) always survives.
   */
  #archiveDuplicateBlankConversations(): void {
    const rows = this.#db
      .prepare(
        `SELECT c.id FROM conversations c
         WHERE c.archived = 0 AND c.title = ?
           AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id)
         ORDER BY c.created_at DESC, c.id DESC`,
      )
      .all(DEFAULT_CONVERSATION_TITLE) as Array<{ id: string }>;
    if (rows.length <= 1) return;
    const duplicates = rows.slice(1).map((r) => r.id);
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.#db.prepare("UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0");
      for (const id of duplicates) stmt.run(now, id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    this.#log.info("archived duplicate blank default conversations", {
      kept: rows[0]?.id ?? null,
      archived: duplicates.length,
    });
  }

  // ---------------------------------------------------------------- events

  #appendEvent(conversationId: string, turnId: string | null, type: string, payload: unknown): AgentEvent {
    const now = Date.now();
    const res = this.#db
      .prepare("INSERT INTO events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(conversationId, turnId, type, JSON.stringify(payload ?? null), now);
    const event: AgentEvent = {
      id: Number(res.lastInsertRowid),
      conversationId,
      turnId,
      type,
      payload: payload ?? null,
      createdAt: now,
    };
    this.events.emit("event", event);
    return event;
  }

  listEvents(conversationId: string, sinceId = 0, limit = 2000): AgentEvent[] {
    const rows = this.#db
      .prepare("SELECT id, conversation_id, turn_id, type, payload, created_at FROM events WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
      .all(conversationId, sinceId, limit) as Array<{
      id: number;
      conversation_id: string;
      turn_id: string | null;
      type: string;
      payload: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      turnId: r.turn_id,
      type: r.type,
      payload: JSON.parse(r.payload) as unknown,
      createdAt: r.created_at,
    }));
  }

  // --------------------------------------------------------- conversations

  /**
   * List conversations for the sidebar.
   *
   * The single active blank default ("新会话" with zero turns) is pinned first
   * so the “start a new chat” slot is always in a predictable place, regardless
   * of when it was created. Archived blank defaults are never pinned.
   *
   * Every other row is ordered by the most recent actual message activity — the
   * newest of each turn's user input (`created_at`) or completed agent reply
   * (`completed_at`) — not by `conversations.updated_at`, which rename, archive,
   * restore and status changes also touch. A conversation with no turns falls
   * back to its creation time, and ties are broken by creation time and id so the
   * order is stable. `turnCount` is still returned unchanged.
   */
  listConversations(includeArchived = false): Array<ConversationRow & { turnCount: number }> {
    const rows = this.#db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turnCount
         FROM conversations c
         WHERE (? OR c.archived = 0) AND NOT EXISTS (SELECT 1 FROM tasks j WHERE j.conversation_id = c.id)
         ORDER BY
           CASE
             WHEN c.archived = 0 AND c.title = ?
               AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id)
             THEN 0 ELSE 1
           END ASC,
           COALESCE(
             (SELECT MAX(COALESCE(t.completed_at, t.created_at)) FROM turns t WHERE t.conversation_id = c.id),
             c.created_at
           ) DESC,
           c.created_at DESC,
           c.id DESC`,
      )
      .all(includeArchived ? 1 : 0, DEFAULT_CONVERSATION_TITLE) as unknown as Array<ConversationRow & { turnCount: number }>;
    return rows;
  }

  getConversation(id: string): ConversationRow | null {
    return (this.#db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined) ?? null;
  }

  createConversation(opts: { title?: string; model?: string | null; cwd?: string | null } = {}): ConversationRow {
    const now = Date.now();
    const id = randomId("conv");
    const requested = (opts.title ?? "").trim();
    const title = requested || DEFAULT_CONVERSATION_TITLE;
    this.#db
      .prepare("INSERT INTO conversations (id, owner_id, title, model, cwd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)")
      .run(id, "owner_1", title, opts.model ?? null, opts.cwd ?? this.#cfg.sandbox.containerWorkspaceDir, now, now);
    // An explicit non-default title at creation is a user choice, not a slot for
    // the automatic titler to overwrite later.
    if (requested) {
      setMeta(this.#db, manualTitleMetaKey(id), String(now));
    }
    this.#appendEvent(id, null, "conversation.created", { title });
    return this.getConversation(id)!;
  }

  /**
   * Rename a conversation by hand and mark the title as manual so the automatic
   * titler never overwrites it. Returns `conflict` (instead of renaming) when the
   * rename would create a second active, zero-turn default "新会话" — the active
   * list must never hold two indistinguishable empty conversations; the caller
   * maps that to a 409.
   */
  renameConversation(id: string, title: string): { renamed: boolean; conflict: boolean } {
    const now = Date.now();
    const nextTitle = normalizeConversationTitle(title);
    const existing = this.getConversation(id);
    if (!existing) return { renamed: false, conflict: false };
    // Only an active blank default competes for the single default slot; an
    // archived blank stays recoverable and is guarded on restore instead.
    if (existing.archived === 0 && nextTitle === DEFAULT_CONVERSATION_TITLE) {
      const turns = this.#db.prepare("SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?").get(id) as { n: number };
      if (turns.n === 0) {
        const other = this.#db
          .prepare(
            `SELECT c.id FROM conversations c
             WHERE c.archived = 0 AND c.id != ? AND c.title = ?
               AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id)
             LIMIT 1`,
          )
          .get(id, DEFAULT_CONVERSATION_TITLE) as { id: string } | undefined;
        if (other) return { renamed: false, conflict: true };
      }
    }
    // The rename and its “manual title” marker must land together: a crash or
    // error between the two would otherwise drop the user's intent and let the
    // automatic titler rename the conversation afterwards.
    let changed = false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      changed = this.#db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(nextTitle, now, id).changes > 0;
      if (changed) setMeta(this.#db, manualTitleMetaKey(id), String(now));
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    // Announce only after the commit, so a rolled-back rename is never broadcast.
    if (changed) this.#appendEvent(id, null, TITLE_UPDATED_EVENT, { title: nextTitle });
    return { renamed: changed, conflict: false };
  }

  archiveConversation(id: string, archived = true): boolean {
    const res = this.#db.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, Date.now(), id);
    return res.changes > 0;
  }

  /**
   * Restore an archived conversation. A blank default "新会话" (zero turns) may
   * only be restored when no other active blank default exists, so the active
   * list never contains two indistinguishable empty conversations; the caller
   * maps `conflict` to a 409.
   */
  restoreConversation(id: string): { restored: boolean; conflict: boolean } {
    const conversation = this.getConversation(id);
    if (!conversation) return { restored: false, conflict: false };
    if (conversation.archived && conversation.title === DEFAULT_CONVERSATION_TITLE) {
      const turns = this.#db.prepare("SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?").get(id) as { n: number };
      if (turns.n === 0) {
        const other = this.#db
          .prepare(
            `SELECT c.id FROM conversations c
             WHERE c.archived = 0 AND c.id != ? AND c.title = ?
               AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id)
             LIMIT 1`,
          )
          .get(id, DEFAULT_CONVERSATION_TITLE) as { id: string } | undefined;
        if (other) return { restored: false, conflict: true };
      }
    }
    return { restored: this.archiveConversation(id, false), conflict: false };
  }

  /**
   * API-facing create: an empty title reuses the existing active, zero-turn
   * default "新会话" instead of piling up blanks (the optional-archive on start
   * becomes idempotent). An explicit title always creates a new conversation, so
   * `createConversation` keeps its original one-insert semantics.
   */
  getOrCreateConversation(opts: { title?: string; model?: string | null; cwd?: string | null } = {}): {
    conversation: ConversationRow;
    reused: boolean;
  } {
    const requested = (opts.title ?? "").trim();
    if (!requested) {
      const existing = this.#db
        .prepare(
          `SELECT c.* FROM conversations c
           WHERE c.archived = 0 AND c.title = ?
             AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id)
           ORDER BY c.created_at DESC, c.id DESC LIMIT 1`,
        )
        .get(DEFAULT_CONVERSATION_TITLE) as ConversationRow | undefined;
      if (existing) return { conversation: existing, reused: true };
    }
    return { conversation: this.createConversation(opts), reused: false };
  }

  listTurns(conversationId: string): TurnRow[] {
    return this.#db
      .prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId) as unknown as TurnRow[];
  }

  // ---------------------------------------------------------------- turns

  /**
   * Owner-level unified settings (model + reasoning effort) applied to every
   * later message regardless of which conversation or device sent it.
   */
  agentSettings(): AgentSettings {
    return readAgentSettings(this.#db);
  }

  /**
   * Persist the unified settings after validating them against the model catalog
   * the caller supplied (the settings page reads `/api/models` first). Storing an
   * unvalidated value is refused so a later turn can never fail on it.
   */
  saveAgentSettings(input: { model?: unknown; effort?: unknown }, models: ValidatableModel[]): SettingsValidation {
    const result = validateAgentSettings(input, models);
    if (!result.ok) return result;
    writeAgentSettings(this.#db, result.settings);
    return result;
  }

  /**
   * Resolve the model and effort a freshly submitted turn should freeze.
   *
   * The unified owner settings are authoritative for every later message: when
   * they are unset the configured default model applies, never the conversation's
   * own stale model. A per-turn override is only honoured for internal callers
   * (the HTTP route never forwards client model/effort), so the config page is the
   * single source of truth the UI exposes.
   */
  resolveSubmitSettings(input: SubmitTurnInput): { model: string; effort: string | null } {
    if (input.frozenSettings) return input.frozenSettings;
    const stored = effectiveAgentSettings(this.agentSettings(), this.#modelCatalog, this.#cfg.agent.defaultModel);
    const model = input.model ?? stored.model ?? this.#cfg.agent.defaultModel;
    let effort = input.effort ?? stored.effort ?? null;
    if (effort) {
      const catalog = this.#modelCatalog.find((m) => m.id === model);
      // Drop an effort the target model does not support rather than letting the
      // turn fail at Codex start time. An unavailable catalog keeps the stored
      // value, which was already validated when it was saved.
      if (catalog && !catalog.supportedReasoningEfforts.includes(effort)) effort = null;
    }
    return { model, effort };
  }

  /**
   * Idempotent submit: repeating the same clientMessageId returns the existing
   * turn instead of starting a second run.
   */
  submitTurn(input: SubmitTurnInput): { turn: TurnRow; duplicate: boolean } {
    const existing = this.#db.prepare("SELECT * FROM turns WHERE client_message_id = ?").get(input.clientMessageId) as unknown as TurnRow | undefined;
    if (existing) {
      // Same id, same request => idempotent replay. Same id, different payload =>
      // refuse, otherwise a client bug could silently drop a real message or
      // attach it to the wrong conversation.
      const sameConversation = existing.conversation_id === input.conversationId;
      const sameText = existing.input_text === input.text;
      const sameAttachments = existing.attachments_json === JSON.stringify(input.attachments ?? []);
      if (!sameConversation || !sameText || !sameAttachments) {
        throw new TurnConflictError("该消息 ID 已用于另一条内容不同的消息，已拒绝重复提交");
      }
      return { turn: existing, duplicate: true };
    }

    const conversation = this.getConversation(input.conversationId);
    if (!conversation) throw new Error("会话不存在");
    if (conversation.archived) throw new Error("会话已归档，无法发送消息");

    const now = Date.now();
    const id = randomId("turn");
    const attachments = input.attachments ?? [];
    // Freeze the resolved model on the turn itself. A queued turn must keep the
    // model it was submitted with even if the owner changes the unified setting
    // (or another turn rewrites `conversations.model`) before it starts.
    const resolved = this.resolveSubmitSettings(input);
    // The bridge model is text-only. Refuse an image here, with a clear message,
    // rather than letting Codex reject the turn remotely.
    const model = resolved.model ?? this.#cfg.agent.defaultModel;
    if (attachments.some((a) => a.kind === "image") && this.#bridge?.isTextOnly(model)) {
      throw new TurnInputUnsupportedError("该模型只支持文本输入，请移除图片附件后重试");
    }
    try {
      this.#db
        .prepare(
          "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, attachments_json, model, effort, browser_required, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
        )
        .run(id, input.conversationId, input.clientMessageId, input.text, JSON.stringify(attachments), resolved.model, resolved.effort, input.requiresBrowser === false ? 0 : 1, now);
    } catch (err) {
      // Concurrent duplicate submission: return the winner.
      if (String(err).includes("UNIQUE")) {
        const winner = this.#db.prepare("SELECT * FROM turns WHERE client_message_id = ?").get(input.clientMessageId) as unknown as TurnRow;
        return { turn: winner, duplicate: true };
      }
      throw err;
    }
    this.#db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, input.conversationId);
    // Persist the resolved model so the stored conversation state and the turn
    // that will run agree.
    this.#db
      .prepare("UPDATE conversations SET model = ?, cwd = COALESCE(?, cwd) WHERE id = ?")
      .run(model, input.cwd ?? null, input.conversationId);
    this.#appendEvent(input.conversationId, id, "turn.queued", {
      turnId: id,
      clientMessageId: input.clientMessageId,
      text: input.text,
      attachments,
      model,
      effort: resolved.effort,
      cwd: input.cwd ?? null,
    });
    const turn = this.#db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as unknown as TurnRow;
    this.#pump();
    return { turn, duplicate: false };
  }

  /**
   * Next queued turn whose conversation is not already executing. FIFO by
   * creation time across all conversations, but a conversation that is already
   * running is skipped so it never runs two turns at once.
   */
  #nextEligibleQueuedTurn(): TurnRow | null {
    const rows = this.#db
      .prepare("SELECT * FROM turns WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC")
      .all() as unknown as TurnRow[];
    for (const turn of rows) {
      if (this.#activeTurns.has(turn.conversation_id)) continue;
      return turn;
    }
    return null;
  }

  /**
   * Fill every free execution slot, then return. Each started turn releases its
   * slot and wakes the pump again from its own completion handler, so queued
   * work is picked up as soon as any slot frees.
   */
  #pump(): void {
    for (;;) {
      if (this.#activeTurns.size >= this.#capacity) break;
      const turn = this.#nextEligibleQueuedTurn();
      if (!turn) break;
      const ctx: ActiveTurn = {
        conversationId: turn.conversation_id,
        turnId: turn.id,
        codexTurnId: null,
        threadId: null,
      };
      // Reserve the conversation slot synchronously before any await so a later
      // pump pass (or a concurrent submit) cannot start a second turn for it.
      this.#activeTurns.set(turn.conversation_id, ctx);
      this.#persistActiveState();
      // Protect the sandbox browser for the whole turn. The reservation is
      // synchronous and taken here, before the first await, so an idle timer can
      // never release a Chromium this turn is about to use - even while the turn
      // is still starting, waiting on an approval, or being cancelled. The release
      // runs in the turn's own `finally`, so a thrown error, an interrupt or a
      // connection loss cannot leak the hold.
      let releaseBrowser: () => void;
      try {
        releaseBrowser = this.#browser ? this.#browser.reserveTurn() : () => {};
      } catch (err) {
        // A reservation that throws (e.g. the lifecycle was shut down) must not
        // strand the conversation slot: undo it synchronously and report the turn.
        const message = err instanceof Error ? err.message : String(err);
        this.#activeTurns.delete(turn.conversation_id);
        this.#persistActiveState();
        this.#failTurn(turn, message);
        this.#db
          .prepare("UPDATE conversations SET status = 'idle', updated_at = ? WHERE id = ?")
          .run(Date.now(), turn.conversation_id);
        continue;
      }
      void this.#runTurn(turn, ctx)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.#lastError = message;
          if (err instanceof TurnOutcomeUnknownError) {
            this.#markTurnUnknown(turn, message);
          } else {
            this.#failTurn(turn, message);
          }
        })
        .finally(() => {
          releaseBrowser();
          this.#activeTurns.delete(turn.conversation_id);
          this.#persistActiveState();
          this.#db.prepare("UPDATE conversations SET status = 'idle', updated_at = ? WHERE id = ?").run(Date.now(), turn.conversation_id);
          this.#pump();
        });
    }
  }

  /**
   * Legacy `agent_state` only has room for one active turn, so it mirrors the
   * first (oldest) running turn while the full set is persisted in `queue_json`.
   * Restart reconciliation still inspects every `running` turn in `turns`.
   */
  #persistActiveState(): void {
    const active = [...this.#activeTurns.values()];
    const first = active[0] ?? null;
    this.#db
      .prepare("UPDATE agent_state SET active_turn_id = ?, active_conversation_id = ?, queue_json = ?, updated_at = ? WHERE id = 1")
      .run(first?.turnId ?? null, first?.conversationId ?? null, JSON.stringify(active.map((a) => a.turnId)), Date.now());
  }

  async #runTurn(turn: TurnRow, ctx: ActiveTurn): Promise<void> {
    const conversation = this.getConversation(turn.conversation_id);
    if (!conversation) throw new Error("会话不存在");
    // Validate at claim time too, in case it was interrupted concurrently.
    const claimed = this.#db
      .prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(Date.now(), turn.id);
    if (claimed.changes !== 1) return;

    this.#db.prepare("UPDATE conversations SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), conversation.id);
    this.#appendEvent(conversation.id, turn.id, "turn.started", { turnId: turn.id });

    // The turn holds a browser lease already (reserved synchronously in #pump).
    // Only tasks whose frozen resource plan needs a browser wait for it.
    // Chat/file-only tasks must not depend on browser recovery. Legacy turns
    // retain the conservative default. Wait for a usable browser before executing: if Chromium was released for
    // idleness, this rebuilds it from the snapshot first.
    //
    // A ready() failure must NOT be papered over by starting the Codex turn: the
    // sandbox's own MCP/CLI browser tools reach Chromium directly and bypass this
    // proxy, so a turn that ran anyway could drive a browser we never confirmed.
    // The honest outcome is a failed turn with a fixed, secret-free message; the
    // slot and lease are released by #pump's `finally`.
    if (this.#browser && turn.browser_required !== 0) {
      try {
        await this.#browser.ready();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#log.warn("browser unavailable at turn start", { error: message, turnId: turn.id });
        this.#appendEvent(conversation.id, turn.id, "turn.browser_unavailable", { turnId: turn.id, message });
        throw new Error(message);
      }
    }

    // Honour a stop that arrived while the browser was being rebuilt *before*
    // dispatching: starting a side-effecting Codex turn only to interrupt it
    // immediately is exactly the sequence the review flagged.
    if (this.#turnCancelled(turn.id)) {
      this.#db.prepare("UPDATE turns SET status = 'interrupted', completed_at = ? WHERE id = ?").run(Date.now(), turn.id);
      this.#appendEvent(conversation.id, turn.id, "turn.finished", { turnId: turn.id, status: "interrupted" });
      return;
    }

    // Prefer the model frozen on the turn at submit time. A turn queued before
    // the owner changed the unified setting (or before another turn rewrote
    // `conversations.model`) must still run the model it was accepted with.
    // Legacy rows without a frozen model fall back to the conversation, then the
    // configured default (never Codex's own gpt-6-astra default).
    const model = turn.model ?? conversation.model ?? this.#cfg.agent.defaultModel;
    // The provider is decided by the model that will actually run, and only a
    // bridge model ever resolves to a non-ChatGPT provider. A ChatGPT turn never
    // sends `modelProvider`, so that path stays byte-identical to before.
    const desiredProvider = this.#bridge?.providerForModel(model) ?? CHATGPT_PROVIDER_ID;
    // A conversation with no recorded provider was created on ChatGPT.
    const currentProvider = conversation.model_provider ?? CHATGPT_PROVIDER_ID;
    const developerInstructions = readSoul(this.#cfg).content;
    let threadId = conversation.codex_thread_id;
    if (!threadId) {
      const started = await this.#codex.startThread({
        developerInstructions,
        cwd: conversation.cwd ?? undefined,
        model,
        ...(desiredProvider !== CHATGPT_PROVIDER_ID ? { modelProvider: desiredProvider } : {}),
      });
      threadId = started.threadId;
      this.#db
        .prepare(
          "UPDATE conversations SET codex_thread_id = ?, model = COALESCE(model, ?), model_provider = ?, cwd = ? WHERE id = ?",
        )
        .run(threadId, started.model, desiredProvider, started.cwd, conversation.id);
      this.#appendEvent(conversation.id, turn.id, "thread.started", {
        threadId,
        model: started.model,
        cwd: started.cwd,
        modelProvider: desiredProvider,
      });
    } else if (desiredProvider !== currentProvider) {
      // Codex only honours `modelProvider` when a thread is created, so an
      // existing conversation switching providers continues on a fork that keeps
      // the history. Resuming would silently stay on the old provider.
      const forked = await this.#codex.forkThread(threadId, {
        developerInstructions,
        model,
        // Same rule as the start branch: a ChatGPT thread is forked without a
        // `modelProvider`, so that path never names the provider explicitly.
        ...(desiredProvider !== CHATGPT_PROVIDER_ID ? { modelProvider: desiredProvider } : {}),
        ...(conversation.cwd ? { cwd: conversation.cwd } : {}),
      });
      threadId = forked.threadId;
      this.#db
        .prepare("UPDATE conversations SET codex_thread_id = ?, model_provider = ?, cwd = ? WHERE id = ?")
        .run(threadId, desiredProvider, forked.cwd, conversation.id);
      this.#log.info("conversation switched provider by forking its thread", {
        conversationId: conversation.id,
        from: currentProvider,
        to: desiredProvider,
        model,
      });
      this.#appendEvent(conversation.id, turn.id, "thread.started", {
        threadId,
        model: forked.model,
        cwd: forked.cwd,
        modelProvider: desiredProvider,
        forkedFrom: conversation.codex_thread_id,
      });
    } else {
      await this.#codex.resumeThread(threadId, developerInstructions);
    }
    // Route later notifications for this thread back to this exact turn even
    // while several conversations are executing at once.
    ctx.threadId = threadId;

    const generation = this.#codexGeneration;
    let codexTurnId: string;
    try {
      codexTurnId = await this.#codex.startTurn({
        threadId,
        text: turn.input_text,
        attachments: parseAttachments(turn.attachments_json),
        model,
        effort: turn.effort,
        clientUserMessageId: turn.client_message_id,
        summary: this.#cfg.agent.reasoningSummary,
      });
    } catch (err) {
      // The turn may already have been accepted by Codex before the transport
      // failed; treat that as unknown rather than a clean failure.
      if (this.#codexGeneration !== generation || !this.#codex.ready) {
        throw new TurnOutcomeUnknownError("启动轮次时与沙箱 Codex 的连接中断，执行结果未知");
      }
      throw err;
    }
    ctx.codexTurnId = codexTurnId;
    this.#db.prepare("UPDATE turns SET codex_turn_id = ? WHERE id = ?").run(codexTurnId, turn.id);
    this.#appendEvent(conversation.id, turn.id, "turn.codex_started", { turnId: turn.id, codexTurnId });

    // A stop request that arrived while we were still starting has to be honoured
    // now that a Codex turn id exists.
    const cancelRow = this.#db.prepare("SELECT cancel_requested FROM turns WHERE id = ?").get(turn.id) as unknown as
      | { cancel_requested: number }
      | undefined;
    if (cancelRow?.cancel_requested) {
      try {
        await this.#codex.interrupt(threadId, codexTurnId);
      } catch (err) {
        this.#log.warn("deferred interrupt failed", { error: String(err) });
      }
    }

    const status = await this.#waitForTurn(codexTurnId, generation);
    this.#flushDeltas();
    if (status === "completed") {
      this.#db.prepare("UPDATE turns SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), turn.id);
      this.#appendEvent(conversation.id, turn.id, "turn.finished", { turnId: turn.id, status: "completed" });
      // Name the conversation from its first message only, and only once the
      // first turn has actually completed. Later turns never rename it.
      const firstTurn = this.#db
        .prepare("SELECT id FROM turns WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get(conversation.id) as { id: string } | undefined;
      if (firstTurn?.id === turn.id) this.#titles.scheduleForConversation(conversation.id);
    } else if (status === "interrupted") {
      this.#db.prepare("UPDATE turns SET status = 'interrupted', completed_at = ? WHERE id = ?").run(Date.now(), turn.id);
      this.#appendEvent(conversation.id, turn.id, "turn.finished", { turnId: turn.id, status: "interrupted" });
    } else if (status === "unknown") {
      this.#db
        .prepare("UPDATE turns SET status = 'unknown', error = ?, completed_at = ? WHERE id = ?")
        .run("与沙箱 Codex 的连接中断，本次执行结果未知", Date.now(), turn.id);
      this.#appendEvent(conversation.id, turn.id, "turn.finished", {
        turnId: turn.id,
        status: "unknown",
        message:
          "与沙箱 Codex 的连接中断，本次执行结果未知，可能已产生操作。请先核对沙箱内文件/进程状态，系统不会自动重放该轮次。",
      });
    } else {
      this.#failTurn(turn, `Codex 轮次结束状态：${status}`);
    }
  }

  /** True when a stop was requested for this turn before it was dispatched. */
  #turnCancelled(turnId: string): boolean {
    const row = this.#db.prepare("SELECT cancel_requested FROM turns WHERE id = ?").get(turnId) as unknown as
      | { cancel_requested: number }
      | undefined;
    return Boolean(row?.cancel_requested);
  }

  /**
   * The sandbox Codex process died. Release any pending completion waiter with an
   * explicit `unknown` outcome so the active turn is never silently retried.
   */
  #handleCodexClosed(reason: string): void {
    this.#log.warn("sandbox codex closed; marking in-flight work unknown", { reason });
    this.#lastError = `与沙箱 Codex 的连接中断：${reason}`;
    this.#codexGeneration += 1;
    for (const [turnId] of this.#completionWaiters) {
      this.#completedTurns.set(turnId, { status: "unknown" });
    }
    const waiters = [...this.#completionWaiters.values()];
    this.#completionWaiters.clear();
    for (const waiter of waiters) waiter();
    // Approvals held by the dead process can never be answered; resolve them now
    // instead of leaving the UI waiting for the 15 minute timeout.
    for (const request of this.listPendingRequests()) {
      this.#codex.answer(request.codex_request_id, this.#defaultDeny(request.method));
      const timer = this.#approvalTimers.get(request.id);
      if (timer) {
        clearTimeout(timer);
        this.#approvalTimers.delete(request.id);
      }
      this.#db.prepare("UPDATE server_requests SET status = 'expired', resolved_at = ? WHERE id = ?").run(Date.now(), request.id);
      this.#appendEvent(request.conversation_id, request.turn_id, "approval.resolved", {
        requestId: request.id,
        decision: "expired",
        reason: "codex_disconnected",
      });
    }
  }

  #markTurnUnknown(turn: TurnRow, message: string): void {
    this.#db
      .prepare("UPDATE turns SET status = 'unknown', error = ?, completed_at = ? WHERE id = ?")
      .run(message, Date.now(), turn.id);
    this.#appendEvent(turn.conversation_id, turn.id, "turn.finished", {
      turnId: turn.id,
      status: "unknown",
      message: `${message}。请先核对沙箱内文件与进程状态，系统不会自动重放该轮次。`,
    });
  }

  #failTurn(turn: TurnRow, message: string): void {
    this.#db.prepare("UPDATE turns SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").run(message, Date.now(), turn.id);
    this.#appendEvent(turn.conversation_id, turn.id, "turn.failed", { turnId: turn.id, message });
  }

  #waitForTurn(codexTurnId: string, generation: number): Promise<string> {
    // The connection may have died between startTurn returning and this call.
    if (this.#codexGeneration !== generation) return Promise.resolve("unknown");
    const done = this.#completedTurns.get(codexTurnId);
    if (done) {
      this.#completedTurns.delete(codexTurnId);
      return Promise.resolve(done.status);
    }
    return new Promise<string>((resolve) => {
      this.#completionWaiters.set(codexTurnId, () => {
        const info = this.#completedTurns.get(codexTurnId);
        this.#completedTurns.delete(codexTurnId);
        resolve(info?.status ?? "unknown");
      });
    });
  }

  /** Append to the queued input or steer the exact active Codex turn. */
  async appendTurnInput(conversationId: string, localTurnId: string, text: string, attachments: TurnAttachment[], requiresBrowser = false): Promise<"accepted"|"starting"|"not_active"|"browser_unavailable"> {
    const turn = this.#db.prepare("SELECT * FROM turns WHERE id=? AND conversation_id=?").get(localTurnId,conversationId) as unknown as TurnRow | undefined;
    if (!turn || !["queued","running"].includes(turn.status)) return "not_active";
    if (turn.status === "queued") {
      this.#db.prepare("UPDATE turns SET input_text=?,attachments_json=?,browser_required=MAX(browser_required,?) WHERE id=?").run(`${turn.input_text}\n\n${text}`,JSON.stringify([...parseAttachments(turn.attachments_json),...attachments]),requiresBrowser ? 1 : 0,turn.id);
    } else {
      const conversation = this.getConversation(conversationId);
      if (!turn.codex_turn_id || !conversation?.codex_thread_id) return "starting";
      if (!this.#codex.steerTurn) throw new Error("当前执行器不支持运行中补充");
      if (requiresBrowser && turn.browser_required === 0) {
        try { await this.#browser?.ready(); }
        catch { return "browser_unavailable"; }
        // The original task can finish or be stopped during recovery. Never
        // steer stale work or grant browser access before recovery is proven.
        const current = this.#db.prepare("SELECT status,cancel_requested FROM turns WHERE id=?").get(turn.id) as { status: string; cancel_requested: number };
        if (current.status !== "running" || current.cancel_requested) return "not_active";
        this.#db.prepare("UPDATE turns SET browser_required=1 WHERE id=?").run(turn.id);
      }
      await this.#codex.steerTurn({threadId:conversation.codex_thread_id,expectedTurnId:turn.codex_turn_id,text,attachments});
    }
    this.#appendEvent(conversationId,turn.id,"turn.input_appended",{text,attachments});
    return "accepted";
  }

  /**
   * Stop the newest queued or running turn for a conversation.
   *
   * - queued: atomically cancelled, it will never be picked up by the pump
   * - running with a Codex turn id: `turn/interrupt` is sent
   * - running but still starting: a cancel marker makes the pump interrupt the
   *   moment the Codex turn id exists
   */
  async interrupt(conversationId: string): Promise<{ ok: boolean; status: "queued" | "running" | "starting" | "none"; message: string }> {
    const queued = this.#db
      .prepare("SELECT * FROM turns WHERE conversation_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
      .get(conversationId) as unknown as TurnRow | undefined;
    if (queued) {
      const res = this.#db
        .prepare("UPDATE turns SET status = 'interrupted', error = ?, completed_at = ? WHERE id = ? AND status = 'queued'")
        .run("用户取消了排队中的轮次", Date.now(), queued.id);
      if (res.changes === 1) {
        this.#appendEvent(conversationId, queued.id, "turn.cancelled", { turnId: queued.id, stage: "queued" });
        return { ok: true, status: "queued", message: "已取消排队中的轮次" };
      }
    }

    const running = this.#db
      .prepare("SELECT * FROM turns WHERE conversation_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1")
      .get(conversationId) as unknown as TurnRow | undefined;
    if (!running) {
      return { ok: false, status: "none", message: "当前没有正在执行或排队中的轮次" };
    }

    const conversation = this.getConversation(conversationId);
    if (running.codex_turn_id && conversation?.codex_thread_id) {
      await this.#codex.interrupt(conversation.codex_thread_id, running.codex_turn_id);
      this.#appendEvent(conversationId, running.id, "turn.interrupt_requested", { turnId: running.id, stage: "running" });
      return { ok: true, status: "running", message: "已请求停止当前执行" };
    }

    this.#db.prepare("UPDATE turns SET cancel_requested = 1 WHERE id = ? AND status = 'running'").run(running.id);
    this.#appendEvent(conversationId, running.id, "turn.interrupt_requested", { turnId: running.id, stage: "starting" });
    return { ok: true, status: "starting", message: "已请求停止，该轮次将在启动完成后立即中断" };
  }

  // ------------------------------------------------------------ approvals

  /** Local turn id for a Codex turn id, or null when it is not ours. */
  #localTurnId(codexTurnId: string | undefined): string | null {
    if (!codexTurnId) return null;
    const row = this.#db.prepare("SELECT id FROM turns WHERE codex_turn_id = ?").get(codexTurnId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Resolve the conversation/turn an inbound notification belongs to.
   *
   * Under concurrency an event is only attributed when it carries a `threadId`
   * or `turnId` that maps to a known conversation/turn, and when the two
   * identities agree (a thread from one conversation with a turn from another is
   * rejected). Once a conversation's active turn has its Codex turn id, an
   * older/other turn id on the same thread is stale and dropped. An event with
   * an unknown thread id is dropped — never assigned to a random active
   * conversation — which is also how an isolated auxiliary (auto-title) thread
   * stays isolated. The fallback to "the single active turn" only applies when
   * the event carries no usable identity at all and exactly one turn runs.
   */
  #routeContext(params: Record<string, unknown>): { conversationId: string; turnId: string | null } | null {
    const threadId = typeof params.threadId === "string" && params.threadId ? params.threadId : undefined;
    const codexTurnId = typeof params.turnId === "string" && params.turnId ? params.turnId : undefined;

    if (threadId) {
      const row = this.#db.prepare("SELECT id FROM conversations WHERE codex_thread_id = ?").get(threadId) as
        | { id: string }
        | undefined;
      // An unknown thread is never attributed to whatever turn happens to be
      // active: that is also how an isolated auxiliary (auto-title) thread stays
      // isolated.
      if (!row?.id) return null;
      const conversationId = row.id;
      const active = this.#activeTurns.get(conversationId);
      if (codexTurnId) {
        const local = this.#localTurnId(codexTurnId);
        if (local) {
          const owner = this.#db.prepare("SELECT conversation_id FROM turns WHERE id = ?").get(local) as
            | { conversation_id: string }
            | undefined;
          // The thread and the turn must agree. Combining conversation A's
          // thread with conversation B's turn would otherwise write B's event
          // into A.
          if (owner?.conversation_id !== conversationId) return null;
          // Once this conversation's active turn has a Codex turn id, only that
          // turn is still live: an older/other turn id on the same thread is
          // stale and must not be attributed to the current turn.
          if (active?.codexTurnId && active.codexTurnId !== codexTurnId) return null;
          return { conversationId, turnId: local };
        }
        // The turn id is not persisted yet, so it can only be an early event for
        // the turn that is still starting. If the active turn already carries a
        // different Codex turn id, this one is stale.
        if (active?.codexTurnId) return null;
        return { conversationId, turnId: active?.turnId ?? null };
      }
      // No turn identity at all: the known thread alone routes to its
      // conversation and, while it is active, to its current turn.
      return { conversationId, turnId: active?.turnId ?? null };
    }

    const local = this.#localTurnId(codexTurnId);
    if (local) {
      const row = this.#db.prepare("SELECT conversation_id FROM turns WHERE id = ?").get(local) as
        | { conversation_id: string }
        | undefined;
      if (row) {
        const active = this.#activeTurns.get(row.conversation_id);
        if (active?.codexTurnId && active.codexTurnId !== codexTurnId) return null;
        return { conversationId: row.conversation_id, turnId: local };
      }
    }
    // No usable identity at all: only an unambiguous single active turn can
    // claim the event. A turn id that contradicts that turn is dropped.
    if (this.#activeTurns.size === 1) {
      const only = this.#activeTurns.values().next().value as ActiveTurn;
      if (codexTurnId && only.codexTurnId && only.codexTurnId !== codexTurnId) return null;
      return { conversationId: only.conversationId, turnId: only.turnId };
    }
    return null;
  }

  #handleServerRequest(id: string, method: string, params: unknown): void {
    const route = this.#routeContext((params ?? {}) as Record<string, unknown>);
    if (!route) {
      // An approval we cannot attribute (unknown/aux thread, or several active
      // turns and no identity) is denied rather than shown for a random turn.
      this.#codex.answer(id, this.#defaultDeny(method));
      return;
    }
    const { conversationId, turnId } = route;
    const requestId = randomId("req");
    this.#db
      .prepare(
        "INSERT INTO server_requests (id, conversation_id, turn_id, codex_request_id, method, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(requestId, conversationId, turnId, id, method, JSON.stringify(params ?? null), Date.now());
    this.#appendEvent(conversationId, turnId, "approval.requested", { requestId, method, params });
    this.#log.info("approval requested", { method, conversationId });

    const timer = setTimeout(() => {
      this.#expireRequest(requestId);
    }, APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    this.#approvalTimers.set(requestId, timer);
  }

  #expireRequest(requestId: string): void {
    const row = this.#db.prepare("SELECT * FROM server_requests WHERE id = ?").get(requestId) as
      | { id: string; conversation_id: string; turn_id: string | null; codex_request_id: string; method: string; status: string }
      | undefined;
    if (!row || row.status !== "pending") return;
    this.#codex.answer(row.codex_request_id, this.#defaultDeny(row.method));
    this.#db.prepare("UPDATE server_requests SET status = 'expired', resolved_at = ? WHERE id = ?").run(Date.now(), requestId);
    this.#approvalTimers.delete(requestId);
    this.#appendEvent(row.conversation_id, row.turn_id, "approval.resolved", { requestId, decision: "expired" });
  }

  listPendingRequests(conversationId?: string): PendingRequestRow[] {
    const rows = (
      conversationId
        ? this.#db.prepare("SELECT * FROM server_requests WHERE status = 'pending' AND conversation_id = ? ORDER BY created_at ASC").all(conversationId)
        : this.#db.prepare("SELECT * FROM server_requests WHERE status = 'pending' ORDER BY created_at ASC").all()
    ) as Array<{
      id: string;
      conversation_id: string;
      turn_id: string | null;
      codex_request_id: string;
      method: string;
      payload: string;
      status: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      conversation_id: r.conversation_id,
      turn_id: r.turn_id,
      codex_request_id: r.codex_request_id,
      method: r.method,
      payload: JSON.parse(r.payload) as unknown,
      status: r.status,
      created_at: r.created_at,
    }));
  }

  /**
   * Map a simple UI decision onto the method-specific response shape Codex expects.
   * Answers are idempotent: an already-resolved request is reported as such.
   */
  respondToRequest(requestId: string, decision: string, extra?: unknown): { ok: boolean; message: string } {
    const row = this.#db.prepare("SELECT * FROM server_requests WHERE id = ?").get(requestId) as
      | {
          id: string;
          conversation_id: string;
          turn_id: string | null;
          codex_request_id: string;
          method: string;
          payload: string;
          status: string;
        }
      | undefined;
    if (!row) return { ok: false, message: "审批请求不存在" };
    if (row.status !== "pending") return { ok: false, message: "该审批已处理" };

    const response = buildApprovalResponse(row.method, decision, extra);
    if (!response) return { ok: false, message: `不支持的审批类型：${row.method}` };
    if (!this.#codex.answer(row.codex_request_id, response)) {
      this.#db.prepare("UPDATE server_requests SET status = 'expired', resolved_at = ? WHERE id = ?").run(Date.now(), requestId);
      this.#appendEvent(row.conversation_id, row.turn_id, "approval.resolved", { requestId, decision: "expired" });
      return { ok: false, message: "该审批已失效" };
    }
    const timer = this.#approvalTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.#approvalTimers.delete(requestId);
    }
    this.#db
      .prepare("UPDATE server_requests SET status = 'answered', response = ?, resolved_at = ? WHERE id = ?")
      .run(JSON.stringify(response), Date.now(), requestId);
    this.#appendEvent(row.conversation_id, row.turn_id, "approval.resolved", { requestId, decision, response });
    return { ok: true, message: "已处理" };
  }

  #defaultDeny(method: string): unknown {
    // Legacy approval methods use ReviewDecision values, not the v2 accept/decline set.
    if (method === "applyPatchApproval" || method === "execCommandApproval") return { decision: "denied" };
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request") return { action: "decline", content: null };
    if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
    return { decision: "decline" };
  }

  // --------------------------------------------------------- notifications

  #handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "turn/completed") {
      const turn = p.turn as { id?: string; status?: string } | undefined;
      if (turn?.id) {
        this.#flushDeltas();
        this.#completedTurns.set(turn.id, { status: turn.status ?? "completed" });
        const waiter = this.#completionWaiters.get(turn.id);
        if (waiter) {
          this.#completionWaiters.delete(turn.id);
          waiter();
        }
      }
    }

    if (DELTA_METHODS.has(method)) {
      this.#bufferDelta(method, p);
      return;
    }

    const route = this.#routeContext(p);
    if (!route) return;
    // Flush buffered deltas first: they arrived before this event, so they must get
    // lower sequence ids. Otherwise a client that applied the completed item first
    // would append stale deltas afterwards and duplicate the text.
    //
    // The flush must happen even when this notification turns out to be an exact
    // duplicate (see below): pending deltas for the same item still have to be
    // persisted ahead of the (dropped) started/completed marker.
    this.#flushDeltas();
    if (ITEM_LIFECYCLE_METHODS.has(method) && this.#hasIdenticalItemEvent(route.conversationId, route.turnId, method, params)) {
      return;
    }
    this.#appendEvent(route.conversationId, route.turnId, method, params);
  }

  /**
   * Whether an identical item-lifecycle event is already persisted.
   *
   * The bridge model re-sends the very same `item/started` / `item/completed`
   * notification a second time. The dedup key is the full tuple —
   * conversation + turn + event type + item id + complete payload — so only an
   * exact repeat is dropped. A same item id with a different payload, a
   * different item id, or a different turn still persists.
   *
   * The check reads the events table rather than an in-process Set, so it keeps
   * working after a restart. Events without an item id are never deduplicated
   * (nothing real is swallowed), and existing history is untouched.
   */
  #hasIdenticalItemEvent(
    conversationId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
  ): boolean {
    const item = (payload as { item?: unknown } | null)?.item;
    const itemId = (item as { id?: unknown } | null)?.id;
    if (typeof itemId !== "string" || !itemId) return false;
    const row = this.#db
      .prepare(
        `SELECT id FROM events
          WHERE conversation_id = ? AND type = ? AND turn_id IS ? AND payload = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(conversationId, type, turnId, JSON.stringify(payload ?? null)) as { id: number } | undefined;
    return row !== undefined;
  }

  #bufferDelta(method: string, params: Record<string, unknown>): void {
    const route = this.#routeContext(params);
    if (!route) return;
    const itemId = String(params.itemId ?? params.turnId ?? "stream");
    const text = extractDeltaText(method, params);
    if (!text) return;
    const key = `${route.conversationId}:${itemId}:${method}`;
    const existing = this.#deltaBuffers.get(key);
    if (existing) {
      existing.text += text;
    } else {
      this.#deltaBuffers.set(key, { conversationId: route.conversationId, turnId: route.turnId, itemId, kind: method, text });
    }
    if (!this.#deltaTimer) {
      this.#deltaTimer = setTimeout(() => this.#flushDeltas(), 250);
      this.#deltaTimer.unref?.();
    }
  }

  #flushDeltas(): void {
    if (this.#deltaTimer) {
      clearTimeout(this.#deltaTimer);
      this.#deltaTimer = null;
    }
    if (!this.#deltaBuffers.size) return;
    const buffered = [...this.#deltaBuffers.values()];
    this.#deltaBuffers.clear();
    for (const b of buffered) {
      this.#appendEvent(b.conversationId, b.turnId, "stream.delta", {
        itemId: b.itemId,
        kind: b.kind,
        delta: b.text,
      });
    }
  }

  // --------------------------------------------------------------- status

  async status(): Promise<AgentStatus> {
    const queued = (this.#db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'queued'").get() as { n: number }).n;
    const account = this.#codex.account;
    const active = [...this.#activeTurns.values()];
    const first = active[0] ?? null;
    return {
      sessionReady: this.#codex.ready,
      account,
      activeTurnId: first?.turnId ?? null,
      activeConversationId: first?.conversationId ?? null,
      activeTurns: active.map((a) => ({
        conversationId: a.conversationId,
        turnId: a.turnId,
        codexTurnId: a.codexTurnId,
        threadId: a.threadId,
      })),
      capacity: this.#capacity,
      queuedTurns: queued,
      lastError: this.#codex.lastError ?? this.#lastError,
    };
  }

  async ensureSession(): Promise<void> {
    await this.#codex.start();
  }

  /**
   * Models offered by the sandbox Codex, with this product's configured default
   * marked. The CLI has its own default (currently gpt-6-astra) which this agent
   * never runs implicitly, and the UI labels the default from `isDefault`.
   */
  async listModels() {
    const models = this.#withBridgeModels(await this.#codex.listModels());
    // Cache the catalog so a later synchronous submit can validate the unified
    // effort without another Codex round trip.
    this.#modelCatalog = models;
    const preferred = this.#cfg.agent.defaultModel;
    if (!models.some((m) => m.id === preferred)) return models;
    return models.map((m) => ({ ...m, isDefault: m.id === preferred }));
  }

  /**
   * Append the optional bridge models to the Codex catalog.
   *
   * A custom provider's models never appear in `model/list` (the provider's own
   * catalog is not merged), so the control plane adds those entries itself.
   * With no bridge key the catalog is returned untouched, and an entry whose id
   * the CLI already reports is never shadowed by the synthetic one.
   */
  #withBridgeModels(models: CodexModel[]): CodexModel[] {
    const entries = this.#bridge?.modelEntries() ?? [];
    const known = new Set(models.map((m) => m.id));
    const added = entries.filter((entry) => !known.has(entry.id));
    if (added.length === 0) return models;
    return [...models, ...added];
  }

  /**
   * Best-effort catalog warm-up used at init. Failures are swallowed: a submit
   * falls back to the stored (already validated) effort when the catalog is not
   * yet known, so a cold sandbox never blocks or downgrades a later turn.
   */
  async refreshModelCatalog(): Promise<void> {
    try {
      await this.listModels();
    } catch (err) {
      this.#log.debug("model catalog unavailable at init", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Whether a model catalog has been observed (settings UI disables saving when not). */
  hasModelCatalog(): boolean {
    return this.#modelCatalog.length > 0;
  }

  async hostAuthStatus() {
    return await this.#hostTokens.status();
  }

  shutdown(): void {
    this.#flushDeltas();
    for (const timer of this.#approvalTimers.values()) clearTimeout(timer);
    this.#approvalTimers.clear();
    this.#codex.close();
  }
}

export function parseAttachments(json: string | null | undefined): TurnAttachment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is { path: string; kind?: string; name?: string } => Boolean(a) && typeof (a as { path?: unknown }).path === "string")
      .map((a) => ({ path: a.path, kind: a.kind === "image" ? "image" : "file", name: a.name }));
  } catch {
    return [];
  }
}

export function extractDeltaText(method: string, params: Record<string, unknown>): string {
  const candidates = ["delta", "text", "output", "chunk"];
  for (const key of candidates) {
    const v = params[key];
    if (typeof v === "string" && v.length) return v;
  }
  return "";
}

export function buildApprovalResponse(method: string, decision: string, extra?: unknown): unknown | null {
  const normalized = decision === "accept" || decision === "acceptForSession" || decision === "decline" || decision === "cancel" ? decision : null;
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      if (!normalized) return null;
      return { decision: normalized };
    case "applyPatchApproval":
    case "execCommandApproval":
      return {
        decision:
          decision === "accept" || decision === "acceptForSession"
            ? "approved"
            : decision === "cancel"
              ? "abort"
              : "denied",
      };
    case "item/permissions/requestApproval":
      return decision === "accept" || decision === "acceptForSession"
        ? { permissions: (extra as object) ?? {}, scope: decision === "acceptForSession" ? "session" : "turn" }
        : { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput": {
      const answers = (extra as { answers?: Record<string, unknown> } | undefined)?.answers ?? {};
      return { answers };
    }
    case "mcpServer/elicitation/request": {
      // MCP elicitation uses an action/content envelope, not the answers map.
      const action = decision === "accept" ? "accept" : decision === "cancel" ? "cancel" : "decline";
      const content = (extra as { content?: unknown } | undefined)?.content ?? null;
      return action === "accept" ? { action, content } : { action, content: null };
    }
    default:
      return null;
  }
}
