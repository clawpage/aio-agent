import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SandboxContainer } from "../docker/sandbox.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import type { HostTokenSource } from "./hostTokens.js";

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
  #peer: JsonRpcPeer | null = null;
  #starting: Promise<void> | null = null;
  #pendingRequests = new Map<string, ServerRequestResolver>();
  #onNotification: ((method: string, params: unknown) => void) | null = null;
  #onServerRequest: ((id: string, method: string, params: unknown) => void) | null = null;
  #onClosed: ((reason: string) => void) | null = null;
  #account: SandboxAccount | null = null;
  #lastError: string | null = null;

  constructor(cfg: Config, log: Logger, container: SandboxContainer, hostTokens: HostTokenSource) {
    this.#cfg = cfg;
    this.#log = log.child("sandbox-codex");
    this.#container = container;
    this.#hostTokens = hostTokens;
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
      'approval_policy="on-request"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ]);
    const peer = new JsonRpcPeer(child, "sandbox-codex");
    peer.on("notification", (method, params) => this.#onNotification?.(method, params));
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
        return this.#refreshTokens(params as { previousAccountId?: string | null });
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

  async startThread(opts: { cwd?: string; model?: string } = {}): Promise<{ threadId: string; model: string; cwd: string }> {
    await this.start();
    const res = (await this.#peer!.request(
      "thread/start",
      {
        cwd: opts.cwd ?? this.#cfg.sandbox.containerWorkspaceDir,
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        ...(opts.model ? { model: opts.model } : {}),
      },
      60_000,
    )) as { thread: { id: string }; model: string; cwd: string };
    return { threadId: res.thread.id, model: res.model, cwd: res.cwd };
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.start();
    await this.#peer!.request("thread/resume", { threadId }, 60_000);
  }

  async startTurn(params: {
    threadId: string;
    text: string;
    attachments?: Array<{ path: string; kind: "image" | "file"; name?: string }>;
    model?: string | null;
    effort?: string | null;
    cwd?: string | null;
    clientUserMessageId?: string | null;
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
        input,
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.clientUserMessageId ? { clientUserMessageId: params.clientUserMessageId } : {}),
      },
      60_000,
    )) as { turn: { id: string } };
    return res.turn.id;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    if (!this.#peer?.alive) return;
    await this.#peer.request("turn/interrupt", { threadId, turnId }, 30_000);
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
    this.#peer?.close();
    this.#peer = null;
    this.#account = null;
  }
}
