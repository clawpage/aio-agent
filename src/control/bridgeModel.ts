import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import type { CodexModel } from "./codex/sandboxCodex.js";
import { expandHome, readSecretFile } from "../common/secrets.js";

/**
 * Provider id Codex uses for its own ChatGPT-account provider. A conversation
 * with no stored provider always resolves to this one.
 */
export const CHATGPT_PROVIDER_ID = "openai";

/**
 * Per-model metadata for what a member's gateway provider serves. A member
 * assigned GPT reaches the owner's ChatGPT login through it; the values come
 * from the model catalog bundled with Codex 0.160. An id that is not listed
 * gets conservative defaults (text-only, no `max`).
 */
interface BridgeModelSpec {
  displayName: string;
  description: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  inputModalities: string[];
}
const BRIDGE_MODEL_SPECS: Record<string, BridgeModelSpec> = {
  "gpt-6.1-sol": {
    displayName: "GPT-6.1 Sol",
    description: "经成员模型网关使用 owner 的 ChatGPT 登录；凭据只在宿主侧附加。",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "low",
    inputModalities: ["text", "image"],
  },
};

/** Metadata for one gateway model id; unknown ids get the conservative defaults. */
function bridgeModelSpec(model: string): BridgeModelSpec {
  return (
    BRIDGE_MODEL_SPECS[model] ?? {
      displayName: model,
      description: "经成员模型网关提供的模型；仅支持文本输入。",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      inputModalities: ["text"],
    }
  );
}

export type BridgeEnabledSetting = "auto" | "on" | "off";

export interface BridgeStatus {
  /** Final decision: the bridge is only usable when a key could be read. */
  enabled: boolean;
  /** Why it is not enabled (safe to log; never contains the key). */
  reason: string | null;
  /** The master key itself. Callers must never log, persist or echo it. */
  secret: string | null;
  providerId: string;
  /** Every model the bridge serves, in configured order. */
  models: string[];
  baseUrl: string;
  /** Environment variable name the sandbox Codex reads the key from. */
  envKey: string;
  setting: BridgeEnabledSetting;
}

/** Modes accepted for `bridge.enabled`; anything else degrades to auto. */
function parseEnabledSetting(raw: string): BridgeEnabledSetting {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "auto") return "auto";
  if (value === "0" || value === "false" || value === "no" || value === "off") return "off";
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "on";
  // An unrecognised value must not silently switch on an outbound bridge.
  return "auto";
}

/**
 * A member runtime's model provider: the member gateway on the host.
 *
 * Everything about it lives here, so the control plane has exactly one place
 * that decides whether the provider exists, how it reaches the sandbox Codex
 * process, and which provider a given model must run on. The member's gateway
 * token is read from a permission-checked private file and is never logged,
 * stored in the database, placed in argv, or sent to the browser. The owner's
 * runtime has none: its turns run on its ChatGPT login or Claude Code.
 */
export class BridgeModel {
  #cfg: Config;
  #log: Logger;
  #status: BridgeStatus | null = null;

  constructor(cfg: Config, log: Logger) {
    this.#cfg = cfg;
    this.#log = log.child("bridge-model");
  }

  /** Resolved once per process; every later read reuses the same decision. */
  status(): BridgeStatus {
    if (this.#status) return this.#status;
    const b = this.#cfg.bridge;
    const setting = parseEnabledSetting(b.enabled);
    const base = {
      providerId: b.providerId,
      models: b.models,
      baseUrl: b.baseUrl,
      envKey: b.envKey,
      setting,
    } as const;
    if (setting === "off") {
      this.#status = { ...base, enabled: false, reason: "未启用成员模型网关", secret: null };
      return this.#status;
    }

    const fromEnv = process.env[b.envKey];
    const fromEnvValue = fromEnv?.trim() ? fromEnv.trim() : null;
    let secret: string | null = fromEnvValue;
    let reason: string | null = null;
    if (!secret) {
      const file = readSecretFile(expandHome(b.secretsFile), b.envKey);
      if (file.ok) secret = file.value;
      else reason = file.reason;
    }

    if (!secret) {
      const message = reason ?? `环境变量 ${b.envKey} 未设置且密钥文件不可用`;
      // An explicit opt-in that cannot work must be loud, and either way the
      // model list never advertises a model whose every turn would fail.
      if (setting === "on") this.#log.warn("成员模型网关已要求启用但取不到令牌，保持关闭", { reason: message });
      else this.#log.debug("成员模型网关未启用", { reason: message });
      this.#status = { ...base, enabled: false, reason: message, secret: null };
      return this.#status;
    }

    this.#status = { ...base, enabled: true, reason: null, secret };
    this.#log.info("成员模型网关已启用", {
      models: b.models,
      provider: b.providerId,
      baseUrl: b.baseUrl,
      envKey: b.envKey,
      source: fromEnvValue ? "env" : "file",
    });
    return this.#status;
  }

  get enabled(): boolean {
    return this.status().enabled;
  }

  /** Every bridged model id, whether or not the bridge is usable. */
  get modelIds(): string[] {
    return this.#cfg.bridge.models;
  }

  get providerId(): string {
    return this.#cfg.bridge.providerId;
  }

  /** Catalog entries the control plane adds; empty while the bridge is off. */
  modelEntries(): CodexModel[] {
    const status = this.status();
    if (!status.enabled) return [];
    return status.models.map((id) => {
      const spec = bridgeModelSpec(id);
      return {
        id,
        model: id,
        displayName: spec.displayName,
        description: spec.description,
        isDefault: false,
        supportedReasoningEfforts: [...spec.supportedReasoningEfforts],
        defaultReasoningEffort: spec.defaultReasoningEffort,
        inputModalities: [...spec.inputModalities],
        modelProvider: status.providerId,
      };
    });
  }

  /**
   * `-c` overrides that define the provider on the Codex command line, so the
   * sandbox never needs its `config.toml` rewritten. Empty while it is off,
   * which keeps the ChatGPT-only command line exactly as it was.
   */
  providerConfigArgs(): string[] {
    const status = this.status();
    if (!status.enabled) return [];
    const key = `model_providers.${status.providerId}`;
    return [
      "-c",
      `${key}.name="AIO member gateway"`,
      "-c",
      `${key}.base_url="${status.baseUrl}"`,
      "-c",
      `${key}.wire_api="responses"`,
      "-c",
      `${key}.supports_websockets=false`,
      "-c",
      `${key}.env_key="${status.envKey}"`,
    ];
  }

  /**
   * `docker exec` flags carrying only the *name* of the secret variable, so the
   * value never appears in a process list. The value travels in the child env.
   */
  providerEnvFlags(): string[] {
    return this.status().enabled ? ["-e", this.status().envKey] : [];
  }

  /** Environment entries for the `docker exec` child process. Never logged. */
  providerEnv(): Record<string, string> {
    const status = this.status();
    if (!status.enabled || !status.secret) return {};
    return { [status.envKey]: status.secret };
  }

  /** Provider a turn using `model` must run on. */
  providerForModel(model: string): string {
    const status = this.status();
    return status.enabled && status.models.includes(model) ? status.providerId : CHATGPT_PROVIDER_ID;
  }

  /** Whether this model can only take text (so an image must be refused early). */
  isTextOnly(model: string): boolean {
    return this.providerForModel(model) !== CHATGPT_PROVIDER_ID && !bridgeModelSpec(model).inputModalities.includes("image");
  }
}
