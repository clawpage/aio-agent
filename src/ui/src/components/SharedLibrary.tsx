import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import type { KbChange, KbInvite, KbLibraryOverview, KbRulePresets, KbRuleVersion, KnowledgeNode } from "../types";
import { messageTime } from "../messageTime";
import { t } from "../i18n";

/** A domain's name in this language; a domain the keeper made up keeps its own slug. */
const domainName = (slug: string) => t.knowledge.domain[slug] ?? slug;
const kindName = (kind: string) => t.knowledge.kind[kind] ?? kind;
const when = (at: number) => messageTime(at, Date.now()) ?? "";
const KINDS = ["fact", "entity", "procedure", "topic"];

type Tab = "entries" | "rules" | "members" | "history";

/**
 * A shared knowledge base (docs/SHARED-KB.md §7): entries the members and their knowledge
 * keepers put in, the rules the keeper follows, the members and invitation links, and every
 * change, which can be undone.
 */
export function SharedLibrary({ lib, active, head, onExpired, onOpenTask, onOpenLink, onLeft }: {
  lib: string; active: boolean; head: ReactNode; onExpired: () => void; onOpenTask: (taskId: string) => void; onOpenLink: (url: string) => void;
  /** The person is no longer a member (left, or dissolved it). */
  onLeft: () => void;
}) {
  const [data, setData] = useState<KbLibraryOverview | null>(null);
  const [tab, setTab] = useState<Tab>("entries");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) onExpired();
    setError(err instanceof Error ? err.message : t.knowledge.list.loadFailed);
  }, [onExpired]);
  const load = useCallback(async () => {
    try { setData(await api.kbLibrary(lib)); setError(null); }
    // Removed from it, or dissolved, by someone else: back to the list of the person's libraries.
    catch (err) { if (err instanceof ApiError && err.status === 404) onLeft(); else fail(err); }
  }, [lib, fail, onLeft]);
  useEffect(() => { setData(null); setOpenId(null); setAdding(false); setTab("entries"); setNotice(null); setError(null); setDomain(null); setQuery(""); }, [lib]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const S = t.knowledge.shared, L = t.knowledge.list;
  const say = (text: string | null) => { setNotice(text); setError(null); };
  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of data?.nodes ?? []) counts.set(n.domain, (counts.get(n.domain) ?? 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  }, [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.nodes ?? []).filter((n) => (!domain || n.domain === domain) && (!q || n.title.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q)));
  }, [data, domain, query]);

  const body = () => {
    if (!data) return null;
    if (tab === "rules") return <RulesTab lib={lib} data={data} onChanged={load} onError={fail} say={say}/>;
    if (tab === "members") return <MembersTab lib={lib} data={data} onChanged={load} onError={fail} onLeft={onLeft}/>;
    if (tab === "history") return <HistoryTab lib={lib} active={active} onChanged={load} onError={fail} say={say}/>;
    if (openId) return <EntryDetail lib={lib} id={openId} domains={data.domains.map((d) => d.name)} onBack={() => { setOpenId(null); void load(); }} onError={fail} say={say} onOpenTask={onOpenTask} onOpenLink={onOpenLink}/>;
    if (adding) return <EntryForm domains={data.domains.map((d) => d.name)} onCancel={() => setAdding(false)} onSave={async (entry) => {
      try { const r = await api.kbCreateEntry(lib, entry); setAdding(false); await load(); setOpenId(r.id); }
      catch (err) { fail(err); }
    }}/>;
    return <>
      <div className="schedule-actions knowledge-shared-actions"><button className="primary tiny" onClick={() => { setAdding(true); say(null); }}>{S.entries.add}</button></div>
      {!data.nodes.length && <div className="empty"><h3>{S.entries.emptyTitle}</h3><p>{S.entries.emptyBody}</p></div>}
      {data.nodes.length > 0 && <div className="task-list-tools">
        <div className="task-filters" role="group" aria-label={L.filterGroup}>
          <button type="button" className="task-filter" aria-pressed={!domain} onClick={() => setDomain(null)}>{L.all}<span className="task-filter-count">{data.nodes.length}</span></button>
          {domains.map((d) => <button key={d.name} type="button" className="task-filter" aria-pressed={domain === d.name} onClick={() => setDomain(d.name)}>{domainName(d.name)}<span className="task-filter-count">{d.count}</span></button>)}
        </div>
        <input type="search" className="task-search" placeholder={L.search} aria-label={L.search} value={query} onChange={(e) => setQuery(e.target.value)}/>
      </div>}
      {data.nodes.length > 0 && !shown.length && <p className="muted tiny knowledge-nomatch">{L.noMatch}</p>}
      <ul className="task-list">{shown.map((n) => <li key={n.id} data-node-id={n.id}>
        <button type="button" className="task-list-item" onClick={() => { setOpenId(n.id); say(null); }}>
          <div className="task-list-top"><strong>{n.title}</strong><span className="task-status-badge">{kindName(n.kind)}</span></div>
          {n.summary && <p className="task-list-summary">{n.summary}</p>}
          <div className="task-list-meta">
            {!domain && <span>{domainName(n.domain)}</span>}
            <span>{L.claims(n.claims)}</span>
            {n.flagged > 0 && <span className="knowledge-tag attention">{L.flagged(n.flagged)}</span>}
            <span>{L.updated(n.updated)}</span>
          </div>
        </button>
      </li>)}</ul>
    </>;
  };

  return <section className="schedule-page knowledge-page" aria-label={data?.library.name ?? L.title}>
    {head}
    <div className="task-list-scroll">
      {data && <div className="knowledge-shared-head">
        <p className="muted tiny">{S.sub(data.library.members.length, data.nodes.length)}{data.pending > 0 ? ` · ${S.pending(data.pending)}` : ""}</p>
        <p className="schedule-hint muted tiny">{S.hint}</p>
        <div className="task-filters knowledge-tabs" role="tablist" aria-label={S.tabGroup}>
          {(["entries", "rules", "members", "history"] as const).map((k) => <button key={k} type="button" role="tab" className="task-filter" aria-selected={tab === k} aria-pressed={tab === k}
            onClick={() => { setTab(k); setOpenId(null); setAdding(false); say(null); }}>{S.tabs[k]}</button>)}
        </div>
      </div>}
      {notice && <p className="banner ok" role="status">{notice}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {!data && !error && <p className="muted tiny knowledge-nomatch">{L.loading}</p>}
      {body()}
    </div>
  </section>;
}

/** A new entry: a title, where it goes, and its statements, one per line. */
function EntryForm({ domains, onSave, onCancel }: { domains: string[]; onSave: (entry: { title: string; kind: string; domain: string; summary: string; claims: string[] }) => Promise<void>; onCancel: () => void }) {
  const E = t.knowledge.shared.entries;
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("fact");
  const [domain, setDomain] = useState(domains.includes("family") ? "family" : domains[0] ?? "other");
  const [summary, setSummary] = useState("");
  const [claims, setClaims] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = claims.split("\n").map((l) => l.trim()).filter(Boolean);
  return <form className="knowledge-form" aria-label={E.formTitle} onSubmit={(e) => {
    e.preventDefault();
    setBusy(true);
    void onSave({ title: title.trim(), kind, domain, summary: summary.trim(), claims: lines }).finally(() => setBusy(false));
  }}>
    <h3>{E.formTitle}</h3>
    <label>{E.title}<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required/></label>
    <div className="knowledge-form-row">
      <label>{E.domain}<select value={domain} onChange={(e) => setDomain(e.target.value)}>{domains.map((d) => <option key={d} value={d}>{domainName(d)}</option>)}</select></label>
      <label>{E.kind}<select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{kindName(k)}</option>)}</select></label>
    </div>
    <label>{E.summary}<input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300}/></label>
    <label>{E.claims}<textarea rows={4} value={claims} onChange={(e) => setClaims(e.target.value)}/></label>
    <div className="schedule-actions">
      <button type="button" className="ghost tiny" onClick={onCancel}>{t.knowledge.list.cancel}</button>
      <button type="submit" className="primary tiny" disabled={busy || !title.trim() || (!lines.length && !summary.trim())}>{E.save}</button>
    </div>
  </form>;
}

function EntryDetail({ lib, id, domains, onBack, onError, say, onOpenTask, onOpenLink }: {
  lib: string; id: string; domains: string[]; onBack: () => void; onError: (err: unknown) => void; say: (text: string | null) => void; onOpenTask: (taskId: string) => void; onOpenLink: (url: string) => void;
}) {
  const S = t.knowledge.shared, D = t.knowledge.detail, L = t.knowledge.list;
  const [node, setNode] = useState<(KnowledgeNode & { sourceTasks: Record<string, string | null> }) | null>(null);
  const [missing, setMissing] = useState(false);
  const [history, setHistory] = useState<KbChange[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [head, setHead] = useState<{ title: string; summary: string; domain: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, h] = await Promise.all([api.kbNode(lib, id), api.kbNodeHistory(lib, id)]);
      setNode(r.node as KnowledgeNode & { sourceTasks: Record<string, string | null> }); setHistory(h.changes); setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { setMissing(true); return; }
      onError(err);
    }
  }, [lib, id, onError]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, after?: string) => {
    setBusy(true);
    try { await fn(); setEditing(null); setHead(null); say(after ?? null); await load(); }
    catch (err) { onError(err); }
    finally { setBusy(false); }
  };

  if (missing) return <div className="knowledge-detail"><button type="button" className="ghost tiny knowledge-back" onClick={onBack}>{D.back}</button><div className="empty"><p>{D.notFound}</p></div></div>;
  if (!node) return <div className="knowledge-detail"><p className="muted tiny">{D.loading}</p></div>;
  const claims = node.claims.filter((c) => c.status === "active");
  return <div className="knowledge-detail">
    <button type="button" className="ghost tiny knowledge-back" onClick={onBack}>{D.back}</button>
    <article className="knowledge-node" aria-label={node.title}>
      {head
        ? <form className="knowledge-form" onSubmit={(e) => { e.preventDefault(); void act(() => api.kbUpdateNode(lib, id, head)); }}>
          <label>{S.entries.title}<input value={head.title} maxLength={80} onChange={(e) => setHead({ ...head, title: e.target.value })} required/></label>
          <label>{S.entries.summary}<input value={head.summary} maxLength={300} onChange={(e) => setHead({ ...head, summary: e.target.value })}/></label>
          <label>{S.entries.domain}<select value={head.domain} onChange={(e) => setHead({ ...head, domain: e.target.value })}>{domains.map((d) => <option key={d} value={d}>{domainName(d)}</option>)}</select></label>
          <div className="schedule-actions"><button type="button" className="ghost tiny" onClick={() => setHead(null)}>{L.cancel}</button><button type="submit" className="primary tiny" disabled={busy || !head.title.trim()}>{S.detail.save}</button></div>
        </form>
        : <>
          <h3 className="knowledge-node-title">{node.title}</h3>
          <p className="knowledge-meta muted tiny"><span>{domainName(node.domain)}</span><span>{kindName(node.kind)}</span><span>{L.updated(node.updated)}</span></p>
          {node.summary && <p className="knowledge-summary">{node.summary}</p>}
          <div className="schedule-actions knowledge-inline-actions"><button className="ghost tiny" onClick={() => setHead({ title: node.title, summary: node.summary, domain: node.domain })}>{S.detail.edit}</button></div>
        </>}

      {node.pendingCorrections.length > 0 && <div className="knowledge-pending" role="note" aria-label={D.pendingTitle}>
        <strong>{D.pendingTitle}</strong>
        <p className="tiny">{D.pendingHint}</p>
        <ul>{node.pendingCorrections.map((c) => <li key={c.packet}><span className="knowledge-tag attention">{D.correction[c.type] ?? c.type}</span>{c.text}<span className="muted tiny"> · {c.at}</span></li>)}</ul>
      </div>}

      <section className="knowledge-section" aria-label={D.claimsTitle}>
        <h4>{D.claimsTitle}</h4>
        <ul className="knowledge-claims">{claims.map((c) => <li key={c.id} data-claim-id={c.id}>
          {editing === c.id
            ? <form onSubmit={(e) => { e.preventDefault(); void act(() => api.kbUpdateClaim(lib, c.id, draft)); }}>
              <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={S.detail.editClaim} maxLength={400}/>
              <div className="schedule-actions"><button type="button" className="ghost tiny" onClick={() => setEditing(null)}>{L.cancel}</button><button type="submit" className="primary tiny" disabled={busy || !draft.trim()}>{S.detail.save}</button></div>
            </form>
            : <>
              <p className="knowledge-claim-text">{c.text}</p>
              <p className="knowledge-tags">
                <span className="knowledge-tag">{D.certainty[c.certainty] ?? c.certainty}</span>
                {c.volatility === "changes" && <span className="knowledge-tag">{D.changes}</span>}
                {c.recheck && <span className="knowledge-tag attention">{D.recheck}</span>}
              </p>
              {c.sources.length > 0 && <ul className="knowledge-sources" aria-label={D.sources}>{c.sources.map((s) => <li key={s.id}>
                <div className="knowledge-source-head">
                  {s.mine && s.task
                    ? <button type="button" className="link tiny" onClick={() => onOpenTask(s.task)}>{node.sourceTasks[s.task] ?? D.fromTask}</button>
                    : <span className="tiny">{s.from ? S.detail.from(s.from) : D.unknownTask}</span>}
                  {s.kind === "manual" && <span className="knowledge-tag">{S.detail.manual}</span>}
                  <span className="muted tiny">{s.captured}</span>
                </div>
                {s.url && <button type="button" className="link tiny knowledge-source-ref" onClick={() => onOpenLink(s.url!)}>{s.url}</button>}
                {s.excerpt && s.kind !== "manual" && <blockquote className="knowledge-excerpt">{s.excerpt}</blockquote>}
              </li>)}</ul>}
              <div className="schedule-actions knowledge-inline-actions">
                <button className="ghost tiny" onClick={() => { setEditing(c.id); setDraft(c.text); }}>{S.detail.editClaim}</button>
                <button className="ghost tiny" disabled={busy} onClick={() => void act(() => api.kbDeleteClaim(lib, c.id))}>{S.detail.deleteClaim}</button>
              </div>
            </>}
        </li>)}</ul>
        {editing === "new"
          ? <form className="knowledge-form" onSubmit={(e) => { e.preventDefault(); void act(() => api.kbAddClaim(lib, id, draft)); }}>
            <textarea rows={2} value={draft} placeholder={S.detail.claimPlaceholder} onChange={(e) => setDraft(e.target.value)} aria-label={S.detail.addClaim} maxLength={400}/>
            <div className="schedule-actions"><button type="button" className="ghost tiny" onClick={() => setEditing(null)}>{L.cancel}</button><button type="submit" className="primary tiny" disabled={busy || !draft.trim()}>{S.detail.save}</button></div>
          </form>
          : <div className="schedule-actions knowledge-inline-actions"><button className="ghost tiny" onClick={() => { setEditing("new"); setDraft(""); }}>{S.detail.addClaim}</button></div>}
      </section>

      {node.links.length > 0 && <section className="knowledge-section" aria-label={D.linksTitle}>
        <h4>{D.linksTitle}</h4>
        <ul className="knowledge-links">{node.links.map((l) => <li key={`${l.direction}-${l.rel}-${l.node}`}>
          <span className="muted tiny">{(l.direction === "out" ? D.relOut : D.relIn)[l.rel] ?? l.rel}</span><span>{l.title}</span>
        </li>)}</ul>
      </section>}

      <section className="knowledge-section" aria-label={S.detail.history}>
        <h4>{S.detail.history}</h4>
        {!history.length && <p className="muted tiny">{S.detail.noHistory}</p>}
        <ul className="knowledge-changes">{history.map((h, i) => <li key={h.id}>
          <span className="tiny">{(S.history.kind[h.kind] ?? S.history.kind.edit!)(h.by)}</span>
          <span className="muted tiny">{when(h.at)}</span>
          {i > 0 && <button className="ghost tiny" disabled={busy} onClick={() => void act(() => api.kbRestoreNode(lib, id, h.id), S.detail.restored)}>{S.detail.restore}</button>}
        </li>)}</ul>
      </section>

      {confirm
        ? <div className="schedule-actions" role="alert"><span className="tiny">{S.detail.deleteWarning}</span><button className="ghost tiny" onClick={() => setConfirm(false)}>{L.cancel}</button><button className="danger tiny" disabled={busy} onClick={() => { setBusy(true); api.kbDeleteNode(lib, id).then(onBack, onError).finally(() => setBusy(false)); }}>{L.confirmDelete}</button></div>
        : <div className="schedule-actions"><button className="ghost tiny" onClick={() => setConfirm(true)}>{S.detail.deleteEntry}</button></div>}
    </article>
  </div>;
}

function RulesTab({ lib, data, onChanged, onError, say }: { lib: string; data: KbLibraryOverview; onChanged: () => Promise<void>; onError: (err: unknown) => void; say: (text: string | null) => void }) {
  const R = t.knowledge.shared.rules;
  const [text, setText] = useState(data.library.rules.text);
  const [versions, setVersions] = useState<KbRuleVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const loadVersions = useCallback(async () => {
    try { setVersions((await api.kbRuleHistory(lib)).versions); } catch (err) { onError(err); }
  }, [lib, onError]);
  useEffect(() => { void loadVersions(); }, [loadVersions]);
  useEffect(() => { setText(data.library.rules.text); }, [data.library.rules.version, data.library.rules.text]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); say(R.saved); await Promise.all([onChanged(), loadVersions()]); }
    catch (err) { onError(err); }
    finally { setBusy(false); }
  };
  return <div className="knowledge-detail">
    <form className="knowledge-form" aria-label={R.current} onSubmit={(e) => { e.preventDefault(); void act(() => api.kbSetRules(lib, text)); }}>
      <h3>{R.current}</h3>
      <p className="muted tiny">{R.hint}</p>
      <textarea rows={8} value={text} placeholder={R.empty} onChange={(e) => setText(e.target.value)} aria-label={R.current} maxLength={4000}/>
      <div className="schedule-actions"><button type="submit" className="primary tiny" disabled={busy || text === data.library.rules.text}>{R.save}</button></div>
    </form>
    <section className="knowledge-section" aria-label={R.versions}>
      <h4>{R.versions}</h4>
      <ul className="knowledge-claims">{versions.map((v, i) => <li key={v.version}>
        <p className="knowledge-meta muted tiny"><span>{R.version(v.version)}</span><span>{v.by}</span><span>{when(v.at)}</span>{v.restoredFrom && <span>{R.restoredFrom(v.restoredFrom)}</span>}</p>
        <p className="knowledge-claim-text knowledge-rules-text">{v.text || R.empty}</p>
        {i > 0 && <div className="schedule-actions knowledge-inline-actions"><button className="ghost tiny" disabled={busy} onClick={() => void act(() => api.kbRestoreRules(lib, v.version))}>{R.restore}</button></div>}
      </li>)}</ul>
    </section>
  </div>;
}

function MembersTab({ lib, data, onChanged, onError, onLeft }: { lib: string; data: KbLibraryOverview; onChanged: () => Promise<void>; onError: (err: unknown) => void; onLeft: () => void }) {
  const M = t.knowledge.shared.members, L = t.knowledge.list;
  const [invites, setInvites] = useState<KbInvite[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"leave" | "dissolve" | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = data.library.admin ? data.library.adminName : null;
  const loadInvites = useCallback(async () => {
    try { setInvites((await api.kbInvites(lib)).invites); } catch (err) { onError(err); }
  }, [lib, onError]);
  useEffect(() => { void loadInvites(); }, [loadInvites]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await Promise.all([onChanged(), loadInvites()]); }
    catch (err) { onError(err); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* the link stays selectable */ }
  };
  const alone = data.library.members.length === 1;
  return <div className="knowledge-detail">
    <section className="knowledge-section" aria-label={M.title}>
      <h4>{M.title}</h4>
      {name !== null
        ? <form className="knowledge-form" onSubmit={(e) => { e.preventDefault(); void act(() => api.kbRenameLibrary(lib, name)).then(() => setName(null)); }}>
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label={M.rename} required/>
          <div className="schedule-actions"><button type="button" className="ghost tiny" onClick={() => setName(null)}>{L.cancel}</button><button type="submit" className="primary tiny" disabled={busy || !name.trim()}>{t.knowledge.shared.detail.save}</button></div>
        </form>
        : <div className="schedule-actions knowledge-inline-actions"><button className="ghost tiny" onClick={() => setName(data.library.name)}>{M.rename}</button></div>}
      <ul className="knowledge-changes">{data.library.members.map((m) => <li key={m.id}>
        <span>{m.username}</span>
        {m.username === data.library.adminName && <span className="knowledge-tag">{M.admin}</span>}
        {data.library.admin && m.username !== me && <>
          <button className="ghost tiny" disabled={busy} onClick={() => void act(() => api.kbTransfer(lib, m.id))}>{M.makeAdmin}</button>
          <button className="ghost tiny" disabled={busy} onClick={() => void act(() => api.kbRemoveMember(lib, m.id))}>{M.remove}</button>
        </>}
      </li>)}</ul>
    </section>
    <section className="knowledge-section" aria-label={M.invite}>
      <h4>{M.invite}</h4>
      <p className="muted tiny">{M.inviteHint}</p>
      <div className="schedule-actions knowledge-inline-actions"><button className="primary tiny" disabled={busy} onClick={() => void act(async () => {
        const r = await api.kbCreateInvite(lib);
        setLink(`${location.origin}/knowledge?join=${encodeURIComponent(r.token)}`); setCopied(false);
      })}>{M.invite}</button></div>
      {link && <div className="knowledge-invite-link">
        <p className="tiny">{M.newLink}</p>
        <input readOnly value={link} aria-label={M.newLink} onFocus={(e) => e.currentTarget.select()}/>
        <button className="ghost tiny" onClick={() => void copy()}>{copied ? M.copied : M.copy}</button>
      </div>}
      {invites.length > 0 && <>
        <p className="muted tiny">{M.active}</p>
        <ul className="knowledge-changes">{invites.map((i) => <li key={i.id}>
          <span className="tiny">{M.inviteMeta(i.createdBy, i.uses, when(i.expiresAt))}</span>
          <button className="ghost tiny" disabled={busy} onClick={() => void act(() => api.kbRevokeInvite(lib, i.id))}>{M.revoke}</button>
        </li>)}</ul>
      </>}
    </section>
    <section className="knowledge-section">
      {confirm === "leave"
        ? <div className="schedule-actions" role="alert"><span className="tiny">{alone ? M.leaveLast : M.leaveWarning}</span><button className="ghost tiny" onClick={() => setConfirm(null)}>{L.cancel}</button><button className="danger tiny" disabled={busy} onClick={() => { setBusy(true); api.kbLeave(lib).then(onLeft, onError).finally(() => setBusy(false)); }}>{M.confirm}</button></div>
        : confirm === "dissolve"
          ? <div className="schedule-actions" role="alert"><span className="tiny">{M.dissolveWarning}</span><button className="ghost tiny" onClick={() => setConfirm(null)}>{L.cancel}</button><button className="danger tiny" disabled={busy} onClick={() => { setBusy(true); api.kbDissolve(lib).then(onLeft, onError).finally(() => setBusy(false)); }}>{M.confirm}</button></div>
          : <div className="schedule-actions">
            {data.library.admin && !alone
              ? <span className="muted tiny">{M.leaveAdmin}</span>
              : <button className="ghost tiny" onClick={() => setConfirm("leave")}>{M.leave}</button>}
            {data.library.admin && <button className="ghost tiny" onClick={() => setConfirm("dissolve")}>{M.dissolve}</button>}
          </div>}
    </section>
  </div>;
}

function HistoryTab({ lib, active, onChanged, onError, say }: { lib: string; active: boolean; onChanged: () => Promise<void>; onError: (err: unknown) => void; say: (text: string | null) => void }) {
  const H = t.knowledge.shared.history;
  const [changes, setChanges] = useState<KbChange[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const r = await api.kbChanges(lib); setChanges(r.changes); setMore(r.changes.length >= 50); } catch (err) { onError(err); }
  }, [lib, onError]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  const older = async () => {
    try { const r = await api.kbChanges(lib, changes.at(-1)?.id); setChanges([...changes, ...r.changes]); setMore(r.changes.length >= 50); } catch (err) { onError(err); }
  };
  const undo = async (id: number) => {
    setBusy(true);
    try { await api.kbUndo(lib, id); say(H.undoneNotice); await Promise.all([load(), onChanged()]); }
    catch (err) { onError(err); }
    finally { setBusy(false); }
  };
  if (!changes.length) return <div className="knowledge-detail"><p className="muted tiny">{H.empty}</p></div>;
  return <div className="knowledge-detail">
    <ul className="knowledge-claims">{changes.map((c) => <li key={c.id} data-change-id={c.id}>
      <p className="knowledge-meta muted tiny"><span>{(H.kind[c.kind] ?? H.kind.edit!)(c.by)}</span><span>{when(c.at)}</span><span>{H.rows(c.rows)}</span></p>
      {c.summary && <p className="knowledge-claim-text">{c.summary}</p>}
      <div className="schedule-actions knowledge-inline-actions">
        {c.undone ? <span className="knowledge-tag">{H.undone}</span> : <button className="ghost tiny" disabled={busy} onClick={() => void undo(c.id)}>{H.undo}</button>}
      </div>
    </li>)}</ul>
    {more && <div className="schedule-actions"><button className="ghost tiny" onClick={() => void older()}>{H.more}</button></div>}
  </div>;
}

/** A new shared library: its name and the rules its keeper starts from (a preset, edited freely). */
export function CreateLibrary({ head, presets, onCreated, onCancel, onError }: { head: ReactNode; presets: KbRulePresets; onCreated: (id: string) => void; onCancel: () => void; onError: (err: unknown) => void }) {
  const C = t.knowledge.shared.create;
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<keyof KbRulePresets>("family");
  const [rules, setRules] = useState(presets.family);
  const [busy, setBusy] = useState(false);
  return <section className="schedule-page knowledge-page" aria-label={C.title}>
    {head}
    <div className="task-list-scroll">
      <form className="knowledge-form knowledge-detail" aria-label={C.title} onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        api.kbCreateLibrary(name.trim(), rules).then((r) => onCreated(r.id), onError).finally(() => setBusy(false));
      }}>
        <h3>{C.title}</h3>
        <label>{C.name}<input value={name} placeholder={C.namePlaceholder} maxLength={40} onChange={(e) => setName(e.target.value)} required/></label>
        <div className="task-filters" role="group" aria-label={C.preset}>
          {(["family", "project", "blank"] as const).map((p) => <button key={p} type="button" className="task-filter" aria-pressed={preset === p} onClick={() => { setPreset(p); setRules(presets[p]); }}>{C.presets[p]}</button>)}
        </div>
        <label>{C.rules}<textarea rows={8} value={rules} onChange={(e) => setRules(e.target.value)} maxLength={4000}/></label>
        <p className="muted tiny">{C.rulesHint}</p>
        <div className="schedule-actions">
          <button type="button" className="ghost tiny" onClick={onCancel}>{t.knowledge.list.cancel}</button>
          <button type="submit" className="primary tiny" disabled={busy || !name.trim()}>{C.submit}</button>
        </div>
      </form>
    </div>
  </section>;
}
