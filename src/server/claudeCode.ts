import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { CodexModel } from "./codex/sandboxCodex.js";
import { expandHome, readSecretFile } from "./bridgeModel.js";

/**
 * Provider id recorded on conversations that run on the Claude Code harness.
 * A conversation keeps its harness for life: Codex threads and Claude Code
 * sessions cannot be forked into each other.
 */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/** Thread ids handed out for Claude Code sessions; the rest is the CLI session UUID. */
export const CLAUDE_THREAD_PREFIX = "claude-";

/** Credential names the CLI understands, in lookup order. */
const CREDENTIAL_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** A member sandbox authenticates to the member gateway with its own token under this name. */
export const MEMBER_GATEWAY_TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Models offered on the Claude Code harness. The effort default is left null:
 * without `--effort` the CLI applies its own per-model default, which this
 * control plane does not claim to know.
 */
const CLAUDE_MODELS: Array<{ id: string; displayName: string; description: string }> = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5（Claude Code）", description: "Claude Code 执行器，默认推荐。" },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5（Claude Code）", description: "Claude Code 执行器，速度更快。" },
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1（Claude Code）", description: "Claude Code 执行器，能力最强、价格最高。" },
];

export type ClaudeCodeEnabledSetting = "auto" | "on" | "off";

function parseEnabledSetting(raw: string): ClaudeCodeEnabledSetting {
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off") return "off";
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "on";
  return "auto";
}

export interface ClaudeCodeStatus {
  enabled: boolean;
  /** Why it is not enabled (safe to log; never contains the credential). */
  reason: string | null;
  /** Variable name the CLI reads the credential from. */
  envKey: string | null;
  /** The credential itself. Callers must never log, persist or echo it. */
  secret: string | null;
}

/**
 * The optional Claude Code harness decision, made once per process.
 *
 * The owner's credential comes from the environment or a permission-checked
 * private file, and only ever reaches the owner sandbox through a `docker exec`
 * child environment, never argv, logs, the database or the browser.
 *
 * A member runtime gets the harness only when its assigned model is a Claude
 * model; its sandbox then holds just that member's gateway token and address.
 * The member gateway adds the owner's credential on the host.
 */
export class ClaudeCodeHarness {
  #cfg: Config;
  #log: Logger;
  #status: ClaudeCodeStatus | null = null;

  constructor(cfg: Config, log: Logger) {
    this.#cfg = cfg;
    this.#log = log.child("claude-code");
  }

  status(): ClaudeCodeStatus {
    if (this.#status) return this.#status;
    const off = (reason: string): ClaudeCodeStatus => ({ enabled: false, reason, envKey: null, secret: null });
    const setting = parseEnabledSetting(this.#cfg.claudeCode.enabled);
    if (this.#cfg.memberRuntime) {
      // Never the process environment or the owner's file: those hold the owner's credential.
      if (!this.#cfg.claudeCode.gatewayUrl) return (this.#status = off("成员账号未分配 Claude 模型"));
      const file = readSecretFile(this.#cfg.claudeCode.secretsFile, MEMBER_GATEWAY_TOKEN_KEY);
      return (this.#status = file.ok ? this.#enable(MEMBER_GATEWAY_TOKEN_KEY, file.value, "file") : off(file.reason));
    }
    if (setting === "off") return (this.#status = off("PA_CLAUDE_CODE_ENABLED 已显式关闭"));

    const reasons: string[] = [];
    for (const key of CREDENTIAL_KEYS) {
      const fromEnv = process.env[key]?.trim();
      if (fromEnv) return (this.#status = this.#enable(key, fromEnv, "env"));
      const file = readSecretFile(expandHome(this.#cfg.claudeCode.secretsFile), key);
      if (file.ok) return (this.#status = this.#enable(key, file.value, "file"));
      reasons.push(file.reason);
    }
    const message = reasons[0] ?? "未找到 Claude Code 凭据";
    if (setting === "on") this.#log.warn("Claude Code 执行器已要求启用但取不到凭据，保持关闭", { reason: message });
    else this.#log.debug("Claude Code 执行器未启用", { reason: message });
    return (this.#status = off(message));
  }

  #enable(envKey: string, secret: string, source: "env" | "file"): ClaudeCodeStatus {
    this.#log.info("Claude Code 执行器已启用", { envKey, source, version: this.#cfg.claudeCode.version });
    return { enabled: true, reason: null, envKey, secret };
  }

  get enabled(): boolean {
    return this.status().enabled;
  }

  /** Catalog entries added to the model picker; empty while the harness is off. */
  modelEntries(): CodexModel[] {
    if (!this.enabled) return [];
    return this.#models().map((m) => ({
      id: m.id,
      model: m.id,
      displayName: m.displayName,
      description: m.description,
      isDefault: false,
      supportedReasoningEfforts: [...CLAUDE_EFFORTS],
      defaultReasoningEffort: null,
      // Attachments are handed over as sandbox paths; the CLI reads images itself.
      inputModalities: ["text", "image"],
      modelProvider: CLAUDE_CODE_PROVIDER_ID,
    }));
  }

  /** Whether a turn using `model` must run on Claude Code. */
  owns(model: string): boolean {
    return this.enabled && this.#models().some((m) => m.id === model);
  }

  /** A member runs only the model assigned to it. */
  #models() {
    return this.#cfg.memberRuntime ? CLAUDE_MODELS.filter((m) => m.id === this.#cfg.memberModel) : CLAUDE_MODELS;
  }

  /** Child environment for `docker exec`; the value never appears in argv. */
  credentialEnv(): Record<string, string> {
    const status = this.status();
    if (!status.enabled || !status.envKey || !status.secret) return {};
    const gateway = this.#cfg.claudeCode.gatewayUrl;
    return gateway
      ? { [status.envKey]: status.secret, ANTHROPIC_BASE_URL: gateway, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }
      : { [status.envKey]: status.secret };
  }
}

export function isClaudeThread(threadId: string): boolean {
  return threadId.startsWith(CLAUDE_THREAD_PREFIX);
}
