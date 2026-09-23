import { describe, expect, it } from "vitest";
import { openDb } from "../../src/server/db.js";
import {
  AGENT_SETTINGS_META_KEY,
  effectiveAgentSettings,
  readAgentSettings,
  validateAgentSettings,
  writeAgentSettings,
  type ValidatableModel,
} from "../../src/server/settings.js";

const MODELS: ValidatableModel[] = [
  { id: "gpt-6-sol", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
  { id: "gpt-5.5", supportedReasoningEfforts: ["minimal", "low"], defaultReasoningEffort: "low" },
];

describe("agent settings validation", () => {
  it("accepts the default choice and a fully specified model+effort", () => {
    expect(validateAgentSettings({ model: null, effort: null }, MODELS)).toEqual({
      ok: true,
      settings: { model: null, effort: null },
    });
    expect(validateAgentSettings({ model: "gpt-6-sol", effort: "high" }, MODELS)).toEqual({
      ok: true,
      settings: { model: "gpt-6-sol", effort: "high" },
    });
  });

  it("refuses an unknown model instead of storing it", () => {
    const result = validateAgentSettings({ model: "gpt-9-nope", effort: null }, MODELS);
    expect(result.ok).toBe(false);
  });

  it("refuses an effort the chosen model does not support", () => {
    const result = validateAgentSettings({ model: "gpt-5.5", effort: "high" }, MODELS);
    expect(result.ok).toBe(false);
  });

  it("refuses an effort without a concrete model to validate it against", () => {
    const result = validateAgentSettings({ model: null, effort: "high" }, MODELS);
    expect(result.ok).toBe(false);
  });

  it("treats blank strings as the default rather than an invalid value", () => {
    expect(validateAgentSettings({ model: "  ", effort: "" }, MODELS)).toEqual({
      ok: true,
      settings: { model: null, effort: null },
    });
  });

  it("refuses non-object payloads and wrong field types instead of coercing them", () => {
    expect(validateAgentSettings(null, MODELS).ok).toBe(false);
    expect(validateAgentSettings([], MODELS).ok).toBe(false);
    expect(validateAgentSettings("gpt-6-sol", MODELS).ok).toBe(false);
    // A numeric model must not be silently turned into null (which would reset).
    expect(validateAgentSettings({ model: 123, effort: null }, MODELS).ok).toBe(false);
    expect(validateAgentSettings({ model: "gpt-6-sol", effort: 3 }, MODELS).ok).toBe(false);
  });

  it("requires both fields so a partial payload is merged by the caller, not coerced", () => {
    expect(validateAgentSettings({ model: "gpt-6-sol" }, MODELS).ok).toBe(false);
    expect(validateAgentSettings({ effort: "high" }, MODELS).ok).toBe(false);
  });
});

describe("effective settings", () => {
  it("falls back to the configured default model when none is stored", () => {
    expect(effectiveAgentSettings({ model: null, effort: null }, MODELS, "gpt-6-sol")).toEqual({
      model: null,
      effort: null,
    });
  });

  it("drops a stored effort the current model no longer supports", () => {
    // gpt-5.5 supports "minimal" but gpt-6-sol does not; a stale stored effort
    // must not fail the next turn.
    expect(effectiveAgentSettings({ model: "gpt-6-sol", effort: "minimal" }, MODELS, "gpt-6-sol")).toEqual({
      model: "gpt-6-sol",
      effort: null,
    });
  });

  it("keeps a stored effort the model does support", () => {
    expect(effectiveAgentSettings({ model: "gpt-6-sol", effort: "high" }, MODELS, "gpt-6-sol").effort).toBe("high");
  });

  it("keeps a stored effort when the model catalog is not yet known", () => {
    // A cold sandbox reports no models; discarding the stored effort here would
    // silently downgrade the user's choice on the next turn.
    expect(effectiveAgentSettings({ model: "gpt-6-sol", effort: "high" }, [], "gpt-6-sol")).toEqual({
      model: "gpt-6-sol",
      effort: "high",
    });
  });
});

describe("settings persistence", () => {
  it("round-trips through the owner meta namespace", () => {
    const db = openDb(":memory:");
    try {
      expect(readAgentSettings(db)).toEqual({ model: null, effort: null });
      writeAgentSettings(db, { model: "gpt-6-sol", effort: "high" });
      expect(readAgentSettings(db)).toEqual({ model: "gpt-6-sol", effort: "high" });
      const stored = db.prepare("SELECT value FROM meta WHERE key = ?").get(AGENT_SETTINGS_META_KEY) as { value: string };
      expect(JSON.parse(stored.value)).toEqual({ model: "gpt-6-sol", effort: "high" });
    } finally {
      db.close();
    }
  });

  it("degrades to defaults on corrupt content instead of throwing", () => {
    const db = openDb(":memory:");
    try {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(AGENT_SETTINGS_META_KEY, "{not json");
      expect(readAgentSettings(db)).toEqual({ model: null, effort: null });
    } finally {
      db.close();
    }
  });
});
