import { InlineLoading } from "./Brand";
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import type { AnalyticsReport } from '../../../common/analytics';
import type { UsageReport } from '../../../common/usage';
import { locale, t } from '../i18n';

const fmt = (n: number) => n.toLocaleString(locale);
const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
const short = (n: number) => compact.format(n);
const pct = (part: number, whole: number) => !whole ? '—' : part > 0 && part / whole < 0.01 ? '<1%' : `${Math.round(part / whole * 100)}%`;
const ACCOUNT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-4)'];
const COLUMNS = ['active', 'signups', 'logins', 'tasks', 'completed', 'failed'] as const;
const TOKEN_KEYS = ['total', 'input', 'output'] as const;

/** A token figure in short form; the exact number is on hover. */
const Tokens = ({ n }: { n: number }) => <span title={fmt(n)}>{short(n)}</span>;

/** A table cell whose value sits on a bar showing its share of the column's largest value. */
const BarCell = ({ value, max, children }: { value: number; max: number; children: ReactNode }) =>
  <td><div className="dash-cell-bar"><b><i style={{ width: `${max ? value / max * 100 : 0}%` }}/></b><span>{children}</span></div></td>;

/** The smallest round number (1, 2, 5 × 10ⁿ) at or above `m`, so the axis top reads cleanly. */
function niceMax(m: number) {
  if (m <= 0) return 1;
  const k = 10 ** Math.floor(Math.log10(m));
  return [1, 2, 5, 10].map(s => s * k).find(v => v >= m)!;
}

type Series = { label: string; color: string; values: number[] };

/** Daily bars on their own scale (series stack); every day shows its figures on hover. */
function BarChart({ label, summary, dates, series, axis = fmt }: { label: string; summary: string; dates: string[]; series: Series[]; axis?: (n: number) => string }) {
  const n = dates.length;
  const top = niceMax(Math.max(0, ...dates.map((_, i) => series.reduce((s, x) => s + x.values[i], 0))));
  const gap = n > 45 ? 0.2 : 0.3;
  return <figure className="dash-chart">
    <figcaption><span>{label}</span><strong>{summary}</strong></figcaption>
    <div className="dash-plot">
      <span className="dash-y top">{axis(top)}</span><span className="dash-y zero">0</span>
      <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" role="img" aria-label={t.analytics.chartLabel(label)}>
        <line className="dash-grid" x1="0" x2={n} y1="0.5" y2="0.5" vectorEffect="non-scaling-stroke"/>
        <line className="dash-grid" x1="0" x2={n} y1="50" y2="50" vectorEffect="non-scaling-stroke"/>
        <line className="dash-base" x1="0" x2={n} y1="99.5" y2="99.5" vectorEffect="non-scaling-stroke"/>
        {dates.map((date, i) => {
          let y = 100;
          return <g key={date}><title>{[date, ...series.map(s => `${s.label} ${fmt(s.values[i])}`)].join('\n')}</title>
            <rect className="dash-hit" x={i} width="1" y="0" height="100"/>
            {series.map(s => { const h = s.values[i] / top * 100; y -= h; return h > 0 ? <rect key={s.label} x={i + gap / 2} width={1 - gap} y={y} height={h} fill={s.color}/> : null; })}
          </g>;
        })}
      </svg>
    </div>
    <div className="dash-x"><span>{dates[0]?.slice(5)}</span><span>{dates[Math.floor((n - 1) / 2)]?.slice(5)}</span><span>{dates[n - 1]?.slice(5)}</span></div>
    {series.length > 1 && <div className="usage-legend">{series.map(s => <span key={s.label}><i style={{ background: s.color }}/>{s.label}</span>)}</div>}
  </figure>;
}

/** The owner's dashboard: accounts, activity, tasks, token usage, feature use and platforms (src/control/analytics.ts, src/control/usage). */
export function AnalyticsDashboard({ onExpired }: { onExpired: () => void }) {
  const [days, setDays] = useState(30), [account, setAccount] = useState('all');
  const [product, setProduct] = useState<AnalyticsReport | null>(null), [usage, setUsage] = useState<UsageReport | null>(null);
  const [errors, setErrors] = useState<{ product?: string; usage?: string }>({});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const fail = (key: 'product' | 'usage', fallback: string) => (err: unknown) => {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 401) onExpired();
      else setErrors(e => ({ ...e, [key]: err instanceof Error ? err.message : fallback }));
    };
    const load = async () => {
      if (busy) return; busy = true;
      await Promise.all([
        api.analytics(days, controller.signal).then(d => { if (!controller.signal.aborted) { setProduct(d); setErrors(e => ({ ...e, product: '' })); } }, fail('product', t.analytics.readFailed)),
        api.usage(days, controller.signal).then(d => { if (!controller.signal.aborted) { setUsage(d); setErrors(e => ({ ...e, usage: '' })); } }, fail('usage', t.usage.readFailed)),
      ]);
      busy = false;
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [days, refresh, onExpired]);

  const p = product?.days === days ? product : null, u = usage?.days === days ? usage : null;
  const totals = p?.totals;
  const selected = u?.accounts.filter(a => account === 'all' || a.id === account) ?? [];
  const valid = selected.filter(a => a.available);
  const sum = (key: 'total' | 'input' | 'output' | 'cached') => valid.reduce((n, a) => n + a.totals[key], 0);
  const allValid = u?.accounts.filter(a => a.available) ?? [];
  const allTokens = allValid.reduce((n, a) => n + a.totals.total, 0);
  const ranked = [...selected].sort((a, b) => (b.available ? b.totals.total : -1) - (a.available ? a.totals.total : -1));
  const tz = p?.timezone ?? u?.timezone;
  const generated = Math.min(p?.generatedAt ?? Infinity, u?.generatedAt ?? Infinity);
  const tzDate = (ms: number | null, time: boolean) => ms ? (time ? new Date(ms).toLocaleString(locale, { timeZone: tz }) : new Date(ms).toLocaleDateString(locale, { timeZone: tz })) : null;
  const maxEvent = Math.max(0, ...(p?.events.map(e => e.count) ?? []));
  const maxPlatform = Math.max(0, ...(p?.platforms.map(x => x.users) ?? []));
  const maxTokens = Math.max(0, ...selected.filter(a => a.available).map(a => a.totals.total));

  return <section className="usage-dashboard" aria-labelledby="analytics-title">
    <header className="chat-head"><div className="chat-title"><h2 id="analytics-title">{t.analytics.title}</h2><span className="task-list-sub muted tiny">{t.analytics.subtitle}</span></div><div className="chat-head-actions"><button className="ghost" onClick={() => setRefresh(v => v + 1)}>{t.analytics.refresh}</button></div></header>
    <div className="usage-body">
    <div className="usage-filters"><label>{t.analytics.range}<select value={days} onChange={e => setDays(Number(e.target.value))}>{[7, 30, 90].map(n => <option key={n} value={n}>{t.analytics.lastDays(n)}</option>)}</select></label>
      {tz && <span className="muted tiny">{t.analytics.meta(tz, new Date(generated).toLocaleTimeString(locale))}</span>}</div>
    {errors.product && <p className="banner error" role="alert">{t.analytics.stale(errors.product)}</p>}
    {errors.usage && <p className="banner error" role="alert">{t.analytics.stale(errors.usage)}</p>}
    {!p && !u ? <p><InlineLoading label={t.analytics.loading}/></p> : <>
      <div className="usage-metrics analytics-metrics">
        {totals && p && <>
          <article><span className="muted">{t.analytics.metrics.accounts}</span><strong>{fmt(totals.accounts)}</strong><span className="muted tiny">{t.analytics.metrics.newInRange(fmt(totals.signups))}</span></article>
          <article><span className="muted">{t.analytics.metrics.active}</span><strong>{fmt(totals.activeToday)}</strong><span className="muted tiny">{t.analytics.metrics.activeWindows(fmt(totals.active7), fmt(totals.active30))}</span></article>
          <article><span className="muted">{t.analytics.metrics.tasks}</span><strong>{fmt(totals.tasks)}</strong><span className="muted tiny">{t.analytics.metrics.outcomes(pct(totals.completed, totals.tasks), fmt(totals.failed))}</span></article>
          <article><span className="muted">{t.analytics.metrics.conversion}</span><strong>{pct(p.funnel.signups, p.funnel.registerViews)}</strong><span className="muted tiny">{t.analytics.metrics.funnel(fmt(p.funnel.registerViews), fmt(p.funnel.signups))}</span></article>
        </>}
        {u && <article><span className="muted">{t.analytics.metrics.tokens}</span><strong><Tokens n={allTokens}/></strong><span className="muted tiny">{t.analytics.metrics.tokenSplit(short(allValid.reduce((n, a) => n + a.totals.input, 0)), short(allValid.reduce((n, a) => n + a.totals.output, 0)))}</span></article>}
      </div>

      {p && <section className="dash-section" aria-labelledby="dash-trend"><h2 id="dash-trend">{t.analytics.trend}</h2><div className="dash-charts">
        <BarChart label={t.analytics.columns.active} summary={t.analytics.avg((p.daily.reduce((n, d) => n + d.active, 0) / Math.max(1, p.daily.length)).toLocaleString(locale, { maximumFractionDigits: 1 }))} dates={p.dates} series={[{ label: t.analytics.columns.active, color: 'var(--chart-1)', values: p.daily.map(d => d.active) }]}/>
        <BarChart label={t.analytics.columns.tasks} summary={t.analytics.total(fmt(totals!.tasks))} dates={p.dates} series={[
          { label: t.analytics.columns.completed, color: 'var(--chart-2)', values: p.daily.map(d => d.completed) },
          { label: t.analytics.columns.failed, color: 'var(--chart-4)', values: p.daily.map(d => d.failed) },
          { label: t.analytics.otherTasks, color: 'var(--chart-1)', values: p.daily.map(d => Math.max(0, d.tasks - d.completed - d.failed)) },
        ]}/>
        <BarChart label={t.analytics.columns.signups} summary={t.analytics.total(fmt(totals!.signups))} dates={p.dates} series={[{ label: t.analytics.columns.signups, color: 'var(--chart-5)', values: p.daily.map(d => d.signups) }]}/>
      </div></section>}

      {u && <section className="usage-table-wrap dash-tokens" aria-labelledby="dash-tokens">
        <div className="dash-section-head"><h2 id="dash-tokens">{t.usage.title}</h2><label>{t.usage.user}<select value={account} onChange={e => setAccount(e.target.value)}><option value="all">{t.usage.allUsers}</option>{u.accounts.map(a => <option key={a.id} value={a.id}>{a.username}</option>)}</select></label></div>
        {selected.some(a => !a.available) && <p className="banner error" role="alert">{t.usage.unavailable(selected.filter(a => !a.available).map(a => a.username))}</p>}
        {sum('total') === 0 ? <p className="muted">{t.usage.noUsage}</p> :
          <BarChart label={t.usage.chart} summary={t.analytics.total(short(sum('total')))} axis={short} dates={u.dates} series={valid.map((a, i) => ({ label: a.username, color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length], values: a.days.map(d => d.total) }))}/>}
        <table><thead><tr><th>{t.usage.columns.user}</th><th>{t.usage.columns.total}</th><th>{t.usage.columns.share}</th><th>{t.usage.columns.input}</th><th className="dash-wide">{t.usage.columns.cached}</th><th>{t.usage.columns.output}</th></tr></thead>
          <tbody>{ranked.map(a => <tr key={a.id}><th>{a.username}<small>{a.role === 'owner' ? t.usage.roles.owner : t.usage.roles.member}</small></th>
            {a.available ? <>
              <BarCell value={a.totals.total} max={maxTokens}><Tokens n={a.totals.total}/></BarCell>
              <td>{pct(a.totals.total, allTokens)}</td>
              <td><Tokens n={a.totals.input}/></td><td className="dash-wide"><Tokens n={a.totals.cached}/></td><td><Tokens n={a.totals.output}/></td>
            </> : <td colSpan={5}>{t.usage.notAvailable}</td>}</tr>)}</tbody></table>
        <details><summary>{t.usage.daily(account === 'all' ? t.usage.allUsersTotal : selected[0]?.username ?? '')}</summary><table><thead><tr><th>{t.usage.columns.date}</th>{TOKEN_KEYS.map(k => <th key={k}>{t.usage.columns[k]}</th>)}</tr></thead><tbody>{[...u.dates].reverse().map(date => { const entries = valid.map(a => a.days.find(d => d.date === date)!); return <tr key={date}><th>{date}</th>{TOKEN_KEYS.map(k => <td key={k}><Tokens n={entries.reduce((n, d) => n + d[k], 0)}/></td>)}</tr>; })}</tbody></table></details>
      </section>}

      {p && <div className="dash-pair">
        <article className="usage-table-wrap"><h2>{t.analytics.features}</h2>{p.events.length === 0 ? <p className="muted">{t.analytics.noEvents}</p> :
          <table><thead><tr><th>{t.analytics.eventColumns.event}</th><th>{t.analytics.eventColumns.count}</th><th>{t.analytics.eventColumns.users}</th></tr></thead><tbody>{[...p.events].sort((a, b) => b.count - a.count).map(e => <tr key={e.name}><th>{t.analytics.events[e.name] ?? e.name}{t.analytics.events[e.name] && <small>{e.name}</small>}</th><BarCell value={e.count} max={maxEvent}>{fmt(e.count)}</BarCell><td>{fmt(e.users)}</td></tr>)}</tbody></table>}</article>
        <article className="usage-table-wrap"><h2>{t.analytics.platforms}</h2>{p.platforms.length === 0 ? <p className="muted">{t.analytics.noEvents}</p> :
          <table><thead><tr><th>{t.analytics.eventColumns.platform}</th><th>{t.analytics.eventColumns.users}</th><th>{t.analytics.eventColumns.count}</th></tr></thead><tbody>{[...p.platforms].sort((a, b) => b.users - a.users).map(x => <tr key={x.platform}><th>{t.analytics.platformNames[x.platform] ?? x.platform}</th><BarCell value={x.users} max={maxPlatform}>{fmt(x.users)}</BarCell><td>{fmt(x.events)}</td></tr>)}</tbody></table>}</article>
      </div>}

      {p && <details className="usage-table-wrap"><summary>{t.analytics.daily}</summary><table><thead><tr><th>{t.usage.columns.date}</th>{COLUMNS.map(k => <th key={k}>{t.analytics.columns[k]}</th>)}</tr></thead><tbody>{[...p.daily].reverse().map(d => <tr key={d.date}><th>{d.date}</th>{COLUMNS.map(k => <td key={k}>{fmt(d[k])}</td>)}</tr>)}</tbody></table></details>}

      <details className="usage-table-wrap dash-notes"><summary>{t.analytics.methodology}</summary>
        {p && <p className="usage-note muted tiny">{t.analytics.sources(fmt(p.totals.sources.manual), fmt(p.totals.sources.schedule), fmt(p.totals.sources.gadget))}</p>}
        {p && <p className="usage-note muted tiny">{t.analytics.note(tzDate(p.collectionStartedAt, true))}</p>}
        {u && <p className="usage-note muted tiny">{t.usage.note}</p>}
        {u && <p className="usage-note muted tiny">{t.usage.historyNote}</p>}
        {u && <ul className="usage-coverage muted tiny">{u.accounts.map(a => <li key={a.id}>{t.usage.coverage(a.username, tzDate(a.collectionStartedAt, true), tzDate(a.firstRecordAt, false))}</li>)}</ul>}
      </details>
    </>}
    </div>
  </section>;
}
