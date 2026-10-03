import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { UsageReport } from '../../../common/usage';

const fmt = (n: number) => n.toLocaleString('zh-CN');
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : fmt(n);
const colors = ['var(--ai)', 'var(--done)', 'var(--you)', 'var(--error)'];

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
      catch (err) { if (!controller.signal.aborted) { if (err instanceof ApiError && err.status === 401) onExpired(); else setError(err instanceof Error ? err.message : '用量读取失败'); } }
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
    <header className="usage-header"><div><h1 id="usage-title">用量看板</h1><p className="muted">按账号查看每天的 token 消耗</p></div><button className="ghost" onClick={() => setRefresh(v => v + 1)}>刷新用量</button></header>
    <div className="usage-filters"><label>时间范围<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select></label><label>用户<select value={account} onChange={e => setAccount(e.target.value)}><option value="all">所有用户</option>{report?.accounts.map(a => <option key={a.id} value={a.id}>{a.username}</option>)}</select></label></div>
    {error && <p className="banner error" role="alert">{error} · 数据可能尚未更新</p>}
    {!current ? <p role="status">正在读取用量…</p> : <>
      <p className="muted tiny">统计时区：{current.timezone} · 更新于 {new Date(current.generatedAt).toLocaleTimeString('zh-CN')} · 每 30 秒刷新</p>
      {selected.some(a => !a.available) && <p className="banner error" role="alert">{selected.filter(a => !a.available).map(a => a.username).join('、')} 的数据暂时无法读取，未计入合计。</p>}
      <div className="usage-metrics">{(['total','input','output'] as const).map((key,i) => <article key={key}><span className="muted">{['已记录 token','输入 token','输出 token'][i]}</span><strong>{fmt(sum(key))}</strong>{key === 'input' && <span className="muted tiny">其中缓存读取 {fmt(sum('cached'))} · 写入 {fmt(sum('cacheWrite'))}</span>}</article>)}</div>
      <article className="usage-chart"><h2>每日趋势</h2>{sum('total') === 0 && <p className="muted">这个时间段没有已记录用量。</p>}
        <svg viewBox="0 0 900 280" role="img" aria-label="各用户每天的 token 用量趋势">
          {[0, .5, 1].map(v => <g key={v}><line x1="100" x2="860" y1={y(peak*v)} y2={y(peak*v)} stroke="var(--border)"/><text x="90" y={y(peak*v)+4} textAnchor="end">{compact(peak*v)}</text></g>)}
          {valid.map((a,i) => <g key={a.id}><polyline fill="none" stroke={colors[i%colors.length]} strokeWidth="2.5" strokeDasharray={i >= colors.length ? '6 3' : undefined} points={a.days.map((d,j) => `${x(j)},${y(d.total)}`).join(' ')}/>{a.days.map((d,j) => <circle key={d.date} cx={x(j)} cy={y(d.total)} r="3" fill={colors[i%colors.length]}><title>{a.username} · {d.date} · {fmt(d.total)} token</title></circle>)}</g>)}
          {[0, Math.floor((days-1)/2), days-1].map(i => <text key={i} x={x(i)} y="259" textAnchor={i===0?'start':i===days-1?'end':'middle'}>{current.dates[i].slice(5)}</text>)}
        </svg>
        <div className="usage-legend">{valid.map((a,i) => <span key={a.id}><i style={{background:colors[i%colors.length]}}/>{a.username}</span>)}</div>
      </article>
      <article className="usage-table-wrap"><h2>用户汇总</h2><table><thead><tr><th>用户</th><th>总 token</th><th>输入</th><th>输出</th></tr></thead><tbody>{selected.map(a => <tr key={a.id}><th>{a.username}<small>{a.role === 'owner' ? '所有者' : '成员'}</small></th>{(['total','input','output'] as const).map(k => <td key={k}>{a.available ? fmt(a.totals[k]) : '不可用'}</td>)}</tr>)}</tbody></table></article>
      <details className="usage-table-wrap"><summary>每日明细 · {account === 'all' ? '所有用户合计' : selected[0]?.username}</summary><table><thead><tr><th>日期</th><th>总 token</th><th>输入</th><th>输出</th></tr></thead><tbody>{[...current.dates].reverse().map(date => { const entries = valid.map(a => a.days.find(d => d.date === date)!); return <tr key={date}><th>{date}</th>{(['total','input','output'] as const).map(k => <td key={k}>{fmt(entries.reduce((n,d) => n+d[k],0))}</td>)}</tr>; })}</tbody></table></details>
      <p className="usage-note muted tiny">总量 = 输入 + 输出，缓存已包含在输入中。统计 AIO Agent 的 Codex / Claude 执行与派单调用；不包含外部客户端、图片生成和 Jev 调用，也不代表订阅额度或账单。</p>
      <p className="usage-note muted tiny">历史仅回填已保存的 Codex 事件；旧 Claude、旧派单及未上报用量无法补齐。中断时未收到报告的消耗可能缺失，跨日调用按收到用量报告的日期记账。</p>
      <ul className="usage-coverage muted tiny">{selected.map(a => <li key={a.id}>{a.username}：实时采集{a.collectionStartedAt ? `自 ${new Date(a.collectionStartedAt).toLocaleString('zh-CN', {timeZone:current.timezone})}` : '待账号执行器启动'}；{a.firstRecordAt ? `最早记录 ${new Date(a.firstRecordAt).toLocaleDateString('zh-CN', {timeZone:current.timezone})}` : '暂无记录'}</li>)}</ul>
    </>}
  </section>;
}
