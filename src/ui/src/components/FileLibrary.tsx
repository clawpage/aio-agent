import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { FileMessage } from "../types";
import { FILE_SHELVES, fileShelf, libraryFiles, type FileShelf, type LibraryFile } from "../fileLibrary";
import { FileCard } from "./FileCard";
import { FilePreview } from "./FilePreview";
import { PopupPresence } from "./PopupMotion";
import { InlineLoading } from "./Brand";
import { MessageTime, useDisplayClock } from "./MessageTime";
import { t } from "../i18n";

/**
 * Every file the AI made in the main session in one place, newest first, on a few shelves by
 * type. The server sends the messages that hold files a page at a time; the next
 * page is asked for as the end of the list scrolls into view (and keeps coming
 * while a shelf has too few to fill the screen). Coming back to the page reads it
 * again from the top, so a file from a reply just finished is there.
 */
export function FileLibrary({ active, onOpenTask, onOpenLink, onOpenFileInBrowser, onExpired }: {
  active: boolean;
  onOpenTask: (taskId: string) => void;
  onOpenLink: (url: string) => void;
  onOpenFileInBrowser?: (path: string) => void;
  onExpired: () => void;
}) {
  const [shelf, setShelf] = useState<FileShelf>("all");
  const [messages, setMessages] = useState<FileMessage[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const seq = useRef(0);
  /** The page last asked for: retried as it was after a failure. */
  const asked = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(async (before: number | null) => {
    const ticket = ++seq.current;
    asked.current = before;
    setLoading(true);
    try {
      const page = await api.mainFiles(before ?? undefined);
      if (ticket !== seq.current) return;
      setMessages((old) => before === null ? page.messages : [...old, ...page.messages]);
      setNext(page.nextBefore);
      setLoaded(true);
      setError(null);
    } catch (err) {
      if (ticket !== seq.current) return;
      if (err instanceof ApiError && err.status === 401) onExpired();
      setError(err instanceof Error ? err.message : t.library.loadFailed);
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [onExpired]);

  useEffect(() => { if (active) void fetchPage(null); }, [active, fetchPage]);

  const state = useRef({ next, loading, error });
  state.current = { next, loading, error };
  const more = useCallback(() => {
    const s = state.current, box = scroller.current, end = sentinel.current;
    if (!active || s.next === null || s.loading || s.error || !box || !end) return;
    if (end.getBoundingClientRect().top - box.getBoundingClientRect().bottom < 400) void fetchPage(s.next);
  }, [active, fetchPage]);
  useEffect(() => {
    const box = scroller.current, end = sentinel.current;
    if (!box || !end) return;
    const observer = new IntersectionObserver(() => more(), { root: box, rootMargin: "0px 0px 400px 0px" });
    observer.observe(end);
    return () => observer.disconnect();
  }, [more]);
  // A shelf with few files leaves the end in view without a scroll: keep filling.
  useEffect(() => { if (!loading) more(); }, [messages, next, loading, shelf, more]);

  const files = useMemo(() => libraryFiles(messages), [messages]);
  const shown = useMemo(() => shelf === "all" ? files : files.filter((file) => fileShelf(file.kind) === shelf), [files, shelf]);
  const now = useDisplayClock();
  const grid = shelf === "images";
  const source = (file: LibraryFile) => <div className="library-source muted tiny">
    <button type="button" className="library-task" onClick={() => onOpenTask(file.taskId)} title={t.library.openTask(file.taskTitle)} aria-label={t.library.openTask(file.taskTitle)}>{file.taskTitle}</button>
    <MessageTime at={file.at} now={now}/>
  </div>;

  return <section className="library-page" aria-label={t.library.title}>
    <header className="chat-head"><div className="chat-title"><h2>{t.library.title}</h2><span className="library-sub muted tiny">{t.library.sub}</span></div></header>
    <div className="task-list-scroll" ref={scroller}>
      {loaded && files.length === 0 && next === null && !error && <div className="empty"><h3>{t.library.emptyTitle}</h3><p>{t.library.emptyBody}</p></div>}
      {files.length > 0 && <div className="task-list-tools">
        <div className="task-filters" role="group" aria-label={t.library.shelfGroup}>{FILE_SHELVES.map((id) => <button key={id} type="button" className="task-filter" aria-pressed={shelf === id} onClick={() => setShelf(id)}>{t.library.shelves[id]}</button>)}</div>
      </div>}
      {files.length > 0 && shown.length === 0 && next === null && !loading && <div className="empty"><p>{t.library.shelfEmpty}</p></div>}
      {shown.length > 0 && <ul className={grid ? "library-grid" : "library-list"} data-testid="library-files">
        {shown.map((file) => <li key={file.path} className="library-item" data-path={file.path}>
          <FileCard path={file.path} name={file.name} title={file.title} kind={file.kind} onOpen={setPreview} media={grid}/>
          {source(file)}
        </li>)}
      </ul>}
      {error && <p className="error" role="alert">{error}{!loading && <> <button type="button" className="ghost" onClick={() => void fetchPage(asked.current)}>{t.library.retry}</button></>}</p>}
      <div ref={sentinel} className="task-list-end" aria-live="polite">{loading ? <span className="muted tiny"><InlineLoading label={t.library.loading}/></span> : files.length > 0 && next === null ? <span className="muted tiny">{t.library.noMore}</span> : null}</div>
    </div>
    <PopupPresence>{preview && <FilePreview path={preview} onClose={() => setPreview(null)} onOpenLink={onOpenLink} onOpenInBrowser={onOpenFileInBrowser}/>}</PopupPresence>
  </section>;
}
