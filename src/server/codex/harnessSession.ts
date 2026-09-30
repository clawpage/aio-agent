import { CLAUDE_CODE_PROVIDER_ID, isClaudeThread } from "../claudeCode.js";
import type { CodexSessionLike, TurnAttachment } from "./manager.js";
import type { ClaudeCodeSession } from "./claudeSession.js";
import type { BrowserTask } from "../browser/tabs.js";

/**
 * One session surface over two harnesses.
 *
 * Codex stays the platform session (readiness, account, approvals, model
 * catalog). Task threads created with the Claude Code provider run on Claude
 * Code, and every later call for such a thread is routed by its id, which
 * survives restarts. While the owner has Claude Code selected, the dispatcher
 * and titles run there as well. An explicit model (the member policy) decides
 * the dispatcher's harness by that model.
 */
export class HarnessSession implements CodexSessionLike {
  #codex: CodexSessionLike;
  #claude: ClaudeCodeSession;
  #claudeSelected: () => boolean;

  /**
   * `claudeSelected` reports whether the owner currently picked Claude Code; the
   * main-session dispatcher and titles then run on it too, not only task turns.
   */
  constructor(codex: CodexSessionLike, claude: ClaudeCodeSession, claudeSelected: () => boolean) {
    this.#codex = codex;
    this.#claude = claude;
    this.#claudeSelected = claudeSelected;
  }

  get ready() {
    return this.#codex.ready;
  }
  get account() {
    return this.#codex.account;
  }
  get lastError() {
    return this.#codex.lastError;
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#codex.onNotification(handler);
    this.#claude.onNotification(handler);
  }
  onServerRequest(handler: (id: string, method: string, params: unknown) => void): void {
    this.#codex.onServerRequest(handler);
  }
  /** Only the Codex app-server is a long-lived connection whose loss affects every turn. */
  onClosed(handler: (reason: string) => void): void {
    this.#codex.onClosed(handler);
  }
  start() {
    return this.#codex.start();
  }
  listModels() {
    return this.#codex.listModels();
  }

  startThread(opts: Parameters<CodexSessionLike["startThread"]>[0]) {
    return opts.modelProvider === CLAUDE_CODE_PROVIDER_ID ? this.#claude.startThread(opts) : this.#codex.startThread(opts);
  }
  forkThread(threadId: string, opts: Parameters<CodexSessionLike["forkThread"]>[1]) {
    if (isClaudeThread(threadId) || opts.modelProvider === CLAUDE_CODE_PROVIDER_ID) {
      return Promise.reject(new Error("Codex 与 Claude Code 会话不能互相派生"));
    }
    return this.#codex.forkThread(threadId, opts);
  }
  resumeThread(threadId: string, developerInstructions?: string, browserTask?: BrowserTask) {
    return isClaudeThread(threadId)
      ? this.#claude.resumeThread(threadId, developerInstructions, browserTask)
      : this.#codex.resumeThread(threadId, developerInstructions, browserTask);
  }
  startTurn(params: Parameters<CodexSessionLike["startTurn"]>[0]) {
    return isClaudeThread(params.threadId) ? this.#claude.startTurn(params) : this.#codex.startTurn(params);
  }
  interrupt(threadId: string, turnId: string) {
    return isClaudeThread(threadId) ? this.#claude.interrupt(threadId, turnId) : this.#codex.interrupt(threadId, turnId);
  }
  steerTurn(params: { threadId: string; expectedTurnId: string; text: string; attachments?: TurnAttachment[] }) {
    if (isClaudeThread(params.threadId)) return this.#claude.steerTurn(params);
    if (!this.#codex.steerTurn) return Promise.reject(new Error("当前执行器不支持运行中补充"));
    return this.#codex.steerTurn(params);
  }
  generateTitle(userText: string) {
    return this.#claudeSelected() ? this.#claude.generateTitle(userText) : this.#codex.generateTitle(userText);
  }
  planTask(prompt: string, developerInstructions?: string, model?: string) {
    if (model ? this.#claude.owns(model) : this.#claudeSelected()) return this.#claude.planTask(prompt, developerInstructions);
    if (!this.#codex.planTask) return Promise.resolve(null);
    return this.#codex.planTask(prompt, developerInstructions, model);
  }
  answer(id: string, result: unknown) {
    return this.#codex.answer(id, result);
  }
  close() {
    this.#claude.close();
    this.#codex.close();
  }
}
