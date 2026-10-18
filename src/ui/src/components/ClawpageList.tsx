import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Clawpage, ClawpagePermission, ClawpageRecord, ClawpageTable } from "../types";
import { hasNativeBrowser, openNativeBrowser } from "../deviceBrowser";
import { onDownloadClick } from "../saveFile";
import { InlineLoading } from "./Brand";
import { MessageTime, useDisplayClock } from "./MessageTime";
import { t } from "../i18n";

const PERMISSIONS: ClawpagePermission[] = ["private", "read-public", "public"];

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

function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The account's clawpages: the pages and mini apps its AI published, each with its
 * link, its data tables and what they hold. The owner opens a page with an owner link
 * (every table readable and writable for a while), shares the plain link, looks
 * through and moderates the data, changes who may use a table, and deletes. Changing
 * a page itself is the main session's job.
 */
export function ClawpageList({ active, onExpired }: { active: boolean; onExpired: () => void }) {
  const [pages, setPages] = useState<Clawpage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  return <section className="library-page clawpages-page" aria-label={t.clawpages.title}>
    <header className="chat-head"><div className="chat-title"><h2>{t.clawpages.title}</h2><span className="library-sub muted tiny">{t.clawpages.sub}</span></div></header>
    <div className="task-list-scroll">
      {pages && pages.length === 0 && <div className="empty"><h3>{t.clawpages.emptyTitle}</h3><p>{t.clawpages.emptyBody}</p></div>}
      {pages && pages.length > 0 && <p className="clawpages-tip muted tiny">{t.clawpages.tip}</p>}
      {pages && pages.length > 0 && <ul className="clawpages-list" data-testid="clawpages">
        {pages.map((page) => <ClawpageItem key={page.name} page={page} onChanged={() => void load()} onRemoved={() => setPages((old) => old?.filter((p) => p.name !== page.name) ?? null)} onError={fail}/>)}
      </ul>}
      {error && <p className="error" role="alert">{error}{!loading && <> <button type="button" className="ghost" onClick={() => void load()}>{t.clawpages.retry}</button></>}</p>}
      {loading && !pages && <div className="task-list-end"><span className="muted tiny"><InlineLoading label={t.clawpages.loading}/></span></div>}
    </div>
  </section>;
}

function ClawpageItem({ page, onChanged, onRemoved, onError }: { page: Clawpage; onChanged: () => void; onRemoved: () => void; onError: (err: unknown) => void }) {
  const now = useDisplayClock();
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showData, setShowData] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const records = page.tables.reduce((n, table) => n + table.records, 0);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

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

  return <li className="clawpage-item" data-page={page.name} aria-label={t.clawpages.pageLabel(page.title)}>
    <div className="clawpage-head">
      <strong className="clawpage-title">{page.title}</strong>
      <span className="clawpage-meta muted tiny"><span>{page.name}</span><MessageTime at={page.updatedAt} now={now}/><span>{sizeLabel(page.bytes)}</span></span>
    </div>
    <a className="clawpage-url muted tiny" href={page.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (openNativeBrowser(page.url)) event.preventDefault(); }}>{page.url}</a>
    <div className="clawpage-tables">
      {page.tables.length === 0
        ? <span className="task-tag">{t.clawpages.staticPage}</span>
        : page.tables.map((table) => <span key={table.name} className={`clawpage-chip ${table.permission}`} title={t.clawpages.permissionHints[table.permission]}>{table.name} · {t.clawpages.permissions[table.permission]} · {t.clawpages.records(table.records)}</span>)}
    </div>
    <div className="clawpage-actions">
      <button type="button" className="primary tiny" disabled={opening} title={t.clawpages.openHint} onClick={() => void open()}>{opening ? t.clawpages.opening : t.clawpages.open}</button>
      <button type="button" className="ghost tiny" onClick={() => void copyText(page.url).then((ok) => setCopied(ok ? "ok" : "failed"))}>{copied === "ok" ? t.clawpages.copied : copied === "failed" ? t.clawpages.copyFailed : t.clawpages.copy}</button>
      {canShare && <button type="button" className="ghost tiny" onClick={() => void navigator.share({ title: page.title, url: page.url }).catch(() => undefined)}>{t.clawpages.share}</button>}
      {page.tables.length > 0 && <button type="button" className="ghost tiny" aria-expanded={showData} onClick={() => setShowData((v) => !v)}>{showData ? t.clawpages.hideData : `${t.clawpages.data} · ${records}`}</button>}
      <span className="spacer"/>
      {!confirming && <button type="button" className="ghost tiny" onClick={() => setConfirming(true)}>{t.clawpages.delete}</button>}
    </div>
    {confirming && <div className="clawpage-confirm" role="alertdialog" aria-label={t.clawpages.deleteHint(page.title)}>
      <span className="tiny">{t.clawpages.deleteHint(page.title)}</span>
      <span className="clawpage-confirm-actions"><button type="button" className="ghost tiny" disabled={deleting} onClick={() => setConfirming(false)}>{t.clawpages.cancel}</button><button type="button" className="danger tiny" disabled={deleting} onClick={() => void remove()}>{deleting ? t.clawpages.deleting : t.clawpages.confirmDelete}</button></span>
    </div>}
    {showData && <ClawpageData page={page} onChanged={onChanged} onError={onError}/>}
  </li>;
}

function ClawpageData({ page, onChanged, onError }: { page: Clawpage; onChanged: () => void; onError: (err: unknown) => void }) {
  const now = useDisplayClock();
  const [selected, setSelected] = useState(page.tables[0]?.name ?? "");
  const table: ClawpageTable | undefined = page.tables.find((x) => x.name === selected) ?? page.tables[0];
  const [records, setRecords] = useState<ClawpageRecord[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dropping, setDropping] = useState<"ask" | "busy" | null>(null);
  /** The record whose delete button was tapped once: the second tap deletes it. */
  const [armed, setArmed] = useState<string | null>(null);

  const fetchRecords = useCallback(async (after: string | null) => {
    if (!table) return;
    setLoading(true);
    try {
      const out = await api.clawpageRecords(page.name, table.name, after);
      setRecords((old) => after ? [...old, ...out.records] : out.records);
      setNext(out.nextCursor);
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [page.name, table?.name, onError]);
  useEffect(() => { setRecords([]); setNext(null); setDropping(null); void fetchRecords(null); }, [fetchRecords, table?.updatedAt]);

  if (!table) return null;
  const permission = async (value: ClawpagePermission) => {
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
  const removeRecord = async (key: string) => {
    if (armed !== key) { setArmed(key); return; }
    setArmed(null);
    try {
      await api.clawpageDeleteRecord(page.name, table.name, key);
      setRecords((old) => old.filter((r) => r.key !== key));
      onChanged();
    } catch (err) {
      onError(err);
    }
  };

  return <div className="clawpage-data" data-testid="clawpage-data">
    {page.tables.length > 1 && <div className="task-filters" role="group" aria-label={t.clawpages.tables}>
      {page.tables.map((x) => <button key={x.name} type="button" className="task-filter" aria-pressed={x.name === table.name} onClick={() => setSelected(x.name)}>{x.name}<span className="task-filter-count">{x.records}</span></button>)}
    </div>}
    <div className="clawpage-table-tools">
      <label className="clawpage-permission tiny">{t.clawpages.permission}
        <select value={table.permission} onChange={(event) => void permission(event.target.value as ClawpagePermission)}>
          {PERMISSIONS.map((p) => <option key={p} value={p}>{t.clawpages.permissions[p]}</option>)}
        </select>
      </label>
      <span className="muted tiny">{t.clawpages.permissionHints[table.permission]}</span>
      <span className="spacer"/>
      <a className="tiny share-card-open clawpage-export" href={api.clawpageExportUrl(page.name, table.name)} download={`${page.name}-${table.name}.json`} onClick={onDownloadClick}>{t.clawpages.exportJson}</a>
      {dropping === null && <button type="button" className="ghost tiny" onClick={() => setDropping("ask")}>{t.clawpages.dropTable}</button>}
    </div>
    {dropping !== null && <div className="clawpage-confirm" role="alertdialog" aria-label={t.clawpages.dropHint(table.name)}>
      <span className="tiny">{t.clawpages.dropHint(table.name)}</span>
      <span className="clawpage-confirm-actions"><button type="button" className="ghost tiny" disabled={dropping === "busy"} onClick={() => setDropping(null)}>{t.clawpages.cancel}</button><button type="button" className="danger tiny" disabled={dropping === "busy"} onClick={() => void drop()}>{t.clawpages.confirmDrop}</button></span>
    </div>}
    {records.length === 0 && !loading && <p className="muted tiny">{t.clawpages.noRecords}</p>}
    {records.length > 0 && <ul className="clawpage-records">
      {records.map((r) => <li key={r.key} className="clawpage-record" data-key={r.key}>
        <div className="clawpage-record-head"><code>{r.key}</code><MessageTime at={r.updatedAt} now={now}/><span className="spacer"/>
          <button type="button" className={`tiny clawpage-record-delete ${armed === r.key ? "danger" : "ghost"}`} aria-label={t.clawpages.deleteRecord(r.key)} title={t.clawpages.deleteRecord(r.key)} onClick={() => void removeRecord(r.key)}>{armed === r.key ? t.clawpages.confirmDelete : "×"}</button></div>
        <pre className="clawpage-record-value">{JSON.stringify(r.value, null, 2)}</pre>
      </li>)}
    </ul>}
    {loading ? <span className="muted tiny"><InlineLoading label={t.clawpages.loading}/></span> : next && <button type="button" className="ghost tiny" onClick={() => void fetchRecords(next)}>{t.clawpages.more}</button>}
  </div>;
}
