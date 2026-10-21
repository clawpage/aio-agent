import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";
import type { HostTokenSource } from "./codex/hostTokens.js";
import type { ClaudeCodeHarness } from "./claudeCode.js";
import { getUser } from "./auth/owner.js";
import { MEMBER_EFFORT, MEMBER_EFFORTS, MEMBER_GPT_MODEL, MEMBER_MODEL, MEMBER_MODELS } from "./auth/policy.js";
import { readAgentSettings } from "./settings.js";
import { UsageLedger } from "./usage.js";

/**
 * Clawpages' AI answers: a page asks on behalf of the visitor signed in to it, and the
 * answer comes from that visitor's own account: the model it runs on (a member's assigned
 * model, at most at its assigned effort; the owner's chosen model), counted in that
 * account's usage. Text in, text out: no tools, no sandbox, nothing of the account's
 * memory, files or history, so a page can never steer someone's agent into acting for
 * them. The request is made here on the host with the credentials the member gateway
 * adds (the control plane's ChatGPT login, the owner's Claude credential).
 */

/** The CLI's subscription credential needs this beta on the Messages API. */
const OAUTH_BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 8192;
export const AI_EFFORTS = ["low", "medium", "high"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export interface AiMessage { role: "user" | "assistant"; content: string }
export interface AiRequest { system: string; messages: AiMessage[]; effort: AiEffort }
export interface AiAnswer { text: string; model: string }

export class AiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** The model an account answers with and the most effort it may spend (null: as asked). */
interface AccountModel { claude: boolean; model: string; maxEffort: AiEffort | null }

export class ClawpageAi {
  #cfg: Config;
  #log: Logger;
  #db: Db;
  #hostTokens: Pick<HostTokenSource, "getTokens" | "invalidate">;
  #claude: Pick<ClaudeCodeHarness, "status" | "owns"> | null;
  #usageDb: (userId: string) => Promise<Db>;

  constructor(opts: {
    cfg: Config; log: Logger; db: Db;
    hostTokens: Pick<HostTokenSource, "getTokens" | "invalidate">;
    claude: Pick<ClaudeCodeHarness, "status" | "owns"> | null;
    /** The database an account's token usage is kept in. */
    usageDb: (userId: string) => Promise<Db>;
  }) {
    this.#cfg = opts.cfg;
    this.#log = opts.log.child("clawpage-ai");
    this.#db = opts.db;
    this.#hostTokens = opts.hostTokens;
    this.#claude = opts.claude;
    this.#usageDb = opts.usageDb;
  }

  #model(userId: string): AccountModel {
    const user = getUser(this.#db, userId);
    if (!user) throw new AiError(401, "SIGN_IN_REQUIRED", "The account no longer exists");
    const meta = (key: string) => (this.#db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
    if (user.role === "member") {
      const assigned = meta(`member_model:${userId}`);
      const model = assigned && MEMBER_MODELS.includes(assigned) ? assigned : MEMBER_MODEL;
      const effort = meta(`member_effort:${userId}`);
      return { claude: model !== MEMBER_GPT_MODEL, model, maxEffort: (effort && MEMBER_EFFORTS.includes(effort) ? effort : MEMBER_EFFORT) as AiEffort };
    }
    const model = readAgentSettings(this.#db).model ?? this.#cfg.agent.defaultModel;
    return { claude: !!this.#claude?.owns(model), model, maxEffort: null };
  }

  async answer(userId: string, req: AiRequest): Promise<AiAnswer> {
    const account = this.#model(userId);
    const effort = account.maxEffort && AI_EFFORTS.indexOf(req.effort) > AI_EFFORTS.indexOf(account.maxEffort) ? account.maxEffort : req.effort;
    const started = Date.now();
    const { text, usage } = account.claude ? await this.#claudeAnswer(account.model, effort, req) : await this.#gptAnswer(account.model, effort, req);
    try {
      new UsageLedger(await this.#usageDb(userId), userId).once(`clawpage-ai:${randomUUID()}`, usage, account.claude);
    } catch (err) {
      this.#log.warn("clawpage AI usage not recorded", { userId, error: err instanceof Error ? err.message : String(err) });
    }
    this.#log.info("clawpage AI answered", { userId, model: account.model, effort, ms: Date.now() - started, chars: text.length });
    return { text, model: account.model };
  }

  /** The ChatGPT Responses endpoint with the control plane's own login, streamed (as Codex asks for it). */
  async #gptAnswer(model: string, effort: AiEffort, req: AiRequest): Promise<{ text: string; usage: Record<string, unknown> | undefined }> {
    if (!this.#cfg.hostCodex.enabled) throw new AiError(503, "AI_UNAVAILABLE", "This deployment has no ChatGPT login for AI answers");
    const tokens = await this.#hostTokens.getTokens();
    const res = await fetch(`${this.#cfg.hostCodex.chatgptUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": tokens.chatgptAccountId },
      body: JSON.stringify({
        model,
        instructions: req.system,
        input: req.messages.map((m) => ({ type: "message", role: m.role, content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.content }] })),
        reasoning: { effort },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err: unknown) => { throw upstreamFailure(err); });
    if (res.status === 401) this.#hostTokens.invalidate();
    if (!res.ok) throw await upstreamError(res);
    let text = "";
    let usage: Record<string, unknown> | undefined;
    let failure: string | null = null;
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event: { type?: string; delta?: unknown; response?: { usage?: Record<string, unknown>; error?: { message?: unknown } }; message?: unknown; error?: { message?: unknown } };
      try { event = JSON.parse(line.slice(5)) as typeof event; } catch { continue; }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
      else if (event.type === "response.completed") usage = event.response?.usage;
      else if (event.type === "response.failed" || event.type === "error") failure = String(event.response?.error?.message ?? event.error?.message ?? event.message ?? "the model failed");
    }
    if (failure) throw new AiError(502, "AI_FAILED", `The AI could not answer: ${failure}`);
    if (!text.trim()) throw new AiError(502, "AI_FAILED", "The AI gave an empty answer");
    // Responses counts cached input inside input_tokens, as Codex does.
    const details = usage?.input_tokens_details as { cached_tokens?: unknown } | undefined;
    return { text, usage: usage && { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: details?.cached_tokens ?? 0 } };
  }

  /** The Messages API with the owner's Claude credential, as the member gateway adds it. */
  async #claudeAnswer(model: string, effort: AiEffort, req: AiRequest): Promise<{ text: string; usage: Record<string, unknown> | undefined }> {
    const state = this.#claude?.status();
    if (!state?.enabled || !state.secret) throw new AiError(503, "AI_UNAVAILABLE", "This deployment has no Claude credential for AI answers");
    const oauth = state.envKey === "CLAUDE_CODE_OAUTH_TOKEN";
    const res = await fetch(`${this.#cfg.claudeCode.apiBaseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(oauth ? { authorization: `Bearer ${state.secret}`, "anthropic-beta": OAUTH_BETA } : { "x-api-key": state.secret }),
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        output_config: { effort },
        system: [
          // A subscription credential only serves requests that introduce themselves as Claude Code.
          ...(oauth ? [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] : []),
          { type: "text", text: req.system },
        ],
        messages: req.messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err: unknown) => { throw upstreamFailure(err); });
    if (!res.ok) throw await upstreamError(res);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: Record<string, unknown> };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text.trim()) throw new AiError(502, "AI_FAILED", "The AI gave an empty answer");
    return { text, usage: body.usage };
  }
}

function upstreamFailure(err: unknown): AiError {
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  return new AiError(timedOut ? 504 : 502, timedOut ? "AI_TIMEOUT" : "AI_FAILED", timedOut ? `The AI took longer than ${TIMEOUT_MS / 1000} seconds` : "The AI could not be reached");
}

async function upstreamError(res: Response): Promise<AiError> {
  const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
  if (res.status === 429) return new AiError(429, "AI_BUSY", "The account's AI quota is used up for now or requests are too frequent; try again later");
  return new AiError(502, "AI_FAILED", `The AI service returned ${res.status}${detail ? ` (${detail})` : ""}`);
}
