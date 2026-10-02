import type { Db } from "./db.js";
import { getMeta, setMeta } from "./db.js";

/**
 * Owner-level agent settings, applied to every later message from any device.
 * Stored in the `meta` table (owner namespace) so the choice survives restarts
 * and is shared across browsers, unlike a per-conversation or local value.
 */
export interface AgentSettings {
  /** Model id, or null to use the configured default model. */
  model: string | null;
  /** Reasoning effort, or null to use the chosen model's own default. */
  effort: string | null;
}

export const AGENT_SETTINGS_META_KEY = "owner.agent_settings";

export function emptyAgentSettings(): AgentSettings {
  return { model: null, effort: null };
}

/** Read the persisted settings; unknown or corrupt content degrades to defaults. */
export function readAgentSettings(db: Db): AgentSettings {
  const raw = getMeta(db, AGENT_SETTINGS_META_KEY);
  if (!raw) return emptyAgentSettings();
  try {
    const parsed = JSON.parse(raw) as { model?: unknown; effort?: unknown };
    return {
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : null,
      effort: typeof parsed.effort === "string" && parsed.effort ? parsed.effort : null,
    };
  } catch {
    return emptyAgentSettings();
  }
}

export function writeAgentSettings(db: Db, settings: AgentSettings): void {
  setMeta(db, AGENT_SETTINGS_META_KEY, JSON.stringify({ model: settings.model, effort: settings.effort }));
}

/** Minimal model shape needed to validate a settings choice. */
export interface ValidatableModel {
  id: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export type SettingsValidation =
  | { ok: true; settings: AgentSettings }
  | { ok: false; message: string };

/** A settings field is either an explicit string, or null for "use the default". */
function normalizeField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Validate a *complete* settings payload against the live model catalog.
 *
 * The payload must be a plain object carrying both `model` and `effort`, each a
 * string or null; anything else is refused rather than silently coerced, so a
 * malformed request can never overwrite a good stored choice. An unknown model
 * or an effort that model does not support is refused for the same reason: a
 * saved setting must not be able to make a later turn fail at Codex start time.
 * Callers that accept partial updates merge with the stored value first.
 */
export function validateAgentSettings(input: unknown, models: ValidatableModel[]): SettingsValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "设置必须是一个对象" };
  }
  const record = input as Record<string, unknown>;
  for (const field of ["model", "effort"] as const) {
    if (!(field in record)) return { ok: false, message: `缺少设置字段：${field}` };
    const value = record[field];
    if (value !== null && typeof value !== "string") {
      return { ok: false, message: `${field} 必须是字符串或 null` };
    }
  }

  const model = normalizeField(record.model);
  const requestedEffort = normalizeField(record.effort);

  if (model && !models.some((m) => m.id === model)) {
    return { ok: false, message: "未知的模型，请刷新后重试" };
  }

  // Effort is only meaningful against a concrete model.
  const target = model ? models.find((m) => m.id === model) : undefined;
  if (requestedEffort) {
    if (!target) return { ok: false, message: "请先选择一个具体模型，再设置思考强度" };
    if (!target.supportedReasoningEfforts.includes(requestedEffort)) {
      return { ok: false, message: "该模型不支持这个思考强度" };
    }
  }

  return { ok: true, settings: { model, effort: requestedEffort } };
}

/**
 * The effective settings a new turn should run with. A stored effort that the
 * current model no longer supports is dropped so the model's own default applies
 * instead of failing the turn.
 */
export function effectiveAgentSettings(
  settings: AgentSettings,
  models: ValidatableModel[],
  defaultModel: string,
): AgentSettings {
  const model = settings.model ?? defaultModel;
  const catalog = models.find((m) => m.id === model);
  // Only clear a stored effort when the catalog is known AND the resolved model
  // genuinely does not support it. An unavailable catalog (Codex not reached
  // yet) must not discard a value that was already validated at save time.
  const effort = settings.effort && catalog && !catalog.supportedReasoningEfforts.includes(settings.effort) ? null : settings.effort;
  return { model: settings.model, effort };
}
