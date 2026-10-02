import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { CodexModel } from "./codex/sandboxCodex.js";

/**
 * Provider id Codex uses for its own ChatGPT-account provider. A conversation
 * with no stored provider always resolves to this one, so the ChatGPT path
 * stays exactly what it was before an optional bridge existed.
 */
export const CHATGPT_PROVIDER_ID = "openai";

const BRIDGE_TEXT_ONLY: string[] = ["text"];

/**
 * Per-model metadata for the models the local OpenCode Go bridge serves.
 *
 * Everything here is verified against the upstream endpoint, not copied from
 * the bridge config: a model must not advertise a thinking level the upstream
 * rejects, or the settings page would let an owner save a combination whose
 * every turn fails. An id that is not listed gets the conservative defaults
 * below (no `max`, text-only), which is the safe direction to be wrong in.
 */
interface BridgeModelSpec {
  displayName: string;
  description: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  inputModalities: string[];
}

const BRIDGE_MODEL_SPECS: Record<string, BridgeModelSpec> = {
  "deepseek-v4.1-flash": {
    displayName: "DeepSeek V4.1 Flash（OpenCode Go）",
    description: "OpenCode Go（本机 LiteLLM 桥）提供的 DeepSeek 模型；仅支持文本输入。",
    supportedReasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    inputModalities: BRIDGE_TEXT_ONLY,
  },
  "mimo-v2.6-pro": {
    displayName: "MiMo V2.6 Pro（OpenCode Go）",
    // The upstream answers HTTP 400 "Invalid request parameters" for `max`, so
    // it is deliberately absent here rather than offered and then rejected.
    description: "OpenCode Go（本机 LiteLLM 桥）提供的 MiMo 模型；仅支持文本输入，思考强度最高到 high。",
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    inputModalities: BRIDGE_TEXT_ONLY,
  },
};

/** Metadata for one bridged model id; unknown ids get the conservative defaults. */
function bridgeModelSpec(model: string): BridgeModelSpec {
  return (
    BRIDGE_MODEL_SPECS[model] ?? {
      displayName: `${model}（OpenCode Go）`,
      description: "OpenCode Go（本机 LiteLLM 桥）提供的模型；仅支持文本输入。",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      inputModalities: BRIDGE_TEXT_ONLY,
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

/** Modes accepted by `PA_OPENCODE_GO_ENABLED`; anything else degrades to auto. */
function parseEnabledSetting(raw: string): BridgeEnabledSetting {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "auto") return "auto";
  if (value === "0" || value === "false" || value === "no" || value === "off") return "off";
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "on";
  // An unrecognised value must not silently switch on an outbound bridge.
  return "auto";
}

/** `~` in a configured path means the control-plane user's home. */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Read one `KEY=VALUE` entry from a private env-style file. The file is read,
 * never executed, and only the requested key is looked at; the value never
 * leaves the caller.
 *
 * A file another account or group can read is refused outright: the control
 * plane would otherwise turn a world-readable secret into a live credential.
 */
export function readSecretFile(
  filePath: string,
  keyName: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: `密钥文件不存在或不可读：${filePath}` };
  }
  if (!stat.isFile()) return { ok: false, reason: `密钥路径不是普通文件：${filePath}` };
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return { ok: false, reason: `密钥文件权限过宽（${mode.toString(8)}），要求 600 或 400：${filePath}` };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, reason: `密钥文件读取失败：${filePath}` };
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== keyName) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Tolerate `KEY="value"` / `KEY='value'` without any shell semantics.
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (!value) return { ok: false, reason: `密钥文件里 ${keyName} 为空：${filePath}` };
    return { ok: true, value };
  }
  return { ok: false, reason: `密钥文件里没有 ${keyName}：${filePath}` };
}

/**
 * The optional OpenCode Go / LiteLLM bridge model.
 *
 * Everything about the bridge lives here, so the control plane has exactly one
 * place that decides whether the extra model exists, how the provider reaches
 * the sandbox Codex process, and which provider a given model must run on. The
 * key is read from the process environment or a permission-checked private file
 * and is never logged, stored in the database, placed in argv, or sent to the
 * browser.
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
      this.#status = { ...base, enabled: false, reason: "PA_OPENCODE_GO_ENABLED 已显式关闭", secret: null };
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
      if (setting === "on") this.#log.warn("桥模型已要求启用但取不到密钥，保持关闭", { reason: message });
      else this.#log.debug("桥模型未启用", { reason: message });
      this.#status = { ...base, enabled: false, reason: message, secret: null };
      return this.#status;
    }

    this.#status = { ...base, enabled: true, reason: null, secret };
    this.#log.info("桥模型已启用", {
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
   * sandbox never needs its `config.toml` rewritten. Empty while the bridge is
   * off, which keeps the ChatGPT-only command line exactly as it was.
   */
  providerConfigArgs(): string[] {
    const status = this.status();
    if (!status.enabled) return [];
    const key = `model_providers.${status.providerId}`;
    return [
      "-c",
      `${key}.name="OpenCode Go (LiteLLM Responses bridge)"`,
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
    return this.providerForModel(model) !== CHATGPT_PROVIDER_ID;
  }
}
