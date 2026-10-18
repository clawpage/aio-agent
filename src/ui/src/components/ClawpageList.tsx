import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../api";
import type { Clawpage, ClawpagePermission, ClawpageRecord } from "../types";
import { hasNativeBrowser, openNativeBrowser } from "../deviceBrowser";
import { onDownloadClick } from "../saveFile";
import { InlineLoading } from "./Brand";
import { MessageTime, useDisplayClock } from "./MessageTime";
import { PopupPresence, PopupSurface } from "./PopupMotion";
import { useClawpageCover } from "../clawpageCover";
import { t } from "../i18n";

const PERMISSIONS: ClawpagePermission[] = ["private", "read-public", "public"];
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
  const app = page.tables.length > 0;
  return <span className={`${className} ${app ? "is-app" : "is-page"}${url ? " has-cover" : ""}`} aria-hidden="true">
    {url ? <img src={url} alt="" decoding="async" draggable={false}/> : <span className="clawpage-cover-glyph">{glyph(page.title)}</span>}
    {count && app && <span className="clawpage-cover-count">{t.clawpages.count(records(page))}</span>}
  </span>;
}

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
}
const COPY = "M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5Z M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H9";
const SHARE = "M12 15V4 M8 7.5 12 4l4 3.5 M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1";
const CLOSE = "M6 6l12 12 M18 6 6 18";

/**
 * The account's clawpages as a home screen: one icon each, mini apps (pages with
 * data) apart from plain pages. An icon opens the clawpage's sheet: open it as the
 * owner, copy or share its link, look through its data, delete it. Changing a page
 * itself is the main session's job.
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

  const apps = pages?.filter((p) => p.tables.length > 0) ?? [];
  const plain = pages?.filter((p) => p.tables.length === 0) ?? [];
  const page = pages?.find((p) => p.name === selected) ?? null;
  const shelf = (label: string, list: Clawpage[], kind: "app" | "page") => list.length > 0 && <section className="clawpage-shelf" aria-label={label}>
    <h3 className="clawpage-shelf-head">{label}<span>{list.length}</span></h3>
    <ul className="clawpage-grid" data-testid={`clawpage-${kind}s`}>
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
        <span className="clawpage-glyph is-app" aria-hidden="true">+</span>
        <h3>{t.clawpages.emptyTitle}</h3><p>{t.clawpages.emptyBody}</p>
      </div>}
      {shelf(t.clawpages.apps, apps, "app")}
      {shelf(t.clawpages.pages, plain, "page")}
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
  const app = page.tables.length > 0;
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
            <p className="muted tiny">{app ? t.clawpages.summaryApp(page.tables.length, records(page)) : t.clawpages.summaryPage}<MessageTime at={Math.max(page.updatedAt, ...page.tables.map((x) => x.updatedAt))} now={now}/></p>
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
          {app && <ClawpageData page={page} onChanged={onChanged} onError={onError}/>}
          <p className="clawpage-tip muted tiny">{t.clawpages.tip}</p>
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
    {page.tables.length > 1 && <div className="clawpage-tabs" role="tablist" aria-label={t.clawpages.summaryApp(page.tables.length, records(page))}>
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
          {columns.length ? columns.map((c) => <th key={c} scope="col">{c}</th>) : <th scope="col">{t.clawpages.valueColumn}</th>}
          <th scope="col" aria-label={t.clawpages.confirmDeleteRecord}/>
        </tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key} data-key={r.key} title={JSON.stringify(r.value, null, 2)}>
          <td className="clawpage-time"><MessageTime at={r.updatedAt} now={now}/></td>
          {columns.length ? columns.map((c) => <td key={c}>{isObject(r.value) ? cell(r.value[c]) : ""}</td>) : <td>{cell(r.value)}</td>}
          <td className="clawpage-row-action"><button type="button" className={`tiny clawpage-row-delete ${armed === r.key ? "danger" : "ghost"}`} aria-label={t.clawpages.deleteRecord(r.key)} title={t.clawpages.deleteRecord(r.key)} onClick={() => void removeRow(r.key)}>{armed === r.key ? t.clawpages.confirmDeleteRecord : <Icon d={CLOSE}/>}</button></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {loading ? <span className="muted tiny"><InlineLoading label={t.clawpages.loading}/></span> : next && <button type="button" className="ghost tiny clawpage-more" onClick={() => void fetchRows(next)}>{t.clawpages.more}</button>}
  </div>;
}
