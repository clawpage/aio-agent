import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { KnowledgeNode, KnowledgeOverview } from "../types";
import { Markdown } from "./Markdown";
import { t } from "../i18n";

/** A domain's name in this language; a domain the keeper made up keeps its own slug. */
const domainName = (slug: string) => t.knowledge.domain[slug] ?? slug;
const kindName = (kind: string) => t.knowledge.kind[kind] ?? kind;

/**
 * The personal knowledge base (docs/TASK-KB.md §6): what the knowledge keeper
 * sorted out of finished tasks, by domain, with where each claim came from.
 * The person can read it, delete an entry or a whole domain, and turn it off.
 */
export function KnowledgeList({ active, onExpired, onOpenTask, onOpenLink }: { active: boolean; onExpired: () => void; onOpenTask: (taskId: string) => void; onOpenLink: (url: string) => void }) {
  const [data, setData] = useState<KnowledgeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [node, setNode] = useState<KnowledgeNode | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirm, setConfirm] = useState<"node" | "domain" | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 401) onExpired();
    setError(err instanceof Error ? err.message : fallback);
  }, [onExpired]);
  const load = useCallback(async () => {
    try { setData(await api.knowledge()); setError(null); }
    catch (err) { fail(err, t.knowledge.list.loadFailed); }
  }, [fail]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30000);
    return () => window.clearInterval(timer);
  }, [active, load]);
  useEffect(() => {
    setNode(null); setMissing(false); setConfirm(null);
    if (!openId) return;
    let live = true;
    api.knowledgeNode(openId).then((r) => { if (live) setNode(r.node); }, (err) => {
      if (!live) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else fail(err, t.knowledge.list.loadFailed);
    });
    return () => { live = false; };
  }, [openId, fail]);

  const open = (id: string | null) => { setOpenId(id); setNotice(null); setError(null); document.querySelector(".knowledge-page .task-list-scroll")?.scrollTo(0, 0); };
  const toggle = async (enabled: boolean) => {
    if (!data) return;
    // The switch moves at once and goes back if the change is refused.
    setBusy(true); setError(null); setData({ ...data, enabled });
    try { const r = await api.knowledgeSettings(enabled); setData((d) => d && { ...d, enabled: r.enabled }); }
    catch (err) { setData((d) => d && { ...d, enabled: !enabled }); fail(err, t.knowledge.list.saveFailed); }
    finally { setBusy(false); }
  };
  const removeNode = async (id: string) => {
    setBusy(true); setError(null);
    try { await api.knowledgeDeleteNode(id); setConfirm(null); setOpenId(null); await load(); }
    catch (err) { fail(err, t.knowledge.list.deleteFailed); }
    finally { setBusy(false); }
  };
  const removeDomain = async (name: string) => {
    setBusy(true); setError(null);
    try { const r = await api.knowledgeDeleteDomain(name); setConfirm(null); setDomain(null); setNotice(t.knowledge.list.deletedDomain(domainName(name), r.deleted)); await load(); }
    catch (err) { fail(err, t.knowledge.list.deleteFailed); }
    finally { setBusy(false); }
  };

  // Domains with something in them, in the server's order, then any only the nodes name.
  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of data?.nodes ?? []) counts.set(n.domain, (counts.get(n.domain) ?? 0) + 1);
    const order = [...(data?.domains ?? []).map((d) => d.name), ...counts.keys()];
    return [...new Set(order)].filter((name) => counts.has(name)).map((name) => ({ name, count: counts.get(name)! }));
  }, [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.nodes ?? []).filter((n) => (!domain || n.domain === domain) && (!q || n.title.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q)));
  }, [data, domain, query]);
  const domainCount = domain ? domains.find((d) => d.name === domain)?.count ?? 0 : 0;

  const L = t.knowledge.list, D = t.knowledge.detail;
  const head = <header className="chat-head"><div className="chat-title"><h2>{L.title}</h2><span className="task-list-sub muted tiny">{data ? L.count(data.nodes.length) : L.loading}</span></div></header>;

  if (openId) return <section className="schedule-page knowledge-page" aria-label={L.title}>
    {head}
    <div className="task-list-scroll">
      <div className="knowledge-detail">
        <button type="button" className="ghost tiny knowledge-back" onClick={() => open(null)}>{D.back}</button>
        {error && <p className="banner error" role="alert">{error}</p>}
        {missing && <div className="empty"><p>{D.notFound}</p></div>}
        {!node && !missing && <p className="muted tiny">{D.loading}</p>}
        {node && <article className="knowledge-node" aria-label={node.title}>
          <h3 className="knowledge-node-title">{node.title}</h3>
          <p className="knowledge-meta muted tiny"><span>{domainName(node.domain)}</span><span>{kindName(node.kind)}</span><span>{L.updated(node.updated)}</span><span>{D.reads(node.reads)}</span></p>
          {node.summary && <p className="knowledge-summary">{node.summary}</p>}

          {node.pendingCorrections.length > 0 && <div className="knowledge-pending" role="note" aria-label={D.pendingTitle}>
            <strong>{D.pendingTitle}</strong>
            <p className="tiny">{D.pendingHint}</p>
            <ul>{node.pendingCorrections.map((c) => <li key={c.packet}>
              <span className="knowledge-tag attention">{D.correction[c.type] ?? c.type}</span>{c.text}
              <span className="muted tiny"> · {c.at}</span>
              {c.task && <> · <button type="button" className="link tiny" onClick={() => onOpenTask(c.task!)}>{node.sourceTasks[c.task] ?? D.fromTask}</button></>}
            </li>)}</ul>
          </div>}

          {node.claims.length > 0 && <section className="knowledge-section" aria-label={D.claimsTitle}>
            <h4>{D.claimsTitle}</h4>
            <ul className="knowledge-claims">{node.claims.map((c) => <li key={c.id} className={c.status === "superseded" ? "superseded" : undefined} data-claim-id={c.id}>
              <p className="knowledge-claim-text">{c.text}</p>
              <p className="knowledge-tags">
                <span className="knowledge-tag">{D.certainty[c.certainty] ?? c.certainty}</span>
                {c.volatility === "changes" && <span className="knowledge-tag">{D.changes}</span>}
                {c.recheck && c.status !== "superseded" && <span className="knowledge-tag attention">{D.recheck}</span>}
                {c.status === "superseded" && <span className="knowledge-tag">{D.superseded}</span>}
              </p>
              {c.sources.length > 0 && <ul className="knowledge-sources" aria-label={D.sources}>{c.sources.map((s) => <li key={s.id}>
                <div className="knowledge-source-head">
                  <button type="button" className="link tiny" onClick={() => onOpenTask(s.task)}>{node.sourceTasks[s.task] ?? D.unknownTask}</button>
                  <span className="muted tiny">{s.captured}</span>
                </div>
                {s.url && <button type="button" className="link tiny knowledge-source-ref" onClick={() => onOpenLink(s.url!)}>{s.url}</button>}
                {s.path && <code className="knowledge-source-ref tiny">{s.path}</code>}
                {s.excerpt && <blockquote className="knowledge-excerpt">{s.excerpt}</blockquote>}
              </li>)}</ul>}
            </li>)}</ul>
          </section>}

          {node.links.length > 0 && <section className="knowledge-section" aria-label={D.linksTitle}>
            <h4>{D.linksTitle}</h4>
            <ul className="knowledge-links">{node.links.map((l) => <li key={`${l.direction}-${l.rel}-${l.node}`}>
              <span className="muted tiny">{(l.direction === "out" ? D.relOut : D.relIn)[l.rel] ?? l.rel}</span>
              <button type="button" className="link" onClick={() => open(l.node)}>{l.title}</button>
            </li>)}</ul>
          </section>}

          {node.wiki && <section className="knowledge-section knowledge-wiki" aria-label={D.wikiTitle}>
            <h4>{D.wikiTitle}</h4>
            <Markdown source={node.wiki} onOpenLink={onOpenLink}/>
          </section>}

          {confirm === "node"
            ? <div className="schedule-actions" role="alert"><span className="tiny">{D.deleteWarning}</span><button className="ghost tiny" onClick={() => setConfirm(null)}>{L.cancel}</button><button className="danger tiny" disabled={busy} onClick={() => void removeNode(node.id)}>{L.confirmDelete}</button></div>
            : <div className="schedule-actions"><button className="ghost tiny" onClick={() => setConfirm("node")}>{D.delete}</button></div>}
        </article>}
      </div>
    </div>
  </section>;

  return <section className="schedule-page knowledge-page" aria-label={L.title}>
    {head}
    <div className="task-list-scroll">
      <p className="schedule-hint muted tiny">{L.hint}</p>
      {data && <div className="knowledge-status">
        <label className="knowledge-toggle"><input type="checkbox" checked={data.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)}/>{L.enabled}</label>
        {data.pending > 0 && <span className="muted tiny" role="status">{L.pending(data.pending)}</span>}
        {!data.enabled && <p className="muted tiny knowledge-off">{L.disabledHint}</p>}
      </div>}
      {notice && <p className="banner ok" role="status">{notice}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {data && !data.nodes.length && <div className="empty"><h3>{L.emptyTitle}</h3><p>{L.emptyBody}</p></div>}
      {data && data.nodes.length > 0 && <div className="task-list-tools">
        <div className="task-filters" role="group" aria-label={L.filterGroup}>
          <button type="button" className="task-filter" aria-pressed={!domain} onClick={() => { setDomain(null); setConfirm(null); }}>{L.all}<span className="task-filter-count">{data.nodes.length}</span></button>
          {domains.map((d) => <button key={d.name} type="button" className="task-filter" aria-pressed={domain === d.name} onClick={() => { setDomain(d.name); setConfirm(null); }}>{domainName(d.name)}<span className="task-filter-count">{d.count}</span></button>)}
        </div>
        <input type="search" className="task-search" placeholder={L.search} aria-label={L.search} value={query} onChange={(e) => setQuery(e.target.value)}/>
      </div>}
      {domain && domainCount > 0 && (confirm === "domain"
        ? <div className="schedule-actions knowledge-domain-actions" role="alert"><span className="tiny">{L.deleteDomainWarning(domainName(domain), domainCount)}</span><button className="ghost tiny" onClick={() => setConfirm(null)}>{L.cancel}</button><button className="danger tiny" disabled={busy} onClick={() => void removeDomain(domain)}>{L.confirmDelete}</button></div>
        : <div className="schedule-actions knowledge-domain-actions"><button className="ghost tiny" onClick={() => setConfirm("domain")}>{L.deleteDomain(domainName(domain))}</button></div>)}
      {data && data.nodes.length > 0 && !shown.length && <p className="muted tiny knowledge-nomatch">{L.noMatch}</p>}
      <ul className="task-list">{shown.map((n) => <li key={n.id} data-node-id={n.id}>
        <button type="button" className="task-list-item" onClick={() => open(n.id)}>
          <div className="task-list-top"><strong>{n.title}</strong><span className="task-status-badge">{kindName(n.kind)}</span></div>
          {n.summary && <p className="task-list-summary">{n.summary}</p>}
          <div className="task-list-meta">
            {!domain && <span>{domainName(n.domain)}</span>}
            <span>{L.claims(n.claims)}</span>
            {n.wiki && <span className="knowledge-tag">{L.wiki}</span>}
            {n.flagged > 0 && <span className="knowledge-tag attention">{L.flagged(n.flagged)}</span>}
            <span>{L.updated(n.updated)}</span>
          </div>
        </button>
      </li>)}</ul>
    </div>
  </section>;
}
