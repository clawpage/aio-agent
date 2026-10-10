import { InlineLoading } from "./Brand";
import {SoulSettings} from './SoulSettings';
import { RecallSettings } from './RecallSettings';
import { DebugSettings } from './DebugSettings';
import { InviteSettings } from './InviteSettings';
import { LanguageSettings } from './LanguageSettings';
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AgentSettings, SettingsModel } from "../types";
import { t } from "../i18n";

/** Human labels for the reasoning-effort values the model catalog reports. */
const EFFORT_LABELS: Record<string, string> = t.settings.run.efforts;

function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value;
}

/** The executor a catalog entry runs on; every model belongs to exactly one. */
type Harness = "codex" | "claude-code";
const HARNESS_LABELS: Record<Harness, string> = { codex: "Codex", "claude-code": "Claude Code" };

function harnessOf(model: SettingsModel | undefined): Harness {
  return model?.modelProvider === "claude-code" ? "claude-code" : "codex";
}

interface Props {
  onBack: () => void;
  /** Inform the shell so the sidebar/nav can reflect a saved change. */
  onSaved?: (settings: AgentSettings) => void;
}

/**
 * Unified configuration page. It owns the model and reasoning effort that every
 * later message runs with, persisted server-side in the owner's `meta` namespace
 * so the choice survives reloads and applies across devices. The conversation
 * view keeps no model control of its own.
 */
export function Settings({ onBack, onSaved }: Props) {
  const [models, setModels] = useState<SettingsModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<string>("");
  /** null = catalog unknown (do not claim the saved model is unusable). */
  const [savedModelAvailable, setSavedModelAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.settings();
      setModels(data.models);
      setDefaultModel(data.defaultModel);
      setModel(data.settings.model ?? data.defaultModel);
      setEffort(data.settings.effort ?? "");
      setSavedModelAvailable(data.savedModelAvailable);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const catalogKnown = models.length > 0;
  const currentModel = useMemo(() => models.find((m) => m.id === model), [models, model]);
  const efforts = currentModel?.supportedReasoningEfforts ?? [];
  const harness = harnessOf(currentModel);
  /** The picker only appears when another executor is actually configured. */
  const harnessChoice = models.some((m) => harnessOf(m) === "claude-code");
  const harnessModels = harnessChoice ? models.filter((m) => harnessOf(m) === harness) : models;
  // A model with no alternative efforts has nothing to choose; keep the select
  // disabled rather than offering an empty control.
  const effortDisabled = !currentModel || efforts.length === 0;
  // A stored model the catalog no longer offers cannot be saved; the user must
  // pick a valid one first (rather than the select silently showing another).
  const savedModelUnusable = savedModelAvailable === false && Boolean(model) && !currentModel;
  const canSave = !loading && !saving && catalogKnown && Boolean(model) && !savedModelUnusable;
  const isDefaultChoice = Boolean(defaultModel) && model === defaultModel && effort === "";
  /**
   * A catalog entry on another provider that takes only text: the page says so
   * instead of letting an image attachment fail on send.
   */
  const textOnlyHint = Boolean(currentModel?.modelProvider) && currentModel?.inputModalities?.includes("image") === false;

  const pickModel = useCallback(
    (next: string) => {
      setSaved(null);
      setModel(next);
      // The effort belongs to the model: drop a value the new model does not
      // support instead of saving a combination the server would reject.
      const target = models.find((m) => m.id === next);
      setEffort((prev) => (prev && target?.supportedReasoningEfforts.includes(prev) ? prev : ""));
    },
    [models],
  );

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const result = await api.saveSettings({ model, effort: effort || null });
      onSaved?.(result.settings);
      setSaved(t.settings.run.saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [canSave, effort, model, onSaved]);

  const pickHarness = useCallback(
    (next: Harness) => {
      if (next === harness) return;
      // Switching executor selects that executor's first model (the configured
      // default when it belongs there) with the model's own default effort.
      const candidates = models.filter((m) => harnessOf(m) === next);
      const target = candidates.find((m) => m.id === defaultModel) ?? candidates[0];
      if (!target) return;
      setSaved(null);
      setModel(target.id);
      setEffort("");
    },
    [defaultModel, harness, models],
  );

  const restoreDefaults = useCallback(() => {
    setSaved(null);
    setModel(defaultModel);
    setEffort("");
  }, [defaultModel]);

  // While a save is in flight every editor is locked, so the value shown can
  // never change under a request that then reports success for the old one.
  const locked = loading || saving;

  return (
    <section className="settings" aria-label={t.settings.page.title}>
      <header className="settings-head">
        <h2>{t.settings.page.title}</h2>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onBack} disabled={saving}>
          {t.settings.page.back}
        </button>
      </header>

      <div className="settings-body">
        <p className="muted settings-intro">
          {t.settings.page.intro}
        </p>

        <SoulSettings />

        <section className="settings-card" aria-label={t.settings.run.title}>
          <div className="settings-section-head"><h3>{t.settings.run.title}</h3><p>{harnessChoice ? t.settings.run.introWithHarness : t.settings.run.introModelOnly}{t.settings.run.introSuffix}</p></div>
        {loading && <p><InlineLoading label={t.settings.run.loading}/></p>}

        {!loading && loadError && (
          <div className="banner error" role="alert">
            {t.settings.run.loadFailed(loadError)}
            <button type="button" onClick={() => void load()}>
              {t.settings.run.retry}
            </button>
          </div>
        )}

        {!loading && !loadError && !catalogKnown && (
          <div className="banner warn" role="status">
            {t.settings.run.catalogUnavailable}
          </div>
        )}

        {!loading && !loadError && savedModelUnusable && (
          <div className="banner warn" role="alert">
            {t.settings.run.savedModelUnusable}
          </div>
        )}

        <div className="settings-fields">
          {harnessChoice && (
            <label className="field">
              <span>{t.settings.run.harness}</span>
              <select
                aria-label={t.settings.run.harness}
                value={harness}
                onChange={(e) => pickHarness(e.target.value as Harness)}
                disabled={locked || !catalogKnown}
              >
                {(Object.keys(HARNESS_LABELS) as Harness[]).map((h) => (
                  <option key={h} value={h}>
                    {HARNESS_LABELS[h]}
                  </option>
                ))}
              </select>
              <span className="muted tiny">
                {harness === "claude-code"
                  ? t.settings.run.harnessClaudeHint
                  : t.settings.run.harnessCodexHint}
              </span>
            </label>
          )}

          <label className="field">
            <span>{t.settings.run.model}</span>
            <select
              aria-label={t.settings.run.model}
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              disabled={locked || !catalogKnown}
            >
              {/* A stored model the catalog no longer lists stays visible (and
                  explicitly unavailable) instead of the select pretending the
                  first catalog entry is the current choice. */}
              {savedModelUnusable && <option value={model}>{t.settings.run.modelUnavailable(model)}</option>}
              {harnessModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName || m.id}
                  {m.id === defaultModel ? t.settings.run.modelDefault : ""}
                </option>
              ))}
              {!catalogKnown && model && <option value={model}>{model}</option>}
            </select>
            <span className="muted tiny">{t.settings.run.modelHint}</span>
          </label>

          {textOnlyHint && (
            <p className="muted tiny" role="note">
              {t.settings.run.textOnlyHint}
            </p>
          )}

          <label className="field">
            <span>{t.settings.run.effort}</span>
            <select
              aria-label={t.settings.run.effort}
              value={effort}
              onChange={(e) => {
                setSaved(null);
                setEffort(e.target.value);
              }}
              disabled={locked || effortDisabled}
            >
              <option value="">{t.settings.run.effortModelDefault}</option>
              {efforts.map((value) => (
                <option key={value} value={value}>
                  {effortLabel(value)}
                </option>
              ))}
            </select>
            <span className="muted tiny">
              {currentModel?.defaultReasoningEffort
                ? t.settings.run.effortHintWithDefault(effortLabel(currentModel.defaultReasoningEffort))
                : t.settings.run.effortHint}
            </span>
          </label>
        </div>

        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {saved && (
          <div className="banner ok" role="status">
            {saved}
          </div>
        )}

        <div className="settings-actions">
          <button type="button" className="ghost" onClick={restoreDefaults} disabled={locked || isDefaultChoice}>
            {t.settings.run.restoreDefaults}
          </button>
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? t.settings.run.saving : t.settings.run.save}
          </button>
        </div>

        </section>

        <InviteSettings />
        <RecallSettings />
        <LanguageSettings />
        <DebugSettings />
      </div>
    </section>
  );
}
