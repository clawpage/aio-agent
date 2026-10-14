import { InlineLoading } from "./Brand";
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { AnalyticsReport } from '../../../common/analytics';
import { locale, t } from '../i18n';

const fmt = (n: number) => n.toLocaleString(locale);
const pct = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : '—';
const SERIES = [['active', 'var(--chart-1)'], ['signups', 'var(--chart-2)'], ['tasks', 'var(--chart-3)']] as const;
const COLUMNS = ['active', 'signups', 'logins', 'tasks', 'completed', 'failed'] as const;

/** The owner's product statistics: accounts, activity, tasks, feature use and platforms (src/control/analytics.ts). */
export function AnalyticsDashboard({ onExpired }: { onExpired: () => void }) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<AnalyticsReport | null>(null), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) return; busy = true;
      try { const data = await api.analytics(days, controller.signal); if (!controller.signal.aborted) { setReport(data); setError(''); } }
      catch (err) { if (!controller.signal.aborted) { if (err instanceof ApiError && err.status === 401) onExpired(); else setError(err instanceof Error ? err.message : t.analytics.readFailed); } }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [days, refresh, onExpired]);
  const current = report?.days === days ? report : null;
  const peak = Math.max(1, ...(current?.daily.flatMap(d => SERIES.map(([k]) => d[k])) ?? []));
  const x = (i: number) => 100 + i * 760 / Math.max(1, days - 1);
  const y = (n: number) => 230 - n / peak * 190;
  const totals = current?.totals;
  return <section className="usage-dashboard" aria-labelledby="analytics-title">
    <header className="chat-head"><div className="chat-title"><h2 id="analytics-title">{t.analytics.title}</h2><span className="task-list-sub muted tiny">{t.analytics.subtitle}</span></div><div className="chat-head-actions"><button className="ghost" onClick={() => setRefresh(v => v + 1)}>{t.analytics.refresh}</button></div></header>
    <div className="usage-body">
    <div className="usage-filters"><label>{t.usage.range}<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>{t.usage.lastDays(7)}</option><option value={30}>{t.usage.lastDays(30)}</option><option value={90}>{t.usage.lastDays(90)}</option></select></label></div>
    {error && <p className="banner error" role="alert">{t.usage.stale(error)}</p>}
    {!current || !totals ? <p><InlineLoading label={t.analytics.loading}/></p> : <>
      <p className="muted tiny">{t.analytics.meta(current.timezone, new Date(current.generatedAt).toLocaleTimeString(locale))}</p>
      <div className="usage-metrics analytics-metrics">
        <article><span className="muted">{t.analytics.metrics.accounts}</span><strong>{fmt(totals.accounts)}</strong><span className="muted tiny">{t.analytics.metrics.newInRange(fmt(totals.signups))}</span></article>
        <article><span className="muted">{t.analytics.metrics.active}</span><strong>{fmt(totals.activeToday)}</strong><span className="muted tiny">{t.analytics.metrics.activeWindows(fmt(totals.active7), fmt(totals.active30))}</span></article>
        <article><span className="muted">{t.analytics.metrics.tasks}</span><strong>{fmt(totals.tasks)}</strong><span className="muted tiny">{t.analytics.metrics.outcomes(pct(totals.completed, totals.tasks), fmt(totals.failed))}</span></article>
        <article><span className="muted">{t.analytics.metrics.conversion}</span><strong>{pct(current.funnel.signups, current.funnel.registerViews)}</strong><span className="muted tiny">{t.analytics.metrics.funnel(fmt(current.funnel.registerViews), fmt(current.funnel.signups))}</span></article>
      </div>
      <article className="usage-chart"><h2>{t.analytics.trend}</h2>
        <svg viewBox="0 0 900 280" role="img" aria-label={t.analytics.chartLabel}>
          {[0, .5, 1].map(v => <g key={v}><line x1="100" x2="860" y1={y(peak*v)} y2={y(peak*v)} stroke="var(--border)"/><text x="90" y={y(peak*v)+4} textAnchor="end">{fmt(Math.round(peak*v))}</text></g>)}
          {SERIES.map(([key, color]) => <g key={key}><polyline fill="none" stroke={color} strokeWidth="2.5" points={current.daily.map((d,j) => `${x(j)},${y(d[key])}`).join(' ')}/>{current.daily.map((d,j) => <circle key={d.date} cx={x(j)} cy={y(d[key])} r="3" fill={color}><title>{t.analytics.columns[key]} · {d.date} · {fmt(d[key])}</title></circle>)}</g>)}
          {[0, Math.floor((days-1)/2), days-1].map(i => <text key={i} x={x(i)} y="259" textAnchor={i===0?'start':i===days-1?'end':'middle'}>{current.dates[i].slice(5)}</text>)}
        </svg>
        <div className="usage-legend">{SERIES.map(([key, color]) => <span key={key}><i style={{background:color}}/>{t.analytics.columns[key]}</span>)}</div>
      </article>
      <details className="usage-table-wrap"><summary>{t.analytics.daily}</summary><table><thead><tr><th>{t.usage.columns.date}</th>{COLUMNS.map(k => <th key={k}>{t.analytics.columns[k]}</th>)}</tr></thead><tbody>{[...current.daily].reverse().map(d => <tr key={d.date}><th>{d.date}</th>{COLUMNS.map(k => <td key={k}>{fmt(d[k])}</td>)}</tr>)}</tbody></table></details>
      <article className="usage-table-wrap"><h2>{t.analytics.features}</h2>{current.events.length === 0 ? <p className="muted">{t.analytics.noEvents}</p> :
        <table><thead><tr><th>{t.analytics.eventColumns.event}</th><th>{t.analytics.eventColumns.count}</th><th>{t.analytics.eventColumns.users}</th></tr></thead><tbody>{current.events.map(e => <tr key={e.name}><th>{t.analytics.events[e.name] ?? e.name}<small>{e.name}</small></th><td>{fmt(e.count)}</td><td>{fmt(e.users)}</td></tr>)}</tbody></table>}</article>
      <article className="usage-table-wrap"><h2>{t.analytics.platforms}</h2>{current.platforms.length === 0 ? <p className="muted">{t.analytics.noEvents}</p> :
        <table><thead><tr><th>{t.analytics.eventColumns.platform}</th><th>{t.analytics.eventColumns.count}</th><th>{t.analytics.eventColumns.users}</th></tr></thead><tbody>{current.platforms.map(p => <tr key={p.platform}><th>{t.analytics.platformNames[p.platform] ?? p.platform}</th><td>{fmt(p.events)}</td><td>{fmt(p.users)}</td></tr>)}</tbody></table>}</article>
      <p className="usage-note muted tiny">{t.analytics.sources(fmt(totals.sources.manual), fmt(totals.sources.schedule), fmt(totals.sources.gadget))}</p>
      <p className="usage-note muted tiny">{t.analytics.note(current.collectionStartedAt ? new Date(current.collectionStartedAt).toLocaleString(locale, {timeZone: current.timezone}) : null)}</p>
    </>}
    </div>
  </section>;
}
