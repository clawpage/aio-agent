import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AgentSettings, SettingsModel } from "../types";

/** Human labels for the reasoning-effort values the model catalog reports. */
const EFFORT_LABELS: Record<string, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value;
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
  // A model with no alternative efforts has nothing to choose; keep the select
  // disabled rather than offering an empty control.
  const effortDisabled = !currentModel || efforts.length === 0;
  // A stored model the catalog no longer offers cannot be saved; the user must
  // pick a valid one first (rather than the select silently showing another).
  const savedModelUnusable = savedModelAvailable === false && Boolean(model) && !currentModel;
  const canSave = !loading && !saving && catalogKnown && Boolean(model) && !savedModelUnusable;
  const isDefaultChoice = Boolean(defaultModel) && model === defaultModel && effort === "";

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
      setSaved("已保存，之后的每条消息都会使用这个配置。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [canSave, effort, model, onSaved]);

  const restoreDefaults = useCallback(() => {
    setSaved(null);
    setModel(defaultModel);
    setEffort("");
  }, [defaultModel]);

  // While a save is in flight every editor is locked, so the value shown can
  // never change under a request that then reports success for the old one.
  const locked = loading || saving;

  return (
    <section className="settings" aria-label="配置">
      <header className="settings-head">
        <button type="button" className="ghost" onClick={onBack} disabled={saving}>
          ← 返回会话
        </button>
        <h2>配置</h2>
      </header>

      <div className="settings-body">
        <p className="muted settings-intro">
          这里的设置对之后发送的每条消息生效，并在所有设备间保持一致。修改不会影响正在执行的任务或已有对话。
        </p>

        {loading && <p className="muted">正在加载…</p>}

        {!loading && loadError && (
          <div className="banner error" role="alert">
            加载配置失败：{loadError}
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {!loading && !loadError && !catalogKnown && (
          <div className="banner warn" role="status">
            暂时无法获取模型列表，配置保存已停用。请稍后重试。
          </div>
        )}

        {!loading && !loadError && savedModelUnusable && (
          <div className="banner warn" role="alert">
            已保存的模型当前不可用，请选择一个有效模型后再保存。
          </div>
        )}

        <div className="settings-card">
          <label className="field">
            <span>模型</span>
            <select
              aria-label="模型"
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              disabled={locked || !catalogKnown}
            >
              {/* A stored model the catalog no longer lists stays visible (and
                  explicitly unavailable) instead of the select pretending the
                  first catalog entry is the current choice. */}
              {savedModelUnusable && <option value={model}>{model}（当前不可用）</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName || m.id}
                  {m.id === defaultModel ? "（默认）" : ""}
                </option>
              ))}
              {!catalogKnown && model && <option value={model}>{model}</option>}
            </select>
            <span className="muted tiny">所有新消息都会使用这个模型。</span>
          </label>

          <label className="field">
            <span>思考强度</span>
            <select
              aria-label="思考强度"
              value={effort}
              onChange={(e) => {
                setSaved(null);
                setEffort(e.target.value);
              }}
              disabled={locked || effortDisabled}
            >
              <option value="">按模型默认</option>
              {efforts.map((value) => (
                <option key={value} value={value}>
                  {effortLabel(value)}
                </option>
              ))}
            </select>
            <span className="muted tiny">
              {currentModel?.defaultReasoningEffort
                ? `留空时使用该模型的默认强度（${effortLabel(currentModel.defaultReasoningEffort)}）。`
                : "留空时使用该模型的默认强度。"}
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
            恢复默认
          </button>
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>

        <p className="muted tiny">默认配置：模型 {defaultModel || "—"}，思考强度按模型默认。保存后对之后的所有消息生效。</p>
      </div>
    </section>
  );
}
