import { useEffect, useState } from "react";
import { api } from "../api";
import type { RecallStats } from "../types";
import { t } from "../i18n";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** How well the dispatcher reaches past tasks: what recall injected and what got chosen. */
export function RecallSettings() {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<RecallStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.recallStats(days).then(
      (r) => { if (!cancelled) setStats(r.stats); },
      (err) => { if (!cancelled) setError(err instanceof Error ? err.message : t.settings.recall.loadFailed); },
    );
    return () => { cancelled = true; };
  }, [days]);

  const rows: Array<[string, string]> = stats
    ? [
        [t.settings.recall.dispatches, `${t.settings.recall.dispatchCount(stats.dispatches)}${stats.failed || stats.repaired ? t.settings.recall.breakdown([stats.failed ? t.settings.recall.failed(stats.failed) : "", stats.repaired ? t.settings.recall.repaired(stats.repaired) : ""].filter(Boolean).join(" · ")) : ""}`],
        [t.settings.recall.withRecall, t.settings.recall.withRecallValue(stats.withRecall, stats.avgRecalled)],
        [t.settings.recall.search, t.settings.recall.searchValue(pct(stats.searchRate), stats.avgRounds)],
        [t.settings.recall.chosen, t.settings.recall.chosenValue(stats.chosen, stats.chosenFromRecall)],
        [t.settings.recall.labelled, stats.labelled ? t.settings.recall.labelledValue(stats.labelled, stats.cap, pct(stats.recallAtCap), String(stats.mrr ?? "—")) : t.settings.recall.none],
        [t.settings.recall.cap, t.settings.recall.capValue(stats.cap)],
        [t.settings.recall.latency, t.settings.recall.latencyValue((stats.avgLatencyMs / 1000).toFixed(1), stats.p90PromptChars.toLocaleString())],
      ]
    : [];

  return (
    <section className="settings-card recall-settings" aria-label={t.settings.recall.title}>
      <div className="settings-section-head">
        <h3>{t.settings.recall.title}</h3>
        <p>{t.settings.recall.intro}</p>
      </div>
      <div className="recall-range" role="group" aria-label={t.settings.recall.range}>
        {[7, 30].map((d) => (
          <button key={d} type="button" className="ghost" aria-pressed={days === d} onClick={() => setDays(d)}>{t.settings.recall.lastDays(d)}</button>
        ))}
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {stats && (
        <dl className="recall-stats">
          {rows.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
    </section>
  );
}
