import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../api";
import type { Clawpage, ClawpageCollaborator, ClawpagePermission, ClawpageRecord, ClawpageVersion } from "../types";
import { hasNativeBrowser, openNativeBrowser } from "../deviceBrowser";
import { onDownloadClick } from "../saveFile";
import { InlineLoading } from "./Brand";
import { MessageTime, useDisplayClock } from "./MessageTime";
import { PopupPresence, PopupSurface } from "./PopupMotion";
import { useClawpageCover } from "../clawpageCover";
import { t } from "../i18n";

const PERMISSIONS: ClawpagePermission[] = ["private", "read-public", "public", "signed-in", "per-user"];
/** Columns shown for object records; the rest of a record is in its tooltip. */
const MAX_COLUMNS = 5;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** The icon's one character: the title's first, a letter capitalized. */
function glyph(title: string): string {
  const first = Array.from(title.trim())[0] ?? "?";
  return first.toLocaleUpperCase();
}

const records = (page: Clawpage) => page.tables.reduce((n, table) => n + table.records, 0);

/** A clawpage's picture: its cover (the page as a phone shows it), else its title's first character. */
function Cover({ page, className, count = false }: { page: Clawpage; className: string; count?: boolean }) {
  const url = useClawpageCover(page.cover ? page.name : null, page.cover);
  return <span className={`${className}${url ? " has-cover" : ""}`} aria-hidden="true">
    {url ? <img src={url} alt="" decoding="async" draggable={false}/> : <span className="clawpage-cover-glyph">{glyph(page.title)}</span>}
    {count && page.tables.length > 0 && <span className="clawpage-cover-count">{t.clawpages.count(records(page))}</span>}
  </span>;
}

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
}
const COPY = "M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5Z M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H9";
const SHARE = "M12 15V4 M8 7.5 12 4l4 3.5 M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1";
const CLOSE = "M6 6l12 12 M18 6 6 18";

/**
 * The account's clawpages as a home screen: one icon each, newest first, whether or
 * not a page keeps data (all of them are clawpages). An icon opens the clawpage's sheet: open it as the
 * owner, copy or share its link, look through its data, invite other people's
 * agents to maintain it, delete it. Changing a page itself is an agent's job.
 */
export function ClawpageList({ active, onExpired }: { active: boolean; onExpired: () => void }) {
  const [pages, setPages] = useState<Clawpage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) onExpired();
    setError(err instanceof Error ? err.message : t.clawpages.loadFailed);
  }, [onExpired]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPages((await api.clawpages()).pages);
      setError(null);
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [fail]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const page = pages?.find((p) => p.name === selected) ?? null;
  const shelf = (list: Clawpage[]) => list.length > 0 && <section className="clawpage-shelf">
    <ul className="clawpage-grid" data-testid="clawpage-list">
      {list.map((p) => <li key={p.name} data-page={p.name}>
        <button type="button" className="clawpage-tile" aria-label={t.clawpages.pageLabel(p.title)} onClick={() => setSelected(p.name)}>
          <Cover page={p} className="clawpage-cover" count/>
          <span className="clawpage-tile-title">{p.title}</span>
        </button>
      </li>)}
    </ul>
  </section>;

  return <section className="library-page clawpages-page" aria-label={t.clawpages.title}>
    <header className="chat-head"><div className="chat-title"><h2>{t.clawpages.title}</h2><span className="library-sub muted tiny">{t.clawpages.sub}</span></div></header>
    <div className="task-list-scroll">
      {pages && pages.length === 0 && <div className="empty clawpages-empty">
        <span className="clawpage-glyph" aria-hidden="true">+</span>
        <h3>{t.clawpages.emptyTitle}</h3><p>{t.clawpages.emptyBody}</p>
      </div>}
      {shelf(pages ?? [])}
      {error && <p className="error clawpages-error" role="alert">{error}{!loading && <> <button type="button" className="ghost" onClick={() => void load()}>{t.clawpages.retry}</button></>}</p>}
      {loading && !pages && <div className="task-list-end"><span className="muted tiny"><InlineLoading label={t.clawpages.loading}/></span></div>}
    </div>
    <PopupPresence>{page && <ClawpageSheet page={page} onClose={() => setSelected(null)} onChanged={() => void load()}
      onRemoved={() => { setSelected(null); setPages((old) => old?.filter((p) => p.name !== page.name) ?? null); }} onError={fail}/>}</PopupPresence>
  </section>;
}

function ClawpageSheet({ page, onClose, onChanged, onRemoved, onError }: { page: Clawpage; onClose: () => void; onChanged: () => void; onRemoved: () => void; onError: (err: unknown) => void }) {
  const now = useDisplayClock();
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const hasData = page.tables.length > 0;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The owner link is made on the server; a window opened in the tap itself is not blocked while it comes.
  const open = async () => {
    const pending = hasNativeBrowser() ? null : window.open("about:blank", "_blank");
    setOpening(true);
    try {
      const { url } = await api.clawpageOpen(page.name);
      if (pending) {
        pending.opener = null;
        pending.location.href = url;
      } else if (!openNativeBrowser(url)) window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      pending?.close();
      onError(err);
    } finally {
      setOpening(false);
    }
  };
  const remove = async () => {
    setDeleting(true);
    try {
      await api.clawpageDelete(page.name);
      onRemoved();
    } catch (err) {
      onError(err);
      setDeleting(false);
    }
  };

  return createPortal(
    <PopupSurface className="file-preview-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="file-preview clawpage-sheet" role="dialog" aria-modal="true" aria-labelledby="clawpage-sheet-title" data-page={page.name}>
        <Cover page={page} className="clawpage-sheet-cover"/>
        <header className="clawpage-sheet-head">
          <div className="clawpage-sheet-name">
            <h2 id="clawpage-sheet-title">{page.title}</h2>
            <p className="muted tiny">{page.tables.length > 0 && t.clawpages.summaryData(page.tables.length, records(page))}<MessageTime at={Math.max(page.updatedAt, ...page.tables.map((x) => x.updatedAt))} now={now}/>{page.updatedBy && <span className="clawpage-updated-by">{t.clawpages.updatedBy(page.updatedBy)}</span>}</p>
          </div>
          <button type="button" className="ghost clawpage-icon-button" aria-label={t.clawpages.close} title={t.clawpages.close} onClick={onClose}><Icon d={CLOSE}/></button>
        </header>
        <div className="clawpage-sheet-actions">
          <button type="button" className="primary" disabled={opening} title={t.clawpages.openHint} onClick={() => void open()}>{opening ? t.clawpages.opening : t.clawpages.open}</button>
          <button type="button" className="ghost clawpage-icon-button" aria-label={t.clawpages.copy} title={t.clawpages.copy} onClick={() => void copyText(page.url).then((ok) => setCopied(ok ? "ok" : "failed"))}><Icon d={COPY}/></button>
          {canShare && <button type="button" className="ghost clawpage-icon-button" aria-label={t.clawpages.share} title={t.clawpages.share} onClick={() => void navigator.share({ title: page.title, url: page.url }).catch(() => undefined)}><Icon d={SHARE}/></button>}
          <span className="clawpage-copied tiny" role="status">{copied === "ok" ? t.clawpages.copied : copied === "failed" ? t.clawpages.copyFailed : ""}</span>
        </div>
        <div className="clawpage-sheet-body">
          {hasData && <ClawpageData page={page} onChanged={onChanged} onError={onError}/>}
          <p className="clawpage-tip muted tiny">{t.clawpages.tip}</p>
          <ClawpageCollaborators page={page} onChanged={onChanged} onError={onError}/>
          <ClawpageVersions page={page} onChanged={onChanged} onError={onError}/>
          {confirming
            ? <div className="clawpage-confirm" role="alertdialog" aria-label={t.clawpages.deleteHint}>
              <span className="tiny">{t.clawpages.deleteHint}</span>
              <span className="clawpage-confirm-actions"><button type="button" className="ghost tiny" disabled={deleting} onClick={() => setConfirming(false)}>{t.clawpages.cancel}</button><button type="button" className="danger tiny" disabled={deleting} onClick={() => void remove()}>{deleting ? t.clawpages.deleting : t.clawpages.confirmDelete}</button></span>
            </div>
            : <button type="button" className="danger-text tiny clawpage-delete" onClick={() => setConfirming(true)}>{t.clawpages.delete}</button>}
        </div>
      </div>
    </PopupSurface>,
    document.body,
  );
}

/**
 * Other people's agents allowed to maintain the page. A new one comes with its invitation (the API,
 * its token and how to start), shown here once to copy and pass on; a collaborator can be removed any time.
 */
function ClawpageCollaborators({ page, onChanged, onError }: { page: Clawpage; onChanged: () => void; onError: (err: unknown) => void }) {
  const now = useDisplayClock();
  const [list, setList] = useState<ClawpageCollaborator[] | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  /** The collaborator whose remove was tapped once: the second tap removes it. */
  const [armed, setArmed] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await api.clawpageCollaborators(page.name)).collaborators);
    } catch (err) {
      onError(err);
    }
  }, [page.name, onError]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const invite = async () => {
    if (!label.trim()) return;
    setBusy(true);
    try {
      const out = await api.clawpageInvite(page.name, label.trim());
      setInvitation(out.invitation);
      setLabel("");
      void load();
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    if (armed !== id) { setArmed(id); return; }
    setArmed(null);
    try {
      await api.clawpageRevoke(page.name, id);
      setList((old) => old?.filter((c) => c.id !== id) ?? null);
      onChanged();
    } catch (err) {
      onError(err);
    }
  };

  return <section className="clawpage-collab" aria-labelledby="clawpage-collab-title" data-testid="clawpage-collab">
    <h3 id="clawpage-collab-title">{t.clawpages.collabTitle}</h3>
    <p className="muted tiny">{t.clawpages.collabIntro}</p>
    {invitation && <div className="clawpage-invitation" data-testid="clawpage-invitation">
      <p className="tiny">{t.clawpages.invitationHint}</p>
      <textarea readOnly value={invitation} rows={7} aria-label={t.clawpages.copyInvitation} onFocus={(event) => event.currentTarget.select()}/>
      <div className="clawpage-invitation-actions">
        <button type="button" className="primary" onClick={() => void copyText(invitation).then((ok) => setCopied(ok ? "ok" : "failed"))}>{t.clawpages.copyInvitation}</button>
        <span className="clawpage-copied tiny" role="status">{copied === "ok" ? t.clawpages.invitationCopied : copied === "failed" ? t.clawpages.copyFailed : ""}</span>
        <span className="spacer"/>
        <button type="button" className="ghost" onClick={() => setInvitation(null)}>{t.clawpages.done}</button>
      </div>
    </div>}
    {list && list.length > 0 && <ul className="clawpage-collab-list">
      {list.map((c) => <li key={c.id} data-id={c.id}>
        <span className="clawpage-collab-name">{c.label}</span>
        <span className="muted tiny">{c.lastUsedAt ? <>{t.clawpages.lastUsed} <MessageTime at={c.lastUsedAt} now={now}/></> : t.clawpages.neverUsed}</span>
        <button type="button" className={`tiny clawpage-row-delete ${armed === c.id ? "danger" : "ghost"}`} aria-label={t.clawpages.revoke(c.label)} title={t.clawpages.revoke(c.label)} onClick={() => void revoke(c.id)}>{armed === c.id ? t.clawpages.confirmRevoke : <Icon d={CLOSE}/>}</button>
      </li>)}
    </ul>}
    <form className="clawpage-collab-new" onSubmit={(event) => { event.preventDefault(); void invite(); }}>
      <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.clawpages.collabPlaceholder} aria-label={t.clawpages.collabLabel} maxLength={80}/>
      <button type="submit" className="ghost" disabled={busy || !label.trim()}>{busy ? t.clawpages.inviting : t.clawpages.invite}</button>
    </form>
  </section>;
}

/**
 * The versions publishes replaced, to make one the live page again (its files only; the data stays).
 * Folded until asked for, and only then read; restoring takes two taps.
 */
function ClawpageVersions({ page, onChanged, onError }: { page: Clawpage; onChanged: () => void; onError: (err: unknown) => void }) {
  const now = useDisplayClock();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ClawpageVersion[] | null>(null);
  /** The version whose restore was tapped once: the second tap restores it. */
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const load = useCallback(async () => {
    try {
      setList((await api.clawpageVersions(page.name)).versions);
    } catch (err) {
      onError(err);
    }
  }, [page.name, onError]);
  useEffect(() => { if (open) void load(); }, [open, load, page.updatedAt]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(timer);
  }, [done]);

  const restore = async (at: number) => {
    if (armed !== at) { setArmed(at); return; }
    setArmed(null);
    setBusy(at);
    try {
      await api.clawpageRestore(page.name, at);
      onChanged();
      setDone(true);
      void load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  return <section className="clawpage-versions" data-testid="clawpage-versions">
    <h3><button type="button" className="clawpage-versions-toggle" aria-expanded={open} aria-controls="clawpage-versions-list" onClick={() => setOpen((o) => !o)}>
      <span>{t.clawpages.versionsTitle}</span><span className="clawpage-versions-chevron" aria-hidden="true"/>
    </button></h3>
    <div id="clawpage-versions-list" className="clawpage-versions-panel" hidden={!open}>
      {open && <>
        <p className="muted tiny">{t.clawpages.versionsIntro}</p>
        {list === null && <span className="muted tiny"><InlineLoading label={t.clawpages.loading}/></span>}
        {list && list.length === 0 && <p className="muted tiny">{t.clawpages.versionsEmpty}</p>}
        {list && list.length > 0 && <ul className="clawpage-versions-list">
          {list.map((v) => <li key={v.at} data-at={v.at}>
            <span className="clawpage-version-info">
              <span className="clawpage-version-time"><MessageTime at={v.at} now={now}/></span>
              <span className="muted tiny">{v.restoredFrom ? <>{t.clawpages.versionRestoredFrom} <MessageTime at={v.restoredFrom} now={now}/></> : v.updatedBy ? t.clawpages.versionBy(v.updatedBy) : t.clawpages.versionByYou}</span>
              <span className="muted tiny">{t.clawpages.versionSize(v.files, v.bytes)}</span>
            </span>
            <button type="button" className={`tiny clawpage-version-restore ${armed === v.at ? "danger" : "ghost"}`} disabled={busy !== null} aria-label={t.clawpages.restoreVersion} title={t.clawpages.restoreVersion} onClick={() => void restore(v.at)}>
              {busy === v.at ? t.clawpages.restoring : armed === v.at ? t.clawpages.confirmRestore : t.clawpages.restoreVersion}
            </button>
          </li>)}
        </ul>}
        <span className="clawpage-copied tiny" role="status">{done ? t.clawpages.restored : ""}</span>
      </>}
    </div>
  </section>;
}

/** A cell's text: strings as written, anything else as compact JSON. */
function cell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function ClawpageData({ page, onChanged, onError }: { page: Clawpage; onChanged: () => void; onError: (err: unknown) => void }) {
  const now = useDisplayClock();
  const [selected, setSelected] = useState(page.tables[0]?.name ?? "");
  const table = page.tables.find((x) => x.name === selected) ?? page.tables[0];
  const [rows, setRows] = useState<ClawpageRecord[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dropping, setDropping] = useState<"ask" | "busy" | null>(null);
  /** The record whose delete was tapped once: the second tap deletes it. */
  const [armed, setArmed] = useState<string | null>(null);

  const fetchRows = useCallback(async (after: string | null) => {
    if (!table) return;
    setLoading(true);
    try {
      const out = await api.clawpageRecords(page.name, table.name, after);
      setRows((old) => after ? [...old, ...out.records] : out.records);
      setNext(out.nextCursor);
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [page.name, table?.name, onError]);
  useEffect(() => { setRows([]); setNext(null); setDropping(null); setArmed(null); void fetchRows(null); }, [fetchRows, table?.updatedAt]);

  // Object records become columns (their first keys); anything else is one column.
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const r of rows) if (isObject(r.value)) for (const k of Object.keys(r.value)) if (!keys.includes(k)) keys.push(k);
    return keys.slice(0, MAX_COLUMNS);
  }, [rows]);
  // Records written by signed-in visitors say who.
  const authored = rows.some((r) => r.by);

  if (!table) return null;
  const permission = async (value: ClawpagePermission) => {
    if (value === table.permission) return;
    try {
      await api.clawpagePermission(page.name, table.name, value);
      onChanged();
    } catch (err) {
      onError(err);
    }
  };
  const drop = async () => {
    setDropping("busy");
    try {
      await api.clawpageDropTable(page.name, table.name);
      onChanged();
    } catch (err) {
      onError(err);
      setDropping(null);
    }
  };
  const removeRow = async (key: string) => {
    if (armed !== key) { setArmed(key); return; }
    setArmed(null);
    try {
      await api.clawpageDeleteRecord(page.name, table.name, key);
      setRows((old) => old.filter((r) => r.key !== key));
      onChanged();
    } catch (err) {
      onError(err);
    }
  };

  return <div className="clawpage-data" data-testid="clawpage-data">
    {page.tables.length > 1 && <div className="clawpage-tabs" role="tablist" aria-label={t.clawpages.summaryData(page.tables.length, records(page))}>
      {page.tables.map((x) => <button key={x.name} type="button" role="tab" aria-selected={x.name === table.name} className="clawpage-tab" onClick={() => setSelected(x.name)}>{x.name}<span>{x.records}</span></button>)}
    </div>}
    <div className="clawpage-table-tools">
      <div className="clawpage-segments" role="radiogroup" aria-label={t.clawpages.permission}>
        {PERMISSIONS.map((p) => <button key={p} type="button" role="radio" aria-checked={p === table.permission} className={`clawpage-segment ${p}`} title={t.clawpages.permissionHints[p]} onClick={() => void permission(p)}>{t.clawpages.permissions[p]}</button>)}
      </div>
      <span className="spacer"/>
      <a className="tiny share-card-open clawpage-export" href={api.clawpageExportUrl(page.name, table.name)} download={`${page.name}-${table.name}.json`} onClick={onDownloadClick}>{t.clawpages.exportJson}</a>
      {dropping === null && <button type="button" className="ghost tiny" onClick={() => setDropping("ask")}>{t.clawpages.dropTable}</button>}
    </div>
    <p className="clawpage-permission-hint muted tiny">{t.clawpages.permissionHints[table.permission]}</p>
    {dropping !== null && <div className="clawpage-confirm" role="alertdialog" aria-label={t.clawpages.dropHint(table.name)}>
      <span className="tiny">{t.clawpages.dropHint(table.name)}</span>
      <span className="clawpage-confirm-actions"><button type="button" className="ghost tiny" disabled={dropping === "busy"} onClick={() => setDropping(null)}>{t.clawpages.cancel}</button><button type="button" className="danger tiny" disabled={dropping === "busy"} onClick={() => void drop()}>{t.clawpages.confirmDrop}</button></span>
    </div>}
    {rows.length === 0 && !loading && <p className="clawpage-no-rows muted tiny">{t.clawpages.noRecords}</p>}
    {rows.length > 0 && <div className="clawpage-table-wrap">
      <table className="clawpage-table">
        <thead><tr>
          <th scope="col">{t.clawpages.timeColumn}</th>
          {authored && <th scope="col">{t.clawpages.byColumn}</th>}
          {columns.length ? columns.map((c) => <th key={c} scope="col">{c}</th>) : <th scope="col">{t.clawpages.valueColumn}</th>}
          <th scope="col" aria-label={t.clawpages.confirmDeleteRecord}/>
        </tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key} data-key={r.key} title={JSON.stringify(r.value, null, 2)}>
          <td className="clawpage-time"><MessageTime at={r.updatedAt} now={now}/></td>
          {authored && <td>{r.by ? r.by.email ?? r.by.name : ""}</td>}
          {columns.length ? columns.map((c) => <td key={c}>{isObject(r.value) ? cell(r.value[c]) : ""}</td>) : <td>{cell(r.value)}</td>}
          <td className="clawpage-row-action"><button type="button" className={`tiny clawpage-row-delete ${armed === r.key ? "danger" : "ghost"}`} aria-label={t.clawpages.deleteRecord(r.key)} title={t.clawpages.deleteRecord(r.key)} onClick={() => void removeRow(r.key)}>{armed === r.key ? t.clawpages.confirmDeleteRecord : <Icon d={CLOSE}/>}</button></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {loading ? <span className="muted tiny"><InlineLoading label={t.clawpages.loading}/></span> : next && <button type="button" className="ghost tiny clawpage-more" onClick={() => void fetchRows(next)}>{t.clawpages.more}</button>}
  </div>;
}
