import { InlineLoading } from "./Brand";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';
import { PopupPresence, PopupSurface } from './PopupMotion';
import { FEATURES, type AccountRow, type ActiveAccount, type AnalyticsReport, type FunnelEntry, type PeriodTotals } from '../../../common/analytics';
import type { AccountUsage, UsageReport } from '../../../common/usage';
import type { DashChartSpec, DashSeries } from '../dashboardCharts';
import type { MountedChart } from '../chartRender';
import { locale, t } from '../i18n';

const fmt = (n: number) => n.toLocaleString(locale);
const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
const short = (n: number) => compact.format(n);
const one = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 });
/** An estimated cost in US dollars (src/control/usage.ts PRICES). */
const usd = (n: number) => n.toLocaleString(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 });
const pct = (part: number, whole: number) => !whole ? '—' : part > 0 && part / whole < 0.01 ? '<1%' : `${Math.round(part / whole * 100)}%`;
const unit = (u: 'second' | 'minute' | 'hour') => new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: 1 });
const SECOND = unit('second'), MINUTE = unit('minute'), HOUR = unit('hour');
/** A task's duration in the largest unit that keeps it readable. */
const duration = (ms: number | null) => ms === null ? '—' : ms < 60_000 ? SECOND.format(Math.round(ms / 1000)) : ms < 3_600_000 ? MINUTE.format(ms / 60_000) : HOUR.format(ms / 3_600_000);
const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
function ago(ms: number, now: number) {
  const s = Math.round((ms - now) / 1000);
  for (const [limit, size, u] of [[60, 1, 'second'], [3600, 60, 'minute'], [86400, 3600, 'hour'], [Infinity, 86400, 'day']] as const) {
    if (Math.abs(s) < limit) return relative.format(Math.round(s / size), u);
  }
  return '';
}
const RANGES = [7, 30, 90] as const;
const a = () => t.analytics;

/* ---------------------------------------------------------------- change vs the previous period */

type Change = { text: string; tone: 'good' | 'bad' | 'flat'; label: string } | null;
/** A count's change in percent; `upIsGood` decides which way is good. */
function countChange(cur: number, prev: number, upIsGood = true): Change {
  if (!cur && !prev) return { text: a().deltaSame, tone: 'flat', label: a().deltaSame };
  if (!prev) return { text: a().deltaNew, tone: upIsGood ? 'good' : 'bad', label: a().deltaNew };
  const r = (cur - prev) / prev;
  if (Math.abs(r) < 0.005) return { text: a().deltaSame, tone: 'flat', label: a().deltaSame };
  const up = r > 0, size = `${Math.round(Math.abs(r) * 100)}%`;
  return { text: `${up ? '▲' : '▼'} ${size}`, tone: up === upIsGood ? 'good' : 'bad', label: `${up ? a().up : a().down} ${size}` };
}
/** A rate's change in percentage points. */
function rateChange(cur: number | null, prev: number | null): Change {
  if (cur === null || prev === null) return null;
  const d = Math.sign(cur - prev) * Math.round(Math.abs(cur - prev) * 1000) / 10;
  if (Math.abs(d) < 0.5) return { text: a().deltaSame, tone: 'flat', label: a().deltaSame };
  const n = one(Math.abs(d));
  return { text: `${d > 0 ? '▲' : '▼'} ${a().points(n)}`, tone: d > 0 ? 'good' : 'bad', label: `${d > 0 ? a().up : a().down} ${a().points(n)}` };
}
const rate = (p: PeriodTotals | undefined) => p && p.tasks ? p.completed / p.tasks : null;

function Kpi({ label, value, sub, change, days, onClick, buttonRef, more }: { label: string; value: ReactNode; sub?: ReactNode; change?: Change; days: number; onClick?: () => void; buttonRef?: Ref<HTMLButtonElement>; more?: string }) {
  const body = <>
    <span className="dash-kpi-label">{label}</span>
    <strong className="dash-kpi-value">{value}</strong>
    {change && <span className={`dash-delta ${change.tone}`} title={a().vsPrevious(days)} aria-label={`${change.label} · ${a().vsPrevious(days)}`}>{change.text}</span>}
    {sub && <span className="dash-kpi-sub">{sub}</span>}
    {more && <span className="dash-kpi-more">{more}</span>}
  </>;
  return onClick
    ? <button ref={buttonRef} type="button" className="dash-kpi dash-kpi-button" aria-haspopup="dialog" onClick={onClick}>{body}</button>
    : <article className="dash-kpi">{body}</article>;
}

/* ---------------------------------------------------------------- charts */

/** ECharts is large: loaded once the dashboard draws its first chart (with chartRender.ts, shared with message charts). */
let loading: Promise<typeof import('../dashboardCharts')> | null = null;
function renderer() {
  loading ??= import('../dashboardCharts');
  loading.catch(() => { loading = null; });
  return loading;
}

/** One daily chart: a title and its headline figure, the plot, and a legend when it has more than one series. */
function DashChart({ label, summary, spec }: { label: string; summary: string; spec: DashChartSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'drawing' | 'ready' | 'failed'>('drawing');
  useEffect(() => {
    let live = true, mounted: MountedChart | null = null;
    renderer().then(({ mountDashChart }) => {
      if (!live || !host.current) return;
      mounted = mountDashChart(host.current, spec);
      setState('ready');
    }).catch(() => { if (live) setState('failed'); });
    return () => { live = false; mounted?.dispose(); };
  }, [spec]);
  return <figure className="dash-chart" role="img" aria-label={a().charts.label(label)}>
    <figcaption><span>{label}</span><strong>{summary}</strong></figcaption>
    <div className="dash-canvas-wrap">
      <div ref={host} className="dash-canvas" data-state={state}/>
      {state !== 'ready' && <span className="dash-canvas-status muted tiny">{state === 'drawing' ? a().charts.drawing : a().charts.failedToDraw}</span>}
    </div>
    {spec.series.length > 1 && <div className="dash-legend">{spec.series.map(s => <span key={s.name}><i className={s.type === 'line' ? 'line' : undefined} style={{ background: `var(${s.color})` }}/>{s.name}</span>)}</div>}
  </figure>;
}

/* ---------------------------------------------------------------- sections */

/** A horizontal bar: its share of the largest value, in the dashboard's one series hue. */
const Bar = ({ value, max }: { value: number; max: number }) => <b className="dash-bar" aria-hidden="true"><i style={{ width: `${max ? Math.max(value ? 2 : 0, value / max * 100) : 0}%` }}/></b>;

function Section({ id, title, aside, children, className = '' }: { id: string; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`dash-card ${className}`} aria-labelledby={id}>
    <div className="dash-card-head"><h2 id={id}>{title}</h2>{aside}</div>
    {children}
  </section>;
}

function Funnel({ steps }: { steps: FunnelEntry[] }) {
  const f = a().funnel;
  const by = Object.fromEntries(steps.map(s => [s.step, s]));
  const signups = by.signup?.count ?? 0;
  const max = Math.max(1, ...steps.map(s => s.eligible ?? s.count));
  if (!signups && !by.register_view?.count) return <p className="muted">{f.empty}</p>;
  return <>
    <ol className="dash-funnel">{steps.map((s, i) => {
      const prev = steps[i - 1];
      const note = s.eligible !== null ? f.ofEligible(pct(s.count, s.eligible), fmt(s.eligible))
        : s.step === 'register_view' ? '' : s.step === 'signup' ? f.ofPrevious(pct(s.count, prev?.count ?? 0))
        : `${f.ofPrevious(pct(s.count, prev?.count ?? 0))} · ${f.ofSignups(pct(s.count, signups))}`;
      return <li key={s.step}>
        <div className="dash-row-head"><span>{f.steps[s.step] ?? s.step}</span><strong>{fmt(s.count)}</strong></div>
        <Bar value={s.count} max={max}/>
        {note && <span className="muted tiny">{note}</span>}
      </li>;
    })}</ol>
    <p className="dash-note muted tiny">{f.note}</p>
  </>;
}

function Retention({ cohorts }: { cohorts: NonNullable<AnalyticsReport['cohorts']> }) {
  const r = a().retention;
  if (!cohorts.length) return <p className="muted">{r.empty}</p>;
  const cell = (x: { eligible: number; retained: number }) => x.eligible === 0
    ? <td className="dash-heat muted">{r.notYet}</td>
    // Darker is more: one hue, its strength the share that came back (capped so the text stays legible).
    : <td className="dash-heat" style={{ background: `color-mix(in srgb, var(--dash-series) ${Math.round(x.retained / x.eligible * 45)}%, transparent)` }}>
      <strong>{pct(x.retained, x.eligible)}</strong><small>{fmt(x.retained)}/{fmt(x.eligible)}</small></td>;
  return <div className="dash-table-scroll"><table className="dash-table dash-retention">
    <thead><tr><th scope="col">{r.columns.cohort}</th><th scope="col">{r.columns.size}</th><th scope="col">{r.columns.d1}</th><th scope="col">{r.columns.d7}</th></tr></thead>
    <tbody>{[...cohorts].reverse().map(c => <tr key={c.start}><th scope="row">{r.week(c.start.slice(5))}</th><td>{fmt(c.size)}</td>{cell(c.d1)}{cell(c.d7)}</tr>)}</tbody>
  </table></div>;
}

function Features({ report }: { report: AnalyticsReport }) {
  const f = a().features;
  const order = new Map(FEATURES.map((x, i) => [x, i]));
  const used = (report.features ?? []).filter(x => x.users || x.count).sort((x, y) => y.users - x.users || y.count - x.count || order.get(x.feature)! - order.get(y.feature)!);
  const unused = (report.features ?? []).filter(x => !x.users && !x.count);
  const active = report.current?.active ?? 0;
  const max = Math.max(1, ...used.map(x => x.users));
  // The welcome cards are named by the cards' own titles in this language.
  const cards = t.feed.empty.features, starters = t.feed.empty.starters;
  const cardName = (key: string) => {
    const [kind, id] = key.split(':');
    if (kind === 'starter') return starters[Number(id)]?.label ?? f.starter(Number(id) + 1);
    return cards.find(c => c.icon === id)?.title ?? id ?? key;
  };
  return <>
    {used.length === 0 ? <p className="muted">{a().noEvents}</p> : <ul className="dash-bars dash-bars-2">{used.map(x => {
      const change = countChange(x.users, x.prevUsers);
      return <li key={x.feature}>
        <div className="dash-row-head"><span>{f.names[x.feature] ?? x.feature}</span><strong title={f.columns.users}>{fmt(x.users)}</strong></div>
        <Bar value={x.users} max={max}/>
        <span className="muted tiny">{f.share(pct(x.users, active))} · {f.uses(fmt(x.count))}{change && <> · <span className={`dash-delta ${change.tone}`} aria-label={`${change.label} · ${a().vsPrevious(report.days)}`}>{change.text}</span></>}</span>
      </li>;
    })}</ul>}
    {unused.length > 0 && <p className="muted tiny dash-unused">{f.unused}: {unused.map(x => f.names[x.feature] ?? x.feature).join(a().activeList.separator)}</p>}
    {report.welcomeCards && report.welcomeCards.length > 0 && <div className="dash-sub">
      <h3>{f.welcome}</h3>
      <ul className="dash-chips">{report.welcomeCards.map(w => <li key={w.card}><span>{cardName(w.card)}</span><span className="muted tiny">{f.taps(fmt(w.count), fmt(w.users))}</span></li>)}</ul>
    </div>}
    <p className="dash-note muted tiny">{f.note}</p>
  </>;
}

function Platforms({ report }: { report: AnalyticsReport }) {
  const p = a().platforms;
  const names = a().platformNames;
  const rows = [...report.platforms].sort((x, y) => y.users - x.users || y.events - x.events);
  const max = Math.max(1, ...rows.map(x => x.users));
  return <>
    {rows.length === 0 ? <p className="muted">{a().noEvents}</p> : <ul className="dash-bars">{rows.map(x => <li key={x.platform}>
      <div className="dash-row-head"><span>{names[x.platform] ?? x.platform}</span><span className="dash-row-figures"><strong>{fmt(x.users)}</strong><span className="muted tiny">{a().eventColumns.count} {fmt(x.events)}</span></span></div>
      <Bar value={x.users} max={max}/>
    </li>)}</ul>}
    <div className="dash-sub"><h3>{p.versions}</h3>
      {report.versions?.length ? <ul className="dash-chips">{report.versions.map(v => <li key={`${v.platform}-${v.version}`}><span>{p.version(names[v.platform] ?? v.platform, v.version, fmt(v.users))}</span></li>)}</ul>
        : <p className="muted tiny">{p.noVersions}</p>}</div>
  </>;
}

function Quality({ quality }: { quality: NonNullable<AnalyticsReport['quality']> }) {
  const q = a().quality;
  const o = quality.outcomes;
  const parts: Array<{ key: string; n: number; color: DashSeries['color']; label: string }> = [
    { key: 'completed', n: o.completed, color: '--dash-good', label: q.outcomes.completed },
    { key: 'other', n: o.other, color: '--dash-series', label: q.outcomes.other },
    { key: 'interrupted', n: o.interrupted, color: '--dash-context', label: q.outcomes.interrupted },
    { key: 'failed', n: o.failed + o.unknown, color: '--dash-bad', label: q.outcomes.failed },
  ];
  const total = parts.reduce((s, x) => s + x.n, 0);
  return <>
    {total === 0 ? <p className="muted">{q.noTasks}</p> : <>
      <div className="dash-stack" role="img" aria-label={parts.map(x => q.share(x.label, fmt(x.n), pct(x.n, total))).join(', ')}>
        {parts.filter(x => x.n).map(x => <i key={x.key} style={{ flexGrow: x.n, background: `var(${x.color})` }} title={q.share(x.label, fmt(x.n), pct(x.n, total))}/>)}
      </div>
      <div className="dash-legend">{parts.map(x => <span key={x.key}><i style={{ background: `var(${x.color})` }}/>{q.share(x.label, fmt(x.n), pct(x.n, total))}</span>)}</div>
    </>}
    <dl className="dash-stats">
      <div><dt>{q.failRate}</dt><dd>{pct(o.failed + o.unknown, total)}</dd></div>
      <div><dt>{q.interrupted}</dt><dd>{pct(o.interrupted, total)}</dd></div>
      <div><dt>{q.median}</dt><dd>{duration(quality.medianMs)}</dd></div>
      <div><dt>{q.p90}</dt><dd>{duration(quality.p90Ms)}</dd></div>
      <div><dt>{q.signals.stops}</dt><dd>{fmt(quality.stops)}</dd></div>
      <div><dt>{q.signals.retries}</dt><dd>{fmt(quality.retries)}</dd></div>
      <div><dt>{q.signals.reports}</dt><dd>{fmt(quality.reports)}</dd></div>
      <div><dt>{q.signals.restoreFailures}</dt><dd>{fmt(quality.restoreFailures)}
        {/* Whose browser, and at what step: enough to tell one account's stuck page from a fault everyone hits. */}
        {quality.restoreAccounts?.length ? <small className="dash-restore-detail">{quality.restoreAccounts.map(x => `${x.username} ${fmt(x.count)}`).join(a().activeList.separator)}<br/>
          {Object.entries(quality.restoreReasons ?? {}).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${q.restoreReasons[k] ?? k} ${fmt(n)}`).join(a().activeList.separator)}</small> : null}</dd></div>
    </dl>
  </>;
}

type SortKey = 'account' | 'lastSeen' | 'activeDays' | 'sessions' | 'tasks' | 'completion' | 'tokens' | 'cost';
/** Every account in one table: what it did, and the tokens it used (owner only: an estimated cost and today's share of the limit). */
function Accounts({ rows, usage, now, total }: { rows: AccountRow[]; usage: Map<string, AccountUsage> | null; now: number; total: number }) {
  const c = a().accounts;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'lastSeen', desc: true });
  const value = (r: AccountRow, key: SortKey): number | string => {
    switch (key) {
      case 'account': return r.username.toLowerCase();
      case 'lastSeen': return r.lastSeenAt ?? -1;
      case 'activeDays': return r.activeDays;
      case 'sessions': return r.sessions;
      case 'tasks': return r.tasks;
      case 'completion': return r.tasks ? r.completed / r.tasks : -1;
      case 'tokens': return usage?.get(r.id)?.totals.total ?? -1;
      case 'cost': return usage?.get(r.id)?.totals.usd ?? -1;
    }
  };
  const shown = rows.filter(r => r.username.toLowerCase().includes(query.trim().toLowerCase())).sort((x, y) => {
    const vx = value(x, sort.key), vy = value(y, sort.key);
    const cmp = typeof vx === 'string' ? vx.localeCompare(String(vy)) : vx - (vy as number);
    return (sort.desc ? -cmp : cmp) || x.username.localeCompare(y.username);
  });
  const head = (key: SortKey, wide = false) => {
    const label = key === 'cost' ? t.usage.columns.cost : c.columns[key];
    const on = sort.key === key;
    return <th scope="col" className={wide ? 'dash-wide' : undefined} aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="dash-sort" aria-label={c.sort(label)} onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'account' }))}>{label}<span aria-hidden="true">{on ? (sort.desc ? ' ↓' : ' ↑') : ''}</span></button>
    </th>;
  };
  return <>
    <div className="dash-table-tools">
      <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={c.search} aria-label={c.search}/>
      <span className="muted tiny">{c.count(fmt(shown.length), fmt(total))}</span>
    </div>
    <div className="dash-table-scroll"><table className="dash-table dash-accounts">
      <thead><tr>{head('account')}{head('lastSeen')}{head('activeDays')}{head('sessions', true)}{head('tasks')}{head('completion')}{usage && <>{head('tokens')}<th scope="col" className="dash-wide">{t.usage.columns.input}</th><th scope="col" className="dash-wide">{t.usage.columns.cached}</th><th scope="col" className="dash-wide">{t.usage.columns.output}</th>{head('cost')}<th scope="col">{t.usage.columns.quota}</th></>}<th scope="col" className="dash-wide dash-text">{c.columns.platforms}</th><th scope="col" className="dash-wide dash-text">{c.columns.model}</th></tr></thead>
      <tbody>{shown.map(r => <tr key={r.id}>
        <th scope="row">{r.username}<small>{r.role === 'owner' ? t.usage.roles.owner : t.usage.roles.member}</small></th>
        <td>{r.lastSeenAt ? <time dateTime={new Date(r.lastSeenAt).toISOString()} title={new Date(r.lastSeenAt).toLocaleString(locale)}>{ago(r.lastSeenAt, now)}</time> : <span className="muted">{c.never}</span>}</td>
        <td>{fmt(r.activeDays)}</td>
        <td className="dash-wide">{fmt(r.sessions)}</td>
        <td>{fmt(r.tasks)}</td>
        <td>{pct(r.completed, r.tasks)}</td>
        {usage && <UsageCells x={usage.get(r.id)}/>}
        <td className="dash-wide dash-text">{r.platforms.map(p => a().platformNames[p] ?? p).join(a().activeList.separator) || '—'}</td>
        <td className="dash-wide dash-text">{r.model ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>
    {shown.length === 0 && <p className="muted">{c.empty}</p>}
  </>;
}

/** An account's token columns; a dash where its ledger could not be read or it has none. */
function UsageCells({ x }: { x: AccountUsage | undefined }) {
  if (!x?.available) return <><td>—</td><td className="dash-wide">—</td><td className="dash-wide">—</td><td className="dash-wide">—</td><td>—</td><td>—</td></>;
  const n = (v: number) => <span title={fmt(v)}>{short(v)}</span>;
  return <>
    <td>{n(x.totals.total)}</td><td className="dash-wide">{n(x.totals.input)}</td><td className="dash-wide">{n(x.totals.cached)}</td><td className="dash-wide">{n(x.totals.output)}</td>
    <td>{x.totals.usd == null ? <span className="muted" title={x.model ?? undefined}>{t.usage.columns.noPrice}</span> : <span title={x.model ?? undefined}>{usd(x.totals.usd)}</span>}</td>
    <td>{x.quota ? <span title={`${fmt(x.quota.used)} / ${fmt(x.quota.limit)}`}>{pct(x.quota.used, x.quota.limit)}</span> : '—'}</td>
  </>;
}

/** Who was active today: one line each, latest first, with what they did and where. */
function ActiveTodayDialog({ accounts, timezone, onClose }: { accounts: ActiveAccount[] | undefined; timezone: string; onClose: () => void }) {
  const l = a().activeList;
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(<PopupSurface className="modal-backdrop" onClick={onClose}>
    <div className="modal dash-active" role="dialog" aria-modal="true" aria-labelledby="dash-active-title" onClick={e => e.stopPropagation()}>
      <h3 id="dash-active-title">{l.title(fmt(accounts?.length ?? 0))}</h3>
      {!accounts ? <p className="muted">{l.unsupported}</p> : accounts.length === 0 ? <p className="muted">{l.empty}</p> :
        <ul>{accounts.map((x, i) => <li key={`${x.username ?? ''}-${i}`}>
          <div><strong>{x.username ?? l.deleted}</strong>{x.role && <small>{x.role === 'owner' ? t.usage.roles.owner : t.usage.roles.member}</small>}
            <time className="muted" dateTime={new Date(x.lastSeenAt).toISOString()}>{l.lastSeen(new Date(x.lastSeenAt).toLocaleTimeString(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit' }))}</time></div>
          <p className="muted tiny">{[l.events(fmt(x.events)), l.tasks(fmt(x.tasks)), ...(x.platforms.length ? [x.platforms.map(p => a().platformNames[p] ?? p).join(l.separator)] : [])].join(' · ')}</p>
        </li>)}</ul>}
      <div className="modal-actions"><button className="ghost" onClick={onClose} autoFocus>{l.close}</button></div>
    </div>
  </PopupSurface>, document.body);
}

/* ---------------------------------------------------------------- the page */

/**
 * The owner's dashboard (src/control/analytics.ts, src/control/usage): an overview with the change against the
 * period before, daily trends, the activation funnel and new accounts' retention, feature use, platforms, task
 * quality, every account and token usage. One range above everything scopes it all.
 */
export function AnalyticsDashboard({ onExpired }: { onExpired: () => void }) {
  const [days, setDays] = useState(30);
  const [product, setProduct] = useState<AnalyticsReport | null>(null), [usage, setUsage] = useState<UsageReport | null>(null);
  const [errors, setErrors] = useState<{ product?: string; usage?: string }>({});
  const [refresh, setRefresh] = useState(0);
  const [showActive, setShowActive] = useState(false);
  const activeButton = useRef<HTMLButtonElement>(null);
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
        api.analytics(days, controller.signal).then(d => { if (!controller.signal.aborted) { setProduct(d); setErrors(e => ({ ...e, product: '' })); } }, fail('product', a().readFailed)),
        api.usage(days, controller.signal).then(d => { if (!controller.signal.aborted) { setUsage(d); setErrors(e => ({ ...e, usage: '' })); } }, fail('usage', t.usage.readFailed)),
      ]);
      busy = false;
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [days, refresh, onExpired]);

  // A new range keeps the last figures on screen, dimmed, until its own arrive.
  const p = product, u = usage;
  const stale = (p && p.days !== days) || (u && u.days !== days);
  const tz = p?.timezone ?? u?.timezone;
  const generated = Math.min(p?.generatedAt ?? Infinity, u?.generatedAt ?? Infinity);
  const valid = u?.accounts.filter(x => x.available) ?? [];
  const tokenTotal = valid.reduce((n, x) => n + x.totals.total, 0);
  const costTotal = valid.reduce((n, x) => n + (x.totals.usd ?? 0), 0);
  const usageOf = u ? new Map(u.accounts.map(x => [x.id, x])) : null;
  const c = a().charts;

  const charts = useMemo(() => {
    if (!p) return null;
    const x = p.dates;
    const series = (name: string, values: number[], color: DashSeries['color'], type: DashSeries['type'] = 'bar', stack = false): DashSeries => ({ name, values, color, type, stack });
    return {
      active: { x, format: fmt, series: [series(c.dau, p.daily.map(d => d.active), '--dash-series'), ...(p.daily.every(d => d.wau !== undefined) ? [series(c.wau, p.daily.map(d => d.wau ?? 0), '--dash-context', 'line')] : [])] },
      // Good at the base, bad on top, the working ones between: the two outcome colors never touch.
      tasks: { x, format: fmt, series: [series(c.completed, p.daily.map(d => d.completed), '--dash-good', 'bar', true), series(c.other, p.daily.map(d => Math.max(0, d.tasks - d.completed - d.failed)), '--dash-series', 'bar', true), series(c.failed, p.daily.map(d => d.failed), '--dash-bad', 'bar', true)] },
      signups: { x, format: fmt, series: [series(c.signups, p.daily.map(d => d.signups), '--dash-series')] },
    } satisfies Record<string, DashChartSpec>;
  }, [p, c]);
  const tokenChart = useMemo<DashChartSpec | null>(() => {
    if (!u) return null;
    const counted = u.accounts.filter(x => x.available);
    return { x: u.dates, format: short, series: [{ name: c.tokens, type: 'bar', color: '--dash-series', values: u.dates.map((_, i) => counted.reduce((n, acc) => n + (acc.days[i]?.total ?? 0), 0)) }] };
  }, [u, c]);

  const cur = p?.current, prev = p?.previous;
  const engaged = p?.accounts?.filter(x => x.activeDays > 0) ?? [];
  const now = p?.generatedAt ?? Date.now();

  return <section className="usage-dashboard" aria-labelledby="analytics-title">
    <header className="chat-head"><div className="chat-title"><h2 id="analytics-title">{a().title}</h2><span className="task-list-sub muted tiny">{a().subtitle}</span></div><div className="chat-head-actions"><button className="ghost" onClick={() => setRefresh(v => v + 1)}>{a().refresh}</button></div></header>
    <div className="usage-body dash-body">
      <div className="dash-toolbar">
        <div className="dash-range" role="radiogroup" aria-label={a().range}>{RANGES.map(n => <button key={n} type="button" role="radio" aria-checked={days === n} className={days === n ? 'on' : undefined} onClick={() => setDays(n)}>{a().lastDays(n)}</button>)}</div>
        {tz && <span className="muted tiny">{a().meta(tz, new Date(generated).toLocaleTimeString(locale))}</span>}
      </div>
      {errors.product && <p className="banner error" role="alert">{a().stale(errors.product)}</p>}
      {errors.usage && <p className="banner error" role="alert">{a().stale(errors.usage)}</p>}
      {p && !cur && <p className="banner">{a().olderControl}</p>}
      {!p && !u ? <p><InlineLoading label={a().loading}/></p> : <div className={`dash-content${stale ? ' is-refreshing' : ''}`} aria-busy={stale ? true : undefined}>

        <section className="dash-overview" aria-labelledby="dash-overview"><h2 id="dash-overview" className="dash-sr-only">{a().sections.overview}</h2><div className="dash-kpis">
          {p && cur && prev && <>
            <Kpi days={p.days} label={a().kpi.active} value={fmt(cur.active)} change={countChange(cur.active, prev.active)} sub={a().kpi.activeSub(fmt(p.totals.activeToday), fmt(p.totals.active7), fmt(p.totals.active30))}/>
            <Kpi days={p.days} label={a().kpi.today} value={fmt(p.totals.activeToday)} sub={a().kpi.todaySub(pct(p.totals.activeToday, p.totals.active30))} onClick={() => setShowActive(true)} buttonRef={activeButton} more={a().activeList.open}/>
            <Kpi days={p.days} label={a().kpi.signups} value={fmt(cur.signups)} change={countChange(cur.signups, prev.signups)} sub={a().kpi.signupsSub(fmt(p.totals.accounts))}/>
            <Kpi days={p.days} label={a().kpi.tasks} value={fmt(cur.tasks)} change={countChange(cur.tasks, prev.tasks)} sub={a().kpi.tasksSub(fmt(p.totals.sources.manual), fmt(p.totals.sources.schedule), fmt(p.totals.sources.gadget))}/>
            <Kpi days={p.days} label={a().kpi.completion} value={pct(cur.completed, cur.tasks)} change={rateChange(rate(cur), rate(prev))} sub={a().kpi.completionSub(fmt(cur.failed), fmt(cur.interrupted))}/>
            <Kpi days={p.days} label={a().kpi.duration} value={duration(cur.medianTaskMs)} change={cur.medianTaskMs !== null && prev.medianTaskMs !== null ? countChange(cur.medianTaskMs, prev.medianTaskMs, false) : null} sub={a().kpi.durationSub(duration(p.quality?.p90Ms ?? null))}/>
            <Kpi days={p.days} label={a().kpi.sessions} value={fmt(cur.sessions)} change={countChange(cur.sessions, prev.sessions)} sub={a().kpi.sessionsSub(one(cur.active ? cur.sessions / cur.active : 0), one(engaged.length ? engaged.reduce((n, x) => n + x.activeDays, 0) / engaged.length : 0))}/>
          </>}
          {p && !cur && <>
            <Kpi days={p.days} label={a().kpi.signups} value={fmt(p.totals.signups)} sub={a().kpi.signupsSub(fmt(p.totals.accounts))}/>
            <Kpi days={p.days} label={a().kpi.today} value={fmt(p.totals.activeToday)} sub={a().kpi.activeSub(fmt(p.totals.activeToday), fmt(p.totals.active7), fmt(p.totals.active30))} onClick={() => setShowActive(true)} buttonRef={activeButton} more={a().activeList.open}/>
            <Kpi days={p.days} label={a().kpi.tasks} value={fmt(p.totals.tasks)} sub={a().kpi.tasksSub(fmt(p.totals.sources.manual), fmt(p.totals.sources.schedule), fmt(p.totals.sources.gadget))}/>
            <Kpi days={p.days} label={a().kpi.completion} value={pct(p.totals.completed, p.totals.tasks)}/>
          </>}
          {u && <Kpi days={u.days} label={a().kpi.tokens} value={<span title={fmt(tokenTotal)}>{short(tokenTotal)}</span>} sub={a().kpi.tokensSub(short(valid.reduce((n, x) => n + x.totals.input, 0)), short(valid.reduce((n, x) => n + x.totals.output, 0)))}/>}
          {u && valid.some(x => x.totals.usd !== undefined) && <Kpi days={u.days} label={a().kpi.cost} value={usd(costTotal)} sub={a().kpi.costSub}/>}
        </div></section>

        {(charts || tokenChart) && <Section id="dash-trends" title={a().sections.trends} className="dash-wide-card"><div className="dash-charts">
          {charts && p && <>
            <DashChart label={c.active} summary={c.avg(one(p.daily.reduce((n, d) => n + d.active, 0) / Math.max(1, p.daily.length)))} spec={charts.active}/>
            <DashChart label={c.tasks} summary={c.total(fmt(p.totals.tasks))} spec={charts.tasks}/>
            <DashChart label={c.signups} summary={c.total(fmt(p.totals.signups))} spec={charts.signups}/>
          </>}
          {tokenChart && <DashChart label={c.tokens} summary={c.total(short(tokenTotal))} spec={tokenChart}/>}
        </div></Section>}

        {p?.activation && <div className="dash-grid">
          <Section id="dash-activation" title={a().sections.activation}><Funnel steps={p.activation}/></Section>
          <Section id="dash-retention" title={a().sections.retention}><Retention cohorts={p.cohorts ?? []}/></Section>
        </div>}

        {p?.features && <Section id="dash-features" title={a().sections.features} className="dash-wide-card"><Features report={p}/></Section>}

        {p?.features && <div className="dash-grid">
          <Section id="dash-platforms" title={a().sections.platforms}><Platforms report={p}/></Section>
          {p.quality && <Section id="dash-quality" title={a().sections.quality}><Quality quality={p.quality}/></Section>}
        </div>}

        {p?.accounts && <Section id="dash-accounts" title={a().sections.accounts} className="dash-wide-card">
          {u?.accounts.some(x => !x.available) && <p className="banner error" role="alert">{t.usage.unavailable(u.accounts.filter(x => !x.available).map(x => x.username))}</p>}
          <Accounts rows={p.accounts} usage={usageOf} now={now} total={p.accounts.length}/>
        </Section>}

        {/* Without the activity report the token table stands alone. */}
        {u && !p?.accounts && <Section id="dash-tokens" title={a().sections.tokens} className="dash-wide-card dash-tokens">
          {u.accounts.some(x => !x.available) && <p className="banner error" role="alert">{t.usage.unavailable(u.accounts.filter(x => !x.available).map(x => x.username))}</p>}
          {tokenTotal === 0 ? <p className="muted">{t.usage.noUsage}</p> : <div className="dash-table-scroll"><table className="dash-table">
            <thead><tr><th scope="col">{t.usage.columns.user}</th><th scope="col">{t.usage.columns.total}</th><th scope="col">{t.usage.columns.share}</th><th scope="col">{t.usage.columns.input}</th><th scope="col" className="dash-wide">{t.usage.columns.cached}</th><th scope="col">{t.usage.columns.output}</th><th scope="col">{t.usage.columns.cost}</th><th scope="col">{t.usage.columns.quota}</th></tr></thead>
            <tbody>{[...u.accounts].sort((x, y) => (y.available ? y.totals.total : -1) - (x.available ? x.totals.total : -1)).map(x => <tr key={x.id}><th scope="row">{x.username}<small>{x.role === 'owner' ? t.usage.roles.owner : t.usage.roles.member}</small></th>
              {x.available ? <>
                <td><span title={fmt(x.totals.total)}>{short(x.totals.total)}</span></td><td>{pct(x.totals.total, tokenTotal)}</td>
                <td><span title={fmt(x.totals.input)}>{short(x.totals.input)}</span></td><td className="dash-wide"><span title={fmt(x.totals.cached)}>{short(x.totals.cached)}</span></td><td><span title={fmt(x.totals.output)}>{short(x.totals.output)}</span></td>
                <td>{x.totals.usd == null ? <span className="muted" title={x.model ?? undefined}>{t.usage.columns.noPrice}</span> : <span title={x.model ?? undefined}>{usd(x.totals.usd)}</span>}</td>
                <td>{x.quota ? <span title={`${fmt(x.quota.used)} / ${fmt(x.quota.limit)}`}>{pct(x.quota.used, x.quota.limit)}</span> : '—'}</td>
              </> : <td colSpan={7}>{t.usage.notAvailable}</td>}</tr>)}</tbody>
          </table></div>}
        </Section>}

        {p && <details className="dash-card dash-wide-card dash-details"><summary>{a().daily}</summary><div className="dash-table-scroll"><table className="dash-table">
          <thead><tr><th scope="col">{a().columns.date}</th>{(['active', 'signups', 'logins', 'sessions', 'tasks', 'completed', 'failed'] as const).map(k => <th scope="col" key={k}>{a().columns[k]}</th>)}</tr></thead>
          <tbody>{[...p.daily].reverse().map(d => <tr key={d.date}><th scope="row">{d.date}</th>{(['active', 'signups', 'logins', 'sessions', 'tasks', 'completed', 'failed'] as const).map(k => <td key={k}>{d[k] === undefined ? '—' : fmt(d[k]!)}</td>)}</tr>)}</tbody>
        </table></div></details>}

        {p && <details className="dash-card dash-wide-card dash-details"><summary>{a().allEvents}</summary>{p.events.length === 0 ? <p className="muted">{a().noEvents}</p> : <div className="dash-table-scroll"><table className="dash-table">
          <thead><tr><th scope="col">{a().eventColumns.event}</th><th scope="col">{a().eventColumns.count}</th><th scope="col">{a().eventColumns.users}</th></tr></thead>
          <tbody>{p.events.map(e => <tr key={e.name}><th scope="row">{a().events[e.name] ?? e.name}<small>{e.name}</small></th><td>{fmt(e.count)}</td><td>{fmt(e.users)}</td></tr>)}</tbody>
        </table></div>}</details>}

        <details className="dash-card dash-wide-card dash-details"><summary>{a().methodology}</summary>
          {p && <p className="dash-note muted tiny">{a().note(p.collectionStartedAt ? new Date(p.collectionStartedAt).toLocaleString(locale, { timeZone: tz }) : null)}</p>}
          {u && <p className="dash-note muted tiny">{t.usage.note}</p>}
          {u && <p className="dash-note muted tiny">{t.usage.historyNote}</p>}
          {u && <p className="dash-note muted tiny">{t.usage.costNote}</p>}
          {u && <p className="dash-note muted tiny">{t.usage.quotaNote}</p>}
          {u && <ul className="usage-coverage muted tiny">{u.accounts.map(x => <li key={x.id}>{t.usage.coverage(x.username, x.collectionStartedAt ? new Date(x.collectionStartedAt).toLocaleString(locale, { timeZone: tz }) : null, x.firstRecordAt ? new Date(x.firstRecordAt).toLocaleDateString(locale, { timeZone: tz }) : null)}</li>)}</ul>}
        </details>
      </div>}
    </div>
    <PopupPresence onExited={() => activeButton.current?.focus()}>{showActive && p && <ActiveTodayDialog accounts={p.activeTodayAccounts} timezone={p.timezone} onClose={() => setShowActive(false)}/>}</PopupPresence>
  </section>;
}
