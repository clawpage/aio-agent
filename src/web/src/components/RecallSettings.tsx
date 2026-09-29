import { useEffect, useState } from "react";
import { api } from "../api";
import type { RecallStats } from "../types";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** How well the dispatcher reaches past tasks: what recall injected, what it asked to search, what got chosen. */
export function RecallSettings() {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<RecallStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.recallStats(days).then(
      (r) => { if (!cancelled) setStats(r.stats); },
      (err) => { if (!cancelled) setError(err instanceof Error ? err.message : "读取失败"); },
    );
    return () => { cancelled = true; };
  }, [days]);

  const rows: Array<[string, string]> = stats
    ? [
        ["派单次数", `${stats.dispatches} 次${stats.failed ? `（失败 ${stats.failed}）` : ""}`],
        ["带历史召回的派单", `${stats.withRecall} 次 · 平均每次 ${stats.avgRecalled} 条`],
        ["派单器主动搜索", `${pct(stats.searchRate)} · 平均 ${stats.avgRounds} 轮`],
        ["选中的关联任务", `${stats.chosen} 个，其中召回找到 ${stats.chosenFromRecall}、搜索找到 ${stats.chosenFromSearch}`],
        ["手动引用的老任务", stats.labelled ? `${stats.labelled} 次 · 检索能排进前 ${stats.cap} 名 ${pct(stats.recallAtCap)} · MRR ${stats.mrr ?? "—"}` : "暂无"],
        ["当前召回上限", `${stats.cap} 条（手动引用满 20 次后按实际排名自动调整）`],
        ["平均派单耗时", `${(stats.avgLatencyMs / 1000).toFixed(1)} 秒 · 提示词 P90 ${stats.p90PromptChars.toLocaleString()} 字`],
      ]
    : [];

  return (
    <section className="settings-card recall-settings" aria-label="历史召回">
      <div className="settings-section-head">
        <h3>历史召回</h3>
        <p>派单时自动从全部历史任务里召回相关的几条，必要时派单器再按关键词搜索。手动引用的老任务会用来衡量召回是否找得到。</p>
      </div>
      <div className="recall-range" role="group" aria-label="统计范围">
        {[7, 30].map((d) => (
          <button key={d} type="button" className="ghost" aria-pressed={days === d} onClick={() => setDays(d)}>近 {d} 天</button>
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
