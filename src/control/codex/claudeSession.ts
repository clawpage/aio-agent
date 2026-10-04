import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import type { SandboxContainer } from "../sandbox/container.js";
import { CLAUDE_CODE_PROVIDER_ID, CLAUDE_THREAD_PREFIX, type ClaudeCodeHarness } from "../claudeCode.js";
import type { TurnAttachment } from "./manager.js";
import type { DispatchTimingSink } from "./dispatchTiming.js";
import { ClaudeStreamTranslator } from "./claudeTranslator.js";
import { tabMcpServers, type BrowserTask } from "../browser/tabs.js";
import { decisionMcpServers } from "../decision.js";
import { kbMcpServers } from "../kb.js";
import { scheduleMcpServers } from "../scheduleTool.js";
import { imageMcpServers } from "../imageTool.js";
import { JsonRpcResponseError } from "./jsonrpc.js";

/** A definite refusal: the addition was never consumed (the task service treats it as not delivered). */
function notDelivered(): Error {
  return new JsonRpcResponseError("turn/steer", -32000, "轮次已结束，补充未送达");
}

/**
 * Browser tools for a turn: the task's own tabs when it has a task identity,
 * otherwise the legacy single-page endpoint the sandbox Codex is limited to.
 */
function mcpConfig(browserTask: BrowserTask | undefined, cfg: Config): string {
  return JSON.stringify({ mcpServers: browserTask ? { ...tabMcpServers(browserTask), ...decisionMcpServers(cfg), ...scheduleMcpServers(cfg), ...imageMcpServers(cfg), ...kbMcpServers(cfg) } : { aio_browser: { type: "http", url: "http://127.0.0.1:8080/mcp" } } });
}

/**
 * The CLI's own timers live and die with its session (one `-p` run): an agent that saw
 * them told people schedules end with the conversation. The account's schedules are
 * aio_schedule's.
 */
export const SESSION_TIMER_TOOLS = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"];

/** How long a mid-turn addition may wait for the CLI to echo it as consumed. */
const STEER_ACK_TIMEOUT_MS = 30_000;
/** After an interrupt request, how long before the process is killed outright. */
const INTERRUPT_KILL_MS = 15_000;
/** After the result, how long a still-unconsumed addition may keep the process open. */
const PENDING_STEER_GRACE_MS = 10_000;

type Json = Record<string, unknown>;

interface Run {
  resumed: boolean;
  threadId: string;
  sessionId: string;
  turnId: string;
  child: ChildProcess;
  translator: ClaudeStreamTranslator;
  interruptRequested: boolean;
  /** The first replayed user message is the turn's own prompt. */
  promptAcked: boolean;
  pendingSteers: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
  result: Json | null;
  stderrTail: string;
  finished: boolean;
}

function userMessage(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/** Attachments are sandbox paths; the CLI reads files and images itself. */
export function withAttachments(text: string, attachments: TurnAttachment[] = []): string {
  if (!attachments.length) return text;
  const lines = attachments.map((a) => `- ${a.path}${a.kind === "image" ? "（图片）" : ""}${a.name ? `（${a.name}）` : ""}`);
  return `${text}\n\n附件（沙箱内路径）：\n${lines.join("\n")}`;
}

function resultMessage(result: Json | null, stderrTail: string): string {
  const text = typeof result?.result === "string" ? result.result.trim() : "";
  const errors = Array.isArray(result?.errors) ? (result!.errors as unknown[]).filter((e) => typeof e === "string").join("；") : "";
  return text || errors || stderrTail.trim().split("\n").slice(-3).join(" ") || "Claude Code 执行失败";
}

/**
 * Task turns on the Claude Code harness.
 *
 * Each turn is one `claude -p` process in the sandbox speaking stream-json:
 * the control plane chooses the session UUID (`--session-id` on the first
 * turn, `--resume` afterwards, decided by whether the CLI has written the
 * session file), so a conversation keeps its full context across turns and
 * across control-plane restarts. A process that dies without a result is an
 * `unknown` outcome for that turn only; other turns and the Codex session are
 * untouched.
 */
export class ClaudeCodeSession {
  #cfg: Config;
  #log: Logger;
  #container: SandboxContainer;
  #harness: ClaudeCodeHarness;
  #runs = new Map<string, Run>();
  #instructions = new Map<string, string>();
  #browserTasks = new Map<string, BrowserTask>();
  #onNotification: ((method: string, params: unknown) => void) | null = null;
  #installing: Promise<void> | null = null;

  constructor(cfg: Config, log: Logger, container: SandboxContainer, harness: ClaudeCodeHarness, private readonly usage?: import('../usage.js').UsageLedger) {
    this.#cfg = cfg;
    this.#log = log.child("claude-code-session");
    this.#container = container;
    this.#harness = harness;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#onNotification = handler;
  }

  /** Whether `model` runs on this harness. */
  owns(model: string): boolean {
    return this.#harness.owns(model);
  }

  #emit(method: string, params: Record<string, unknown>): void {
    this.#onNotification?.(method, params);
  }

  #ensureCli(): Promise<void> {
    this.#installing ??= this.#container.ensureClaudeCli().catch((err) => {
      this.#installing = null;
      throw err;
    });
    return this.#installing;
  }

  async startThread(opts: { model?: string; developerInstructions?: string; browserTask?: BrowserTask }): Promise<{ threadId: string; model: string; cwd: string; modelProvider: string }> {
    if (!this.#harness.enabled) throw new Error("Claude Code 执行器未启用");
    const threadId = `${CLAUDE_THREAD_PREFIX}${randomUUID()}`;
    if (opts.developerInstructions !== undefined) this.#instructions.set(threadId, opts.developerInstructions);
    if (opts.browserTask) this.#browserTasks.set(threadId, opts.browserTask);
    return { threadId, model: opts.model ?? "", cwd: this.#cfg.sandbox.containerWorkspaceDir, modelProvider: CLAUDE_CODE_PROVIDER_ID };
  }

  async resumeThread(threadId: string, developerInstructions?: string, browserTask?: BrowserTask): Promise<void> {
    if (developerInstructions !== undefined) this.#instructions.set(threadId, developerInstructions);
    if (browserTask) this.#browserTasks.set(threadId, browserTask);
  }

  async startTurn(params: { threadId: string; text: string; attachments?: TurnAttachment[]; model?: string | null; effort?: string | null }): Promise<string> {
    const { threadId } = params;
    if (!this.#harness.enabled) throw new Error("Claude Code 执行器未启用");
    if (this.#runs.has(threadId)) throw new Error("该会话已有执行中的轮次");
    await this.#ensureCli();
    const sessionId = threadId.slice(CLAUDE_THREAD_PREFIX.length);
    const resume = await this.#container.claudeSessionExists(sessionId);
    const soul = this.#instructions.get(threadId)?.trim();
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      // Full access inside the container, like Codex's approval_policy=never.
      "--permission-mode", "bypassPermissions",
      "--strict-mcp-config", "--mcp-config", mcpConfig(this.#browserTasks.get(threadId), this.#cfg),
      // One `=` argument: the flag is variadic and would swallow what follows.
      `--disallowedTools=${SESSION_TIMER_TOOLS.join(",")}`,
      "--setting-sources", "user,project",
      resume ? "--resume" : "--session-id", sessionId,
      ...(params.model ? ["--model", params.model] : []),
      ...(params.effort ? ["--effort", params.effort] : []),
      ...(soul ? ["--append-system-prompt", soul] : []),
    ];
    const turnId = `cturn_${randomUUID()}`;
    const child = this.#container.spawnClaude(args, this.#harness.credentialEnv());
    const run: Run = {
      resumed: resume,
      threadId,
      sessionId,
      turnId,
      child,
      translator: new ClaudeStreamTranslator(threadId, turnId, this.#cfg.sandbox.containerWorkspaceDir, (m, p) => this.#emit(m, p)),
      interruptRequested: false,
      promptAcked: false,
      pendingSteers: [],
      result: null,
      stderrTail: "",
      finished: false,
    };
    this.#runs.set(threadId, run);

    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: Json;
        try {
          event = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        this.#onEvent(run, event);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      run.stderrTail = (run.stderrTail + chunk).slice(-4096);
    });
    child.stdin?.on("error", () => undefined);
    child.on("error", (err) => {
      run.stderrTail += `\n${err.message}`;
      this.#finish(run);
    });
    child.on("close", () => this.#finish(run));

    this.#emit("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    child.stdin?.write(userMessage(withAttachments(params.text, params.attachments)));
    return turnId;
  }

  #onEvent(run: Run, event: Json): void {
    if (event.type === "user" && event.isReplay && !event.parent_tool_use_id) {
      if (!run.promptAcked) run.promptAcked = true;
      else {
        const steer = run.pendingSteers.shift();
        if (steer) {
          clearTimeout(steer.timer);
          steer.resolve();
        }
      }
      return;
    }
    if (event.type === "result") {
      try { this.usage?.claude(event, run.sessionId, run.resumed); } catch { this.#log.error('token usage persistence failed'); }
      run.result = event;
      if (run.pendingSteers.length === 0) {
        run.child.stdin?.end();
        return;
      }
      // An addition written just before the result is still queued in the CLI,
      // which answers it as a continuation of this same turn. Keep reading until
      // it is consumed; give up only if it never is.
      const grace = setTimeout(() => {
        for (const steer of run.pendingSteers.splice(0)) {
          clearTimeout(steer.timer);
          steer.reject(notDelivered());
        }
        run.child.stdin?.end();
      }, PENDING_STEER_GRACE_MS);
      grace.unref?.();
      return;
    }
    run.translator.handle(event);
  }

  #finish(run: Run): void {
    if (run.finished) return;
    run.finished = true;
    if (this.#runs.get(run.threadId) === run) this.#runs.delete(run.threadId);
    for (const steer of run.pendingSteers.splice(0)) {
      clearTimeout(steer.timer);
      steer.reject(notDelivered());
    }
    run.translator.settleOpenTools();
    const result = run.result;
    let status: string;
    if (run.interruptRequested && (!result || result.is_error)) status = "interrupted";
    else if (!result) status = "unknown";
    else status = result.is_error ? "failed" : "completed";
    if (status === "failed") {
      const message = resultMessage(result, run.stderrTail);
      this.#log.warn("claude code turn failed", { turnId: run.turnId, message });
      this.#emit("error", { threadId: run.threadId, turnId: run.turnId, message });
      this.#emit("turn/completed", { threadId: run.threadId, turn: { id: run.turnId, status, error: { message } } });
      return;
    }
    if (status === "unknown") this.#log.warn("claude code process ended without a result", { turnId: run.turnId, stderr: run.stderrTail.slice(-500) });
    this.#emit("turn/completed", { threadId: run.threadId, turn: { id: run.turnId, status } });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const run = this.#runs.get(threadId);
    if (!run || run.turnId !== turnId) return;
    run.interruptRequested = true;
    run.child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: `int_${randomUUID()}`, request: { subtype: "interrupt" } })}\n`);
    const timer = setTimeout(() => {
      if (run.finished) return;
      this.#log.warn("claude code did not stop after interrupt; killing it", { turnId });
      void this.#container.killClaudeSession(run.sessionId).finally(() => run.child.kill());
    }, INTERRUPT_KILL_MS);
    timer.unref?.();
  }

  async steerTurn(params: { threadId: string; expectedTurnId: string; text: string; attachments?: TurnAttachment[] }): Promise<void> {
    const run = this.#runs.get(params.threadId);
    const stdinClosed = run?.result && run.pendingSteers.length === 0;
    if (!run || run.turnId !== params.expectedTurnId || run.finished || run.interruptRequested || stdinClosed) {
      throw notDelivered();
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = run.pendingSteers.findIndex((s) => s.timer === timer);
        if (index >= 0) run.pendingSteers.splice(index, 1);
        // Written but never echoed: it may still be consumed, so this is not a
        // clean refusal; the caller records the outcome as unknown.
        reject(new Error("补充已写入但未确认送达"));
      }, STEER_ACK_TIMEOUT_MS);
      timer.unref?.();
      run.pendingSteers.push({ resolve, reject, timer });
      run.child.stdin?.write(userMessage(withAttachments(params.text, params.attachments)));
    });
  }

  /**
   * The main-session dispatcher on Claude Code: one tool-less, non-persisted
   * run that only classifies, like the Codex read-only ephemeral thread.
   */
  async planTask(prompt: string, developerInstructions?: string, onTiming?: DispatchTimingSink): Promise<string | null> {
    const started = Date.now();
    onTiming?.({ model: this.#cfg.claudeCode.auxModel, effort: "high", attempts: 1 });
    try { return await this.#oneShot(prompt, "high", 90_000, developerInstructions); }
    finally { onTiming?.({ classifierMs: Date.now() - started }); }
  }

  async #oneShot(prompt: string, effort: string, timeoutMs: number, developerInstructions?: string): Promise<string | null> {
    if (!this.#harness.enabled) return null;
    await this.#ensureCli();
    const sessionId = randomUUID();
    const soul = developerInstructions?.trim();
    const child = this.#container.spawnClaude(
      [
        "-p", "--output-format", "json",
        "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "",
        "--session-id", sessionId,
        "--model", this.#cfg.claudeCode.auxModel, "--effort", effort,
        ...(soul ? ["--append-system-prompt", soul] : []),
      ],
      this.#harness.credentialEnv(),
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2048)));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(prompt);
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      child.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!closed) {
      this.#log.warn("claude code auxiliary run timed out", { timeoutMs });
      void this.#container.killClaudeSession(sessionId).finally(() => child.kill());
      return null;
    }
    try {
      const result = JSON.parse(stdout) as Json;
      try { this.usage?.claude(result, sessionId, false); } catch { this.#log.error('token usage persistence failed'); }
      if (result.is_error || typeof result.result !== "string") {
        this.#log.warn("claude code auxiliary run failed", { message: resultMessage(result, stderr) });
        return null;
      }
      return result.result;
    } catch {
      this.#log.warn("claude code auxiliary run returned no result", { stderr: stderr.slice(-300) });
      return null;
    }
  }

  /** Stop every running turn (control-plane shutdown). */
  close(): void {
    for (const run of this.#runs.values()) {
      run.interruptRequested = true;
      run.child.kill();
    }
  }
}
