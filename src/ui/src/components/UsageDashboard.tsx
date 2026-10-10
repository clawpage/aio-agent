import { InlineLoading } from "./Brand";
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { UsageReport } from '../../../common/usage';
import { locale, t } from '../i18n';

const fmt = (n: number) => n.toLocaleString(locale);
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : fmt(n);
const colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

export function UsageDashboard({ onExpired }: { onExpired: () => void }) {
  const [days, setDays] = useState(30), [account, setAccount] = useState('all');
  const [report, setReport] = useState<UsageReport | null>(null), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) return; busy = true;
      try { const data = await api.usage(days, controller.signal); if (!controller.signal.aborted) { setReport(data); setError(''); } }
      catch (err) { if (!controller.signal.aborted) { if (err instanceof ApiError && err.status === 401) onExpired(); else setError(err instanceof Error ? err.message : t.usage.readFailed); } }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [days, refresh, onExpired]);
  const current = report?.days === days ? report : null;
  const selected = current?.accounts.filter(a => account === 'all' || a.id === account) ?? [];
  const valid = selected.filter(a => a.available);
  const sum = (key: 'total' | 'input' | 'output' | 'cached' | 'cacheWrite') => valid.reduce((n,a) => n + a.totals[key], 0);
  const peak = Math.max(1, ...valid.flatMap(a => a.days.map(d => d.total)));
  const x = (i: number) => 100 + i * 760 / Math.max(1, days - 1);
  const y = (n: number) => 230 - n / peak * 190;
  return <section className="usage-dashboard" aria-labelledby="usage-title">
    <header className="chat-head"><div className="chat-title"><h2 id="usage-title">{t.usage.title}</h2><span className="task-list-sub muted tiny">{t.usage.subtitle}</span></div><div className="chat-head-actions"><button className="ghost" onClick={() => setRefresh(v => v + 1)}>{t.usage.refresh}</button></div></header>
    <div className="usage-body">
    <div className="usage-filters"><label>{t.usage.range}<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>{t.usage.lastDays(7)}</option><option value={30}>{t.usage.lastDays(30)}</option><option value={90}>{t.usage.lastDays(90)}</option></select></label><label>{t.usage.user}<select value={account} onChange={e => setAccount(e.target.value)}><option value="all">{t.usage.allUsers}</option>{report?.accounts.map(a => <option key={a.id} value={a.id}>{a.username}</option>)}</select></label></div>
    {error && <p className="banner error" role="alert">{t.usage.stale(error)}</p>}
    {!current ? <p><InlineLoading label={t.usage.loading}/></p> : <>
      <p className="muted tiny">{t.usage.meta(current.timezone, new Date(current.generatedAt).toLocaleTimeString(locale))}</p>
      {selected.some(a => !a.available) && <p className="banner error" role="alert">{t.usage.unavailable(selected.filter(a => !a.available).map(a => a.username))}</p>}
      <div className="usage-metrics">{(['total','input','output'] as const).map(key => <article key={key}><span className="muted">{t.usage.metrics[key]}</span><strong>{fmt(sum(key))}</strong>{key === 'input' && <span className="muted tiny">{t.usage.cacheBreakdown(fmt(sum('cached')), fmt(sum('cacheWrite')))}</span>}</article>)}</div>
      <article className="usage-chart"><h2>{t.usage.trend}</h2>{sum('total') === 0 && <p className="muted">{t.usage.noUsage}</p>}
        <svg viewBox="0 0 900 280" role="img" aria-label={t.usage.chartLabel}>
          {[0, .5, 1].map(v => <g key={v}><line x1="100" x2="860" y1={y(peak*v)} y2={y(peak*v)} stroke="var(--border)"/><text x="90" y={y(peak*v)+4} textAnchor="end">{compact(peak*v)}</text></g>)}
          {valid.map((a,i) => <g key={a.id}><polyline fill="none" stroke={colors[i%colors.length]} strokeWidth="2.5" strokeDasharray={i >= colors.length ? '6 3' : undefined} points={a.days.map((d,j) => `${x(j)},${y(d.total)}`).join(' ')}/>{a.days.map((d,j) => <circle key={d.date} cx={x(j)} cy={y(d.total)} r="3" fill={colors[i%colors.length]}><title>{a.username} · {d.date} · {fmt(d.total)} token</title></circle>)}</g>)}
          {[0, Math.floor((days-1)/2), days-1].map(i => <text key={i} x={x(i)} y="259" textAnchor={i===0?'start':i===days-1?'end':'middle'}>{current.dates[i].slice(5)}</text>)}
        </svg>
        <div className="usage-legend">{valid.map((a,i) => <span key={a.id}><i style={{background:colors[i%colors.length]}}/>{a.username}</span>)}</div>
      </article>
      <article className="usage-table-wrap"><h2>{t.usage.summary}</h2><table><thead><tr><th>{t.usage.columns.user}</th><th>{t.usage.columns.total}</th><th>{t.usage.columns.input}</th><th>{t.usage.columns.output}</th></tr></thead><tbody>{selected.map(a => <tr key={a.id}><th>{a.username}<small>{a.role === 'owner' ? t.usage.roles.owner : t.usage.roles.member}</small></th>{(['total','input','output'] as const).map(k => <td key={k}>{a.available ? fmt(a.totals[k]) : t.usage.notAvailable}</td>)}</tr>)}</tbody></table></article>
      <details className="usage-table-wrap"><summary>{t.usage.daily(account === 'all' ? t.usage.allUsersTotal : selected[0]?.username ?? '')}</summary><table><thead><tr><th>{t.usage.columns.date}</th><th>{t.usage.columns.total}</th><th>{t.usage.columns.input}</th><th>{t.usage.columns.output}</th></tr></thead><tbody>{[...current.dates].reverse().map(date => { const entries = valid.map(a => a.days.find(d => d.date === date)!); return <tr key={date}><th>{date}</th>{(['total','input','output'] as const).map(k => <td key={k}>{fmt(entries.reduce((n,d) => n+d[k],0))}</td>)}</tr>; })}</tbody></table></details>
      <p className="usage-note muted tiny">{t.usage.note}</p>
      <p className="usage-note muted tiny">{t.usage.historyNote}</p>
      <ul className="usage-coverage muted tiny">{selected.map(a => <li key={a.id}>{t.usage.coverage(a.username, a.collectionStartedAt ? new Date(a.collectionStartedAt).toLocaleString(locale, {timeZone:current.timezone}) : null, a.firstRecordAt ? new Date(a.firstRecordAt).toLocaleDateString(locale, {timeZone:current.timezone}) : null)}</li>)}</ul>
    </>}
    </div>
  </section>;
}
