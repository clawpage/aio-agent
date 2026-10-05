import { MEMBER_GPT_MODEL } from "../auth/policy.js";
import { tabThreadConfig, type BrowserTask } from "../browser/tabs.js";
import { decisionThreadServers } from "../decision.js";
import { kbThreadServers } from "../kb.js";
import { scheduleThreadServers } from "../scheduleTool.js";
import { imageThreadServers } from "../imageTool.js";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import type { SandboxContainer } from "../sandbox/container.js";
import type { BridgeModel } from "../bridgeModel.js";
import { JsonRpcPeer, JsonRpcTimeoutError } from "./jsonrpc.js";
import type { DispatchTimingSink } from "./dispatchTiming.js";
import type { HostTokenSource } from "./hostTokens.js";
import type { UsageLedger } from '../usage.js';

export interface SandboxAccount {
  email: string | null;
  planType: string | null;
  type: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  /**
   * Provider this model must run on. Absent means Codex's own ChatGPT provider;
   * the bridge model is the only entry that carries another one.
   */
  modelProvider?: string;
}

export type ServerRequestResolver = (result: unknown) => void;

/**
 * One long-lived `codex app-server` process inside the sandbox, driven over
 * `docker exec -i` stdio. The sandbox owns execution; the Mac only supplies
 * ChatGPT access tokens through the host's official managed refresh.
 */
export class SandboxCodexSession {
  #cfg: Config;
  #log: Logger;
  #container: SandboxContainer;
  #hostTokens: HostTokenSource;
  #bridge: BridgeModel | null;
  #peer: JsonRpcPeer | null = null;
  #starting: Promise<void> | null = null;
  #pendingRequests = new Map<string, ServerRequestResolver>();
  #onNotification: ((method: string, params: unknown) => void) | null = null;
  #onServerRequest: ((id: string, method: string, params: unknown) => void) | null = null;
  #onClosed: ((reason: string) => void) | null = null;
  /**
   * Auxiliary ephemeral threads (the dispatcher) and the listeners that own their
   * notifications. Routing by thread id keeps their events, approvals and deltas
   * completely out of the user's main conversation stream.
   */
  #threadSubscribers = new Map<string, Set<(method: string, params: unknown) => void>>();
  /**
   * Auxiliary threads whose run ended from our point of view (timeout / error)
   * but which may still emit late notifications. Their events are dropped — never
   * attributed to the active user conversation — until a real `turn/completed`
   * proves the run is over. Insertion order is used for bounded eviction.
   */
  #discardedThreads = new Map<string, true>();
  /** Maximum number of tombstoned auxiliary threads kept for late-event dropping. */
  static readonly MAX_DISCARDED_THREADS = 64;
  #account: SandboxAccount | null = null;
  #lastError: string | null = null;

  constructor(
    cfg: Config,
    log: Logger,
    container: SandboxContainer,
    hostTokens: HostTokenSource,
    bridge: BridgeModel | null = null,
    /** How long one dispatcher run may take. */
    private readonly planTimeoutMs = 90_000,
    private readonly usage?: UsageLedger,
    private readonly auxiliaryStartTimeoutMs = 60_000,
  ) {
    this.#cfg = cfg;
    this.#log = log.child("sandbox-codex");
    this.#container = container;
    this.#hostTokens = hostTokens;
    this.#bridge = bridge;
  }

  get ready(): boolean {
    return this.#peer?.alive === true;
  }

  get account(): SandboxAccount | null {
    return this.#account;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#onNotification = handler;
  }

  onServerRequest(handler: (id: string, method: string, params: unknown) => void): void {
    this.#onServerRequest = handler;
  }

  onClosed(handler: (reason: string) => void): void {
    this.#onClosed = handler;
  }

  async start(): Promise<void> {
    if (this.#peer?.alive) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #doStart(): Promise<void> {
    const child = this.#container.spawnCodexAppServer([
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
      // The optional bridge provider is defined through command-line overrides,
      // so the sandbox config.toml is never rewritten. With no bridge key these
      // arguments are absent and the ChatGPT command line is unchanged.
      ...(this.#bridge?.providerConfigArgs() ?? []),
    ], this.#bridge?.providerEnv());
    const peer = new JsonRpcPeer(child, "sandbox-codex");
    peer.on("notification", (method, params) => this.#routeNotification(method, params));
    peer.on("warning", (message) => this.#log.warn("sandbox codex warning", { message }));
    peer.on("closed", (reason) => {
      this.#log.warn("sandbox codex app-server closed", { reason });
      if (this.#peer === peer) this.#peer = null;
      for (const [, resolve] of this.#pendingRequests) resolve({ decision: "cancel" });
      this.#pendingRequests.clear();
      this.#onClosed?.(reason);
    });

    // Server-initiated requests: approvals/input are surfaced to the UI; token
    // refresh is answered immediately from the host Codex.
    peer.onAnyServerRequest((method, params, id) => {
      if (method === "account/chatgptAuthTokens/refresh") {
        if (this.#cfg.memberRuntime || !this.#cfg.hostCodex.enabled) return Promise.reject(new Error("ChatGPT credentials are unavailable in this runtime"));
        return this.#refreshTokens(params as { previousAccountId?: string | null });
      }
      // A background title thread must never raise a UI approval: deny it here
      // rather than letting it be attributed to the active user conversation.
      // Tombstoned threads keep being denied so a late approval cannot leak either.
      const auxThreadId = (params as { threadId?: unknown } | undefined)?.threadId;
      if (typeof auxThreadId === "string" && this.#isAuxThread(auxThreadId)) {
        return Promise.resolve(denyForAuxThread(method));
      }
      const key = String(id);
      return new Promise((resolve) => {
        this.#pendingRequests.set(key, resolve);
        this.#onServerRequest?.(key, method, params);
      });
    });

    try {
      await peer.request(
        "initialize",
        {
          clientInfo: { name: "personal-agent", title: "Personal Agent", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
        this.#cfg.hostCodex.requestTimeoutMs,
      );
      peer.notify("initialized");

      if (this.#cfg.memberRuntime) {
        if (!this.#bridge?.enabled) throw new Error("Member model provider unavailable");
        this.#account = {type:"apiKey",email:null,planType:null};
      } else if (!this.#cfg.hostCodex.enabled) {
        // No ChatGPT login here: this Codex serves only the bridge provider, and
        // Claude Code turns run on their own credential.
        this.#account = { type: this.#bridge?.enabled ? "apiKey" : "none", email: null, planType: null };
      } else {
      const tokens = await this.#hostTokens.getTokens();
      await peer.request(
        "account/login/start",
        {
          type: "chatgptAuthTokens",
          accessToken: tokens.accessToken,
          chatgptAccountId: tokens.chatgptAccountId,
          chatgptPlanType: tokens.planType,
        },
        this.#cfg.hostCodex.requestTimeoutMs,
      );
      const account = (await peer.request("account/read", {}, 20_000)) as {
        account?: { type?: string; email?: string; planType?: string } | null;
      };
      this.#account = {
        type: account?.account?.type ?? "unknown",
        email: account?.account?.email ?? null,
        planType: account?.account?.planType ?? null,
      };
      }
    } catch (err) {
      // Never leave an orphan docker exec / codex process behind.
      this.#lastError = err instanceof Error ? err.message : String(err);
      peer.close();
      throw err;
    }
    this.#lastError = null;
    this.#peer = peer;
    this.#log.info("sandbox codex session ready", { account: this.#account.email, plan: this.#account.planType });
  }

  #isAuxThread(threadId: string): boolean {
    return this.#threadSubscribers.has(threadId) || this.#discardedThreads.has(threadId);
  }

  /**
   * Keep dropping notifications for an auxiliary thread whose run we stopped
   * waiting on. A `turn/completed` is the only proof the run is over, at which
   * point the tombstone is released; the set is bounded so a thread that never
   * completes cannot leak memory.
   */
  #discardThread(threadId: string): void {
    this.#discardedThreads.delete(threadId);
    this.#discardedThreads.set(threadId, true);
    while (this.#discardedThreads.size > SandboxCodexSession.MAX_DISCARDED_THREADS) {
      const oldest = this.#discardedThreads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#discardedThreads.delete(oldest);
    }
  }

  #routeNotification(method: string, params: unknown): void {
    // thread/started can arrive before thread/start's reply (even after timeout).
    // An ephemeral classifier is never a user conversation.
    if (method === "thread/started" && (params as { thread?: { ephemeral?: boolean } })?.thread?.ephemeral) return;
    // Observe before auxiliary routing: dispatch/title calls also consume tokens.
    if (method === 'thread/tokenUsage/updated') {
      try { this.usage?.codex(params); } catch { this.#log.error('token usage persistence failed'); }
    }
    const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof threadId === "string") {
      const subscribers = this.#threadSubscribers.get(threadId);
      if (subscribers) {
        for (const subscriber of subscribers) {
          try {
            subscriber(method, params);
          } catch (err) {
            this.#log.warn("aux thread notification handler failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return;
      }
      if (this.#discardedThreads.has(threadId)) {
        // Still dropped; once the turn truly ends the tombstone can be released.
        if (method === "turn/completed") this.#discardedThreads.delete(threadId);
        return;
      }
    }
    this.#onNotification?.(method, params);
  }

  /**
   * Run one throwaway, tool-free turn and return the assistant text.
   *
   * The thread is `ephemeral` (never persisted), `read-only` and `never`
   * approval, on a dedicated model, so it cannot touch the sandbox or the user's
   * conversation. Text is captured from live notifications because ephemeral
   * threads cannot be re-read afterwards (`thread/read` rejects `includeTurns`).
   */
  /** Read-only main-agent planning; receives bounded metadata, never executes a task. */
  async planTask(prompt: string, developerInstructions?: string, model?: string, onTiming?: DispatchTimingSink): Promise<string | null> {
    const started = Date.now();
    // Dispatch is one short JSON answer: low effort on Luna and on a member's GPT
    // (the member gateway lets a request ask for less than high, never more).
    // Other dispatch models keep high.
    const effort = (!model && this.#cfg.agent.titleModel === "gpt-6-luna") || model === MEMBER_GPT_MODEL ? "low" : "high";
    onTiming?.({ model: model ?? this.#cfg.agent.titleModel, effort, attempts: 1 });
    let result;
    try {
      try {
        result = await this.#auxiliaryText(prompt, effort, this.planTimeoutMs, developerInstructions, model, onTiming);
      } catch (err) {
        // Only thread creation is safe to repeat: no turn has been sent. Never
        // replay turn/start or task execution after unknown delivery.
        if (!(err instanceof JsonRpcTimeoutError) || err.method !== "thread/start") throw err;
        this.#log.warn("dispatcher thread creation timed out; retrying once");
        onTiming?.({ attempts: 2 });
        result = await this.#auxiliaryText(prompt, effort, this.planTimeoutMs, developerInstructions, model, onTiming);
      }
    } finally {
      onTiming?.({ classifierMs: Date.now() - started });
    }
    const { text, error } = result;
    // A reported reason (such as an exhausted usage limit) is shown on the task
    // instead of a generic "try again".
    if (error) throw new Error(`任务分配失败：${error}`);
    return text;
  }

  async #auxiliaryText(prompt: string, effort: string | null, timeoutMs: number, developerInstructions?: string, requestedModel?: string, onTiming?: DispatchTimingSink): Promise<{ text: string | null; error: string | null }> {
    const connectionStarted = Date.now();
    await this.start();
    onTiming?.({ connectionMs: Date.now() - connectionStarted });
    const peer = this.#peer;
    if (!peer?.alive) return { text: null, error: null };
    const model = requestedModel ?? this.#cfg.agent.titleModel;
    if (requestedModel && (this.#bridge?.providerForModel(model) ?? "openai") === "openai") throw new Error("服务暂时不可用，请稍后重试");
    const modelProvider = requestedModel ? this.#bridge!.providerForModel(model) : undefined;
    const threadStarted = Date.now();
    const threadRes = (await peer.request(
      "thread/start",
      {
        ...(developerInstructions !== undefined ? {developerInstructions} : {}),
        ...(modelProvider ? { modelProvider } : {}),
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        model,
        cwd: this.#cfg.sandbox.containerWorkspaceDir,
        // Dispatch needs only supplied metadata. Do not initialize the legacy
        // shared browser MCP or load unrelated CLI memories during thread/start.
        config: { features: { memories: false }, mcp_servers: {
          aio_browser: { enabled: false, url: "http://127.0.0.1:8080/mcp" },
        } },
      },
      this.auxiliaryStartTimeoutMs,
    )) as { thread: { id: string } };
    onTiming?.({ threadStartMs: Date.now() - threadStarted });
    const threadId = threadRes.thread.id;

    const deltas: string[] = [];
    let finalText = "";
    let firstTextAt: number | null = null;
    let turnSubmittedAt: number | null = null;
    // Only a real `turn/completed {status:"completed"}` may produce a title.
    let turnStatus: string | null = null;
    let failure: string | null = null;
    let timedOut = false;
    let startFailed = false;
    let startError: unknown = null;
    let turnId: string | null = null;
    let settled = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveDone();
    };
    const listener = (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === "item/agentMessage/delta" && typeof p.delta === "string") {
        if (firstTextAt === null) {
          firstTextAt = Date.now();
          if (turnSubmittedAt !== null) onTiming?.({ firstTextMs: firstTextAt - turnSubmittedAt });
        }
        deltas.push(p.delta);
        return;
      }
      if (method === "item/completed") {
        const item = p.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") finalText = item.text;
        return;
      }
      if (method === "turn/completed") {
        if (firstTextAt !== null) onTiming?.({ finishMs: Date.now() - firstTextAt });
        const turn = p.turn as { status?: string; items?: Array<{ type?: string; text?: string }>; error?: { message?: unknown } | null } | undefined;
        turnStatus = typeof turn?.status === "string" ? turn.status : "unknown";
        if (typeof turn?.error?.message === "string" && turn.error.message) failure = turn.error.message;
        const message = (turn?.items ?? []).find((it) => it?.type === "agentMessage" && typeof it.text === "string");
        if (message?.text) finalText = message.text;
        settle();
      }
    };
    this.#threadSubscribers.set(threadId, new Set([listener]));
    const timer = setTimeout(() => {
      timedOut = true;
      settle();
    }, timeoutMs);
    timer.unref?.();
    // The start promise always settles the wait (success, failure or timeout) so
    // this method never outlives its configured budget waiting on the turn.
    turnSubmittedAt = Date.now();
    const startPromise = (peer.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        model,
        ...(effort ? { effort } : {}),
      },
      60_000,
    ) as Promise<{ turn?: { id?: string } }>).then(
      (res) => {
        onTiming?.({ turnStartMs: Date.now() - turnSubmittedAt! });
        turnId = res?.turn?.id ?? null;
      },
      (err) => {
        startFailed = true;
        startError = err;
        settle();
      },
    );
    try {
      await done;
    } finally {
      clearTimeout(timer);
      this.#threadSubscribers.delete(threadId);
    }
    if (turnStatus === null) {
      // No completion notification: the run may still be going on the server, so
      // keep dropping its events instead of letting a late delta reach the main
      // conversation (the delta buffer is keyed by active conversation, not thread).
      this.#discardThread(threadId);
      if (startFailed) {
        this.#log.warn("title turn failed", { error: startError instanceof Error ? startError.message : String(startError) });
      } else if (timedOut) {
        // Best effort: ask the server to stop so the tombstone is released soon.
        await this.#interruptAuxTurn(threadId, startPromise, () => turnId);
      }
    }
    if (turnStatus !== "completed") return { text: null, error: failure };
    return { text: finalText || deltas.join("") || null, error: null };
  }

  /** Stop a timed-out auxiliary turn without ever blocking on a dead session. */
  async #interruptAuxTurn(threadId: string, startPromise: Promise<void>, turnId: () => string | null): Promise<void> {
    const peer = this.#peer;
    if (!peer?.alive) return;
    // The turn id may not have arrived yet; give it a short bounded window.
    await Promise.race([
      startPromise,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        t.unref?.();
      }),
    ]);
    const id = turnId();
    if (!id || !this.#peer?.alive) return;
    try {
      // Best effort and short: the tombstone already blocks late events, so never
      // let a slow interrupt delay the next title task for long.
      await this.#peer.request("turn/interrupt", { threadId, turnId: id }, 5_000);
    } catch (err) {
      this.#log.warn("title interrupt failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async #refreshTokens(params: { previousAccountId?: string | null }): Promise<unknown> {
    this.#log.info("sandbox requested chatgpt token refresh", { previousAccountId: params?.previousAccountId ?? null });
    const tokens = await this.#hostTokens.getTokens({ force: true });
    return {
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.planType,
    };
  }

  async listModels(): Promise<CodexModel[]> {
    await this.start();
    const res = (await this.#peer!.request("model/list", {}, 20_000)) as {
      data?: Array<{
        id: string;
        model: string;
        displayName: string;
        description: string;
        isDefault: boolean;
        supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
        defaultReasoningEffort?: string | null;
        inputModalities?: string[];
      }>;
    };
    return (res.data ?? []).map((m) => ({
      id: m.id,
      model: m.model,
      displayName: m.displayName,
      description: m.description,
      isDefault: m.isDefault,
      supportedReasoningEfforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
      defaultReasoningEffort: m.defaultReasoningEffort ?? null,
      inputModalities: m.inputModalities ?? ["text"],
    }));
  }

  /** An execution thread (one with a task identity) gets its tab tools, the decision and schedule tools and the knowledge base. */
  #executionConfig(task: BrowserTask | undefined): { config?: Record<string, unknown> } {
    if (!task) return {};
    const tabs = tabThreadConfig(task) as { mcp_servers: Record<string, unknown> };
    return { config: { ...tabs, mcp_servers: { ...tabs.mcp_servers, ...decisionThreadServers(this.#cfg), ...scheduleThreadServers(this.#cfg), ...imageThreadServers(this.#cfg), ...kbThreadServers(this.#cfg) } } };
  }

  async startThread(
    opts: { cwd?: string; model?: string; modelProvider?: string; developerInstructions?: string; browserTask?: BrowserTask } = {},
  ): Promise<{ threadId: string; model: string; cwd: string; modelProvider: string | null }> {
    await this.start();
    const res = (await this.#peer!.request(
      "thread/start",
      {
        ...this.#executionConfig(opts.browserTask),
        cwd: opts.cwd ?? this.#cfg.sandbox.containerWorkspaceDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.modelProvider ? { modelProvider: opts.modelProvider } : {}),
        ...(opts.developerInstructions !== undefined ? {developerInstructions: opts.developerInstructions} : {}),
      },
      60_000,
    )) as { thread: { id: string }; model: string; cwd: string; modelProvider?: string | null };
    return { threadId: res.thread.id, model: res.model, cwd: res.cwd, modelProvider: res.modelProvider ?? null };
  }

  /**
   * Fork a thread onto another provider, keeping its history.
   *
   * Codex only honours `modelProvider` at thread creation, so an existing
   * conversation that switches providers must continue on a fork. A turn on the
   * same provider keeps using `resumeThread` and never forks.
   */
  async forkThread(
    threadId: string,
    opts: { model?: string; modelProvider?: string; cwd?: string; developerInstructions?: string; browserTask?: BrowserTask } = {},
  ): Promise<{ threadId: string; model: string; cwd: string; modelProvider: string | null }> {
    await this.start();
    const res = (await this.#peer!.request(
      "thread/fork",
      {
        threadId,
        ...this.#executionConfig(opts.browserTask),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.modelProvider ? { modelProvider: opts.modelProvider } : {}),
        ...(opts.developerInstructions !== undefined ? {developerInstructions: opts.developerInstructions} : {}),
      },
      60_000,
    )) as { thread: { id: string }; model: string; cwd: string; modelProvider?: string | null };
    return { threadId: res.thread.id, model: res.model, cwd: res.cwd, modelProvider: res.modelProvider ?? null };
  }

  async resumeThread(threadId: string, developerInstructions?: string, browserTask?: BrowserTask): Promise<void> {
    await this.start();
    await this.#peer!.request("thread/resume", { threadId, approvalPolicy: "never", sandbox: "danger-full-access", ...(developerInstructions !== undefined ? {developerInstructions} : {}), ...this.#executionConfig(browserTask) }, 60_000);
  }

  async startTurn(params: {
    threadId: string;
    text: string;
    attachments?: Array<{ path: string; kind: "image" | "file"; name?: string }>;
    model?: string | null;
    effort?: string | null;
    cwd?: string | null;
    clientUserMessageId?: string | null;
    summary?: "none" | "auto" | "concise" | "detailed" | null;
  }): Promise<string> {
    await this.start();
    const files = (params.attachments ?? []).filter((a) => a.kind === "file");
    const text = files.length
      ? `${params.text}${params.text ? "\n\n" : ""}附件已上传到沙箱，可直接读取：\n${files.map((f) => `- ${f.path}`).join("\n")}`
      : params.text;
    const input: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const image of (params.attachments ?? []).filter((a) => a.kind === "image")) {
      input.push({ type: "localImage", path: image.path });
    }
    const res = (await this.#peer!.request(
      "turn/start",
      {
        threadId: params.threadId,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        input,
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.clientUserMessageId ? { clientUserMessageId: params.clientUserMessageId } : {}),
        // Only opt into summaries when asked; never send raw chain-of-thought.
        ...(params.summary && params.summary !== "none" ? { summary: params.summary } : {}),
      },
      60_000,
    )) as { turn: { id: string } };
    return res.turn.id;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    if (!this.#peer?.alive) return;
    await this.#peer.request("turn/interrupt", { threadId, turnId }, 30_000);
  }

  async steerTurn(params: { threadId: string; expectedTurnId: string; text: string; attachments?: Array<{path:string;kind:"image"|"file";name?:string}> }): Promise<void> {
    if (!this.#peer?.alive) throw new Error("Codex connection is unavailable");
    const files = (params.attachments ?? []).filter(a => a.kind === "file");
    const text = params.text + (files.length ? `\n附件已上传到沙箱：\n${files.map(a => a.path).join("\n")}` : "");
    const input: Array<Record<string, unknown>> = [{type:"text",text}];
    for (const a of params.attachments ?? []) if (a.kind === "image") input.push({type:"localImage",path:a.path});
    const result = await this.#peer.request("turn/steer", {threadId:params.threadId,expectedTurnId:params.expectedTurnId,input},30_000) as {turnId:string};
    if (result.turnId !== params.expectedTurnId) throw new Error("Steering acknowledgement did not match the requested turn");
  }

  async readThread(threadId: string): Promise<unknown> {
    await this.start();
    return await this.#peer!.request("thread/read", { threadId, includeTurns: true }, 60_000);
  }

  /** Answer a held server request (approval / user input). */
  answer(id: string, result: unknown): boolean {
    const resolve = this.#pendingRequests.get(id);
    if (!resolve) return false;
    this.#pendingRequests.delete(id);
    resolve(result);
    return true;
  }

  hasPending(id: string): boolean {
    return this.#pendingRequests.has(id);
  }

  cancelAllPending(): void {
    for (const [id, resolve] of this.#pendingRequests) {
      this.#pendingRequests.delete(id);
      resolve({ decision: "cancel" });
    }
  }

  close(): void {
    this.cancelAllPending();
    for (const subscribers of this.#threadSubscribers.values()) subscribers.clear();
    this.#threadSubscribers.clear();
    this.#discardedThreads.clear();
    this.#peer?.close();
    this.#peer = null;
    this.#account = null;
  }
}

/** Safe refusal for any approval raised by an auxiliary title thread. */
function denyForAuxThread(method: string): unknown {
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "applyPatchApproval" || method === "execCommandApproval") return { decision: "denied" };
  return { decision: "decline" };
}
