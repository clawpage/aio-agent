import { EventEmitter } from "node:events";
import type { Db } from "../db.js";
import { getMeta, setMeta } from "../db.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexModel, SandboxAccount } from "./sandboxCodex.js";
import type { HostTokenSource } from "./hostTokens.js";
import { AutoTitler, DEFAULT_CONVERSATION_TITLE, TITLE_UPDATED_EVENT, manualTitleMetaKey } from "./autoTitle.js";

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
  startThread(opts: { cwd?: string; model?: string }): Promise<{ threadId: string; model: string; cwd: string }>;
  resumeThread(threadId: string): Promise<void>;
  startTurn(params: {
    threadId: string;
    text: string;
    attachments?: Array<{ path: string; kind: "image" | "file"; name?: string }>;
    model?: string | null;
    effort?: string | null;
    cwd?: string | null;
    clientUserMessageId?: string | null;
  }): Promise<string>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  /** One throwaway, tool-free run used only for automatic conversation titles. */
  generateTitle(userText: string): Promise<string | null>;
  answer(id: string, result: unknown): boolean;
  close(): void;
}
import { randomId } from "../auth/passwords.js";

export interface ConversationRow {
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

const DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
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

export interface SubmitTurnInput {
  conversationId: string;
  text: string;
  clientMessageId: string;
  attachments?: TurnAttachment[];
  model?: string | null;
  effort?: string | null;
  cwd?: string | null;
}

export interface AgentStatus {
  sessionReady: boolean;
  account: { email: string | null; planType: string | null; type: string } | null;
  activeTurnId: string | null;
  activeConversationId: string | null;
  queuedTurns: number;
  lastError: string | null;
}

/**
 * Owns conversation persistence, the single sandbox execution queue, streamed
 * event log and approval lifecycle. Browser disconnects never affect execution:
 * events are written to SQLite first and streamed to whoever is connected.
 */
export class AgentManager {
  readonly events = new EventEmitter();
  #db: Db;
  #cfg: Config;
  #log: Logger;
  #codex: CodexSessionLike;
  #hostTokens: HostTokenSource;
  #titles: AutoTitler;

  #activeTurnId: string | null = null;
  #activeConversationId: string | null = null;
  #pumping = false;
  #deltaBuffers = new Map<string, { conversationId: string; turnId: string | null; itemId: string; kind: string; text: string }>();
  #deltaTimer: NodeJS.Timeout | null = null;
  #completionWaiters = new Map<string, () => void>();
  #completedTurns = new Map<string, { status: string }>();
  #lastError: string | null = null;
  #approvalTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Incremented whenever the sandbox Codex connection dies. A turn captures the
   * value before starting; if it changed, the outcome is unknown and must not be
   * waited on (the completion notification can never arrive).
   */
  #codexGeneration = 0;

  constructor(deps: { cfg: Config; db: Db; log: Logger; codex: CodexSessionLike; hostTokens: HostTokenSource }) {
    this.#cfg = deps.cfg;
    this.#db = deps.db;
    this.#log = deps.log.child("agent");
    this.#codex = deps.codex;
    this.#hostTokens = deps.hostTokens;
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
    this.#codex.onNotification((method, params) => this.#handleNotification(method, params));
    this.#codex.onServerRequest((id, method, params) => this.#handleServerRequest(id, method, params));
    this.#codex.onClosed((reason) => this.#handleCodexClosed(reason));
    // Resume queue processing if the previous process died mid-queue.
    void this.#pump();
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

  listConversations(includeArchived = false): Array<ConversationRow & { turnCount: number }> {
    const rows = this.#db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turnCount
         FROM conversations c WHERE (? OR c.archived = 0) ORDER BY c.updated_at DESC`,
      )
      .all(includeArchived ? 1 : 0) as unknown as Array<ConversationRow & { turnCount: number }>;
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

  renameConversation(id: string, title: string): boolean {
    const now = Date.now();
    const nextTitle = title.trim().slice(0, 200) || "会话";
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
    return changed;
  }

  archiveConversation(id: string, archived = true): boolean {
    const res = this.#db.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, Date.now(), id);
    return res.changes > 0;
  }

  listTurns(conversationId: string): TurnRow[] {
    return this.#db
      .prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId) as unknown as TurnRow[];
  }

  // ---------------------------------------------------------------- turns

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
    try {
      this.#db
        .prepare(
          "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, attachments_json, effort, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)",
        )
        .run(id, input.conversationId, input.clientMessageId, input.text, JSON.stringify(attachments), input.effort ?? null, now);
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
    // that will run agree: an explicit client choice wins, then the model the
    // conversation already uses, then the configured default.
    const model = input.model ?? conversation.model ?? this.#cfg.agent.defaultModel;
    this.#db
      .prepare("UPDATE conversations SET model = ?, cwd = COALESCE(?, cwd) WHERE id = ?")
      .run(model, input.cwd ?? null, input.conversationId);
    this.#appendEvent(input.conversationId, id, "turn.queued", {
      turnId: id,
      clientMessageId: input.clientMessageId,
      text: input.text,
      attachments,
      model,
      effort: input.effort ?? null,
      cwd: input.cwd ?? null,
    });
    const turn = this.#db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as unknown as TurnRow;
    void this.#pump();
    return { turn, duplicate: false };
  }

  #nextQueuedTurn(): TurnRow | null {
    return (
      (this.#db.prepare("SELECT * FROM turns WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get() as unknown as TurnRow | undefined) ??
      null
    );
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const turn = this.#nextQueuedTurn();
        if (!turn) break;
        this.#activeTurnId = turn.id;
        this.#activeConversationId = turn.conversation_id;
        this.#db.prepare("UPDATE agent_state SET active_turn_id = ?, active_conversation_id = ?, updated_at = ? WHERE id = 1").run(
          turn.id,
          turn.conversation_id,
          Date.now(),
        );
        try {
          await this.#runTurn(turn);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.#lastError = message;
          if (err instanceof TurnOutcomeUnknownError) {
            this.#markTurnUnknown(turn, message);
          } else {
            this.#failTurn(turn, message);
          }
        } finally {
          this.#activeTurnId = null;
          this.#activeConversationId = null;
          this.#db.prepare("UPDATE agent_state SET active_turn_id = NULL, active_conversation_id = NULL, updated_at = ? WHERE id = 1").run(
            Date.now(),
          );
          this.#db.prepare("UPDATE conversations SET status = 'idle', updated_at = ? WHERE id = ?").run(Date.now(), turn.conversation_id);
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #runTurn(turn: TurnRow): Promise<void> {
    const conversation = this.getConversation(turn.conversation_id);
    if (!conversation) throw new Error("会话不存在");
    // Validate at claim time too, in case it was interrupted concurrently.
    const claimed = this.#db
      .prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(Date.now(), turn.id);
    if (claimed.changes !== 1) return;

    this.#db.prepare("UPDATE conversations SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), conversation.id);
    this.#appendEvent(conversation.id, turn.id, "turn.started", { turnId: turn.id });

    // Resolve against the configured default as well: a conversation without a
    // stored model would otherwise make Codex fall back to its own default
    // (currently gpt-6-astra), which this agent never runs implicitly.
    const model = conversation.model ?? this.#cfg.agent.defaultModel;
    let threadId = conversation.codex_thread_id;
    if (!threadId) {
      const started = await this.#codex.startThread({ cwd: conversation.cwd ?? undefined, model });
      threadId = started.threadId;
      this.#db.prepare("UPDATE conversations SET codex_thread_id = ?, model = COALESCE(model, ?), cwd = ? WHERE id = ?").run(
        threadId,
        started.model,
        started.cwd,
        conversation.id,
      );
      this.#appendEvent(conversation.id, turn.id, "thread.started", { threadId, model: started.model, cwd: started.cwd });
    } else {
      await this.#codex.resumeThread(threadId);
    }

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
      });
    } catch (err) {
      // The turn may already have been accepted by Codex before the transport
      // failed; treat that as unknown rather than a clean failure.
      if (this.#codexGeneration !== generation || !this.#codex.ready) {
        throw new TurnOutcomeUnknownError("启动轮次时与沙箱 Codex 的连接中断，执行结果未知");
      }
      throw err;
    }
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

  #conversationForThread(threadId: string | undefined, fallbackConversationId: string | null): string | null {
    if (threadId) {
      const row = this.#db.prepare("SELECT id FROM conversations WHERE codex_thread_id = ?").get(threadId) as { id: string } | undefined;
      // A known thread always maps to its own conversation. An unknown thread is
      // never silently attributed to whatever turn happens to be active: that is
      // how an isolated auxiliary (auto-title) thread stays isolated.
      return row?.id ?? null;
    }
    return fallbackConversationId;
  }

  #handleServerRequest(id: string, method: string, params: unknown): void {
    const p = (params ?? {}) as { threadId?: string; turnId?: string };
    const conversationId = this.#conversationForThread(p.threadId, this.#activeConversationId);
    if (!conversationId) {
      this.#codex.answer(id, this.#defaultDeny(method));
      return;
    }
    const turnRow = p.turnId
      ? (this.#db.prepare("SELECT id FROM turns WHERE codex_turn_id = ?").get(p.turnId) as { id: string } | undefined)
      : undefined;
    const turnId = turnRow?.id ?? this.#activeTurnId;
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

    const conversationId = this.#conversationForThread(p.threadId as string | undefined, this.#activeConversationId);
    if (!conversationId) return;
    // Flush buffered deltas first: they arrived before this event, so they must get
    // lower sequence ids. Otherwise a client that applied the completed item first
    // would append stale deltas afterwards and duplicate the text.
    this.#flushDeltas();
    const turnId = this.#activeConversationId === conversationId ? this.#activeTurnId : null;
    this.#appendEvent(conversationId, turnId, method, params);
  }

  #bufferDelta(method: string, params: Record<string, unknown>): void {
    const conversationId = this.#activeConversationId;
    if (!conversationId) return;
    // When a notification carries an explicit thread id it must belong to the
    // active conversation's registered main thread. Auxiliary (auto-title) and
    // unknown threads are dropped rather than attributed to the active
    // conversation. Early events without a thread id keep the original behaviour.
    const threadId = params.threadId;
    if (typeof threadId === "string") {
      const row = this.#db.prepare("SELECT id FROM conversations WHERE codex_thread_id = ?").get(threadId) as { id: string } | undefined;
      if (row?.id !== conversationId) return;
    }
    const itemId = String(params.itemId ?? params.turnId ?? "stream");
    const text = extractDeltaText(method, params);
    if (!text) return;
    const key = `${conversationId}:${itemId}:${method}`;
    const existing = this.#deltaBuffers.get(key);
    if (existing) {
      existing.text += text;
    } else {
      this.#deltaBuffers.set(key, { conversationId, turnId: this.#activeTurnId, itemId, kind: method, text });
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
    return {
      sessionReady: this.#codex.ready,
      account,
      activeTurnId: this.#activeTurnId,
      activeConversationId: this.#activeConversationId,
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
    const models = await this.#codex.listModels();
    const preferred = this.#cfg.agent.defaultModel;
    if (!models.some((m) => m.id === preferred)) return models;
    return models.map((m) => ({ ...m, isDefault: m.id === preferred }));
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
