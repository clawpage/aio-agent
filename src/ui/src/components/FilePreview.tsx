import { InlineLoading } from "./Brand";
import { createPortal } from "react-dom";
import { PopupSurface } from "./PopupMotion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { onDownloadClick } from "../saveFile";
import { ZoomableImage } from "./ZoomableImage";
import { cachedImage, holdImage, retryImage } from "../imageCache";
import { isSandboxLink } from "../sandboxLink";
import { openDeviceBrowser } from "../deviceBrowser";
import { t } from "../i18n";
import {
  baseName,
  isMarkdownPath,
  isHtmlPath,
  isPreviewableKind,
  kindLabel,
  workspaceFileKind,
  type WorkspaceFileKind,
} from "../sandboxLink";
import { Markdown } from "./Markdown";
import { FileCard } from "./FileCard";
import { NavIcon } from "./NavIcon";
import { extractFileRefs } from "../fileRefs";

/**
 * Unified preview for a workspace file.
 *
 * Images use typed blobs; Office/PDF are rasterised; Markdown is sanitized.
 * HTML uses an authenticated endpoint with CSP sandbox plus a sandboxed iframe
 * (scripts allowed, same-origin/storage/parent access and network disallowed).
 * An HTML page, however large, is streamed whole into that frame in the person's own browser; its
 * source text is fetched only when they ask for it.
 * Plain text is escaped and all text previews are capped. Downloads remain
 * attachment-only and preserve the original bytes.
 */

interface Props {
  path: string;
  onClose: () => void;
  onOpenLink?: (url: string) => void;
  /** Open an HTML page in full in the sandbox's real browser (scripts and network work there). */
  onOpenInBrowser?: (path: string) => void;
  /** Offered for kinds the sandbox tools can convert (e.g. Word → PDF). */
  onConvert?: (path: string, target: string) => void;
  /** Extra actions rendered in the footer (workspace integration). */
  actions?: React.ReactNode;
}

type Phase = "loading" | "ready" | "error" | "unsupported";

export function FilePreview({ path: initialPath, onClose, onOpenLink, onOpenInBrowser, onConvert, actions }: Props) {
  const [path, setPath] = useState(initialPath);
  const [history, setHistory] = useState<string[]>([]);
  const [sourceView, setSourceView] = useState(false);
  useEffect(() => { setPath(initialPath); setHistory([]); }, [initialPath]);
  const openFile = (next: string) => { setHistory(old => [...old, path]); setPath(next); };
  const markdown = isMarkdownPath(path);
  const html = isHtmlPath(path);
  const kind = useMemo<WorkspaceFileKind>(() => workspaceFileKind(path), [path]);
  const name = baseName(path);
  /** A picture opens like a photo: on black, the bars quiet over it, a tap hides them, pulling it down closes it. */
  const photo = kind === "image";
  const [bars, setBars] = useState(true);
  /** How far the picture is pulled down (0–1): the backdrop fades by as much. */
  const [pull, setPull] = useState(0);
  const pointer = useRef("mouse");
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [htmlUrl, setHtmlUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [browserNote, setBrowserNote] = useState<string | null>(null);
  /** Why an HTML page's source cannot be shown (too large to show as text), once asked for. */
  const [sourceError, setSourceError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeLatest = useRef(onClose);
  closeLatest.current = onClose;
  /** On a phone the preview is a page with its own history entry, so the back gesture closes it. */
  const entry = useRef<string | null>(null);
  const close = useCallback(() => {
    if (entry.current && (window.history.state as { preview?: string } | null)?.preview === entry.current) window.history.back();
    else onClose();
  }, [onClose]);

  // Focus the close control so Escape/Enter work immediately after opening; a
  // photo focuses itself instead, so no focus ring sits over the picture.
  useEffect(() => {
    (photo ? dialogRef.current : closeRef.current)?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [close]);

  // Same address, one more entry (the state the page had is kept); leaving it any way closes the preview.
  useEffect(() => {
    if (!matchMedia("(max-width: 900px)").matches) return;
    entry.current ??= Math.random().toString(36).slice(2);
    const id = entry.current;
    window.history.pushState({ ...(window.history.state as object | null), preview: id }, "");
    const back = () => { if ((window.history.state as { preview?: string } | null)?.preview !== id) closeLatest.current(); };
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("popstate", back);
      if ((window.history.state as { preview?: string } | null)?.preview === id) window.history.back();
    };
  }, []);

  // One loader per path (and per explicit retry), so a late result from a
  // previous file can never overwrite the dialog that replaced it.
  useEffect(() => {
    const controller = new AbortController();
    let release: (() => void) | null = null;
    setPhase("loading");
    setSourceView(false);
    setError(null);
    setImageUrl(null);
    setText(null);
    setHtmlUrl(null);
    setTextTruncated(false);
    setSourceError(null);
    setPage(1);
    setPageCount(0);
    setTotalPages(0);
    setTruncated(false);
    setPageFailed(false);
    setBrowserNote(null);

    void (async () => {
      try {
        if (kind === "unsupported") {
          setPhase("unsupported");
          return;
        }
        if (kind === "video" || kind === "audio") {
          // Native media requests carry the session cookie and use byte ranges;
          // never download a whole video into an object URL first.
          setPhase("ready");
          return;
        }
        if (kind === "image") {
          // Shared through the image cache: a picture already shown in a message
          // opens at once instead of being fetched again. Only an image response
          // (the server sniffs the bytes) is ever used.
          if (attempt > 0) retryImage(path);
          const held = holdImage(path, (url) => { if (!controller.signal.aborted) setImageUrl(url); });
          release = held.release;
          const cached = cachedImage(path);
          if (cached) { setImageUrl(cached); setPhase("ready"); return; }
          try {
            const url = await held.promise;
            if (controller.signal.aborted) return;
            setImageUrl(url);
            setPhase("ready");
          } catch (err) {
            throw new Error(err instanceof Error && err.message === "empty" ? t.files.preview.emptyFile : t.files.preview.loadFailed);
          }
          return;
        }
        if (html) {
          // The page itself, straight from the workspace origin: no text round trip first.
          const ticket = await api.ticket(api.documentHtmlUrl(path));
          if (controller.signal.aborted) return;
          setHtmlUrl(ticket.url);
          setPhase("ready");
          return;
        }
        if (kind === "text") {
          // The signal is passed so the in-flight request is cancelled when the
          // dialog switches files or retries; the aborted check below stops a
          // late resolution from writing into the new dialog either way.
          const result = await api.documentText(path, controller.signal);
          if (controller.signal.aborted) return;
          setText(result.text);
          setTextTruncated(result.truncated);
          setPhase("ready");
          return;
        }
        // pdf / word / excel / ppt: rasterised inside the sandbox.
        const rendered = await api.documentRender(path, controller.signal);
        if (controller.signal.aborted) return;
        setPageCount(rendered.pageCount);
        setTotalPages(rendered.totalPages);
        setTruncated(rendered.truncated);
        setPhase("ready");
      } catch (err) {
        // An aborted request rejects with an AbortError; that is the expected
        // result of switching files, not a failure to show the user.
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();

    return () => {
      controller.abort();
      release?.();
    };
  }, [kind, path, html, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const raster = isPreviewableKind(kind) && kind !== "image" && kind !== "video" && kind !== "audio";
  const refs = useMemo(() => markdown && text ? extractFileRefs(text) : [], [markdown, text]);
  const openLink = async (url: string) => {
    if (!isSandboxLink(url)) { openDeviceBrowser(url); return; }
    if (onOpenLink) { onOpenLink(url); onClose(); return; }
    try { await api.openBrowserTab(url); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const openInBrowser = async () => {
    if (onOpenInBrowser) { onOpenInBrowser(path); onClose(); return; }
    setBrowserNote(t.files.preview.openingInBrowser);
    try {
      await api.openBrowserFile(path);
      setBrowserNote(t.files.preview.openedInBrowser);
    }
    catch (err) { setBrowserNote(err instanceof Error ? err.message : String(err)); }
  };
  // An HTML page's source, only when asked for.
  useEffect(() => {
    if (!html || !sourceView || phase !== "ready" || text !== null || sourceError) return;
    const controller = new AbortController();
    api.documentText(path, controller.signal).then((result) => {
      setText(result.text);
      setTextTruncated(result.truncated);
    }, (err) => {
      if (!controller.signal.aborted) setSourceError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, [html, sourceView, phase, text, sourceError, path]);

  return createPortal(
    <PopupSurface
      className={`file-preview-overlay file-preview-page${photo ? " file-preview-photo-overlay" : ""}`}
      style={photo ? { "--pull": pull } as React.CSSProperties : undefined}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className={`file-preview ${markdown || html ? "file-preview-document" : ""}${photo ? " file-preview-photo" : ""}`} role="dialog" aria-modal="true" aria-label={t.files.preview.dialog(name)}
        ref={dialogRef} tabIndex={photo ? -1 : undefined}
        data-bars={photo && (!bars || pull > 0) ? "hidden" : undefined}>
        <header className="file-preview-head">
          {history.length > 0 && <button className="ghost" aria-label={t.files.preview.back} onClick={() => { setPath(history.at(-1)!); setHistory(old => old.slice(0,-1)); }}>←</button>}
          <span className="file-preview-name" title={path}>
            {name}
          </span>
          <span className="muted tiny">{html ? t.files.preview.htmlPage : markdown ? t.files.preview.markdown : kindLabel(kind)}</span>
          <span className="spacer" />
          <button type="button" className="ghost file-preview-close" onClick={close} ref={closeRef} aria-label={t.files.preview.closeLabel}>
            <NavIcon name="back" />
            <span>{t.files.preview.close}</span>
          </button>
        </header>

        {phase === "ready" && (markdown || html) && <div className="file-preview-toolbar" role="group" aria-label={t.files.preview.viewMode}>
          <button className="ghost" aria-pressed={!sourceView} onClick={() => { if (html && sourceView) retry(); else setSourceView(false); }}>{html ? t.files.preview.page : t.files.preview.read}</button>
          <button className="ghost" aria-pressed={sourceView} onClick={() => setSourceView(true)}>{html ? t.files.preview.source : t.files.preview.raw}</button>
        </div>}
        <div className={`file-preview-body ${html && !sourceView ? "file-preview-html-body" : ""}`}
          onPointerDown={(event) => { pointer.current = event.pointerType; }}
          onClick={photo ? (event) => {
            // Around the photo: a mouse click closes it, a tap shows or hides the bars.
            if (event.target !== event.currentTarget) return;
            if (pointer.current === "mouse") close(); else setBars((shown) => !shown);
          } : undefined}>
          {phase === "loading" && (
            <p>
              <InlineLoading label={raster ? t.files.preview.converting : t.files.preview.loading} />
            </p>
          )}

          {phase === "error" && (
            <div className="banner error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={retry}>
                {t.files.preview.retry}
              </button>
            </div>
          )}

          {phase === "unsupported" && (
            <div className="file-preview-note" role="status">
              <p>{t.files.preview.unsupported}</p>
              <p className="muted tiny">{t.files.preview.unsupportedHint}</p>
            </div>
          )}

          {phase === "ready" && html && !sourceView && htmlUrl && (
            <div className="file-preview-text file-preview-html">
              <iframe title={t.files.preview.htmlFrame(name)} data-testid="file-preview-html" sandbox="allow-scripts" referrerPolicy="no-referrer" src={htmlUrl} />
            </div>
          )}

          {phase === "ready" && html && sourceView && text === null && (
            sourceError
              ? <div className="banner error" role="alert"><span>{sourceError}</span></div>
              : <p><InlineLoading label={t.files.preview.loading} /></p>
          )}

          {phase === "ready" && kind === "image" && imageUrl && (
            <ZoomableImage src={imageUrl} alt={name} testId="file-preview-image"
              onTap={() => setBars((shown) => !shown)} onPull={setPull} onDismiss={close} onError={() => {
              setError(t.files.preview.imageDecodeFailed);
              setPhase("error");
            }} />
          )}

          {phase === "ready" && kind === "video" && (
            <video key={`${path}#${attempt}`} className="file-preview-video" data-testid="file-preview-video"
              aria-label={t.files.preview.play(name)} src={api.documentMediaUrl(path)} controls playsInline preload="metadata"
              onError={() => { setError(t.files.preview.videoFailed); setPhase("error"); }} />
          )}

          {phase === "ready" && kind === "audio" && (
            <div className="file-preview-audio">
              <span className="file-preview-audio-name">{name}</span>
              <audio key={`${path}#${attempt}`} data-testid="file-preview-audio" aria-label={t.files.preview.play(name)} src={api.documentMediaUrl(path)} controls preload="metadata"
                onError={() => { setError(t.files.preview.audioFailed); setPhase("error"); }} />
            </div>
          )}

          {phase === "ready" && kind === "text" && text !== null && (!html || sourceView) && (
            <div className="file-preview-text">
              {textTruncated && (
                <p className="banner warn" role="status">
                  {t.files.preview.textTruncated}
                </p>
              )}
              {markdown && !sourceView ? <article className="document-reading" data-testid="file-preview-markdown">
                <Markdown source={text} document onOpenLink={url => void openLink(url)} onOpenFile={openFile}/>
                {refs.length > 0 && <div className="file-cards">{refs.map(ref => <FileCard key={ref.path} {...ref} onOpen={openFile}/>)}</div>}
              </article> : <pre data-testid="file-preview-text">{text}</pre>}
            </div>
          )}

          {phase === "ready" && raster && pageCount > 0 && (
            <div className="file-preview-pages">
              {pageFailed ? (
                <div className="banner error" role="alert">
                  <span>{t.files.preview.pageFailed}</span>
                  <button type="button" onClick={() => setPageFailed(false)}>
                    {t.files.preview.retry}
                  </button>
                </div>
              ) : (
                <img
                  key={`${path}#${page}#${attempt}`}
                  src={api.documentPageUrl(path, page)}
                  alt={t.files.preview.pageAlt(name, page)}
                  data-testid="file-preview-page"
                  onError={() => setPageFailed(true)}
                />
              )}
            </div>
          )}
        </div>

        <footer className="file-preview-foot">
          {raster && pageCount > 0 && (
            <div className="file-preview-pager" role="group" aria-label={t.files.preview.pager}>
              <button type="button" className="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                {t.files.preview.prevPage}
              </button>
              <span className="muted tiny" data-testid="file-preview-pageno">
                {page} / {pageCount}
                {truncated ? t.files.preview.pagesTruncated(totalPages, pageCount) : ""}
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={page >= pageCount}
              >
                {t.files.preview.nextPage}
              </button>
            </div>
          )}
          {truncated && pageCount > 0 && <span className="muted tiny">{t.files.preview.truncated}</span>}
          {browserNote && <span className="muted tiny" role="status">{browserNote}</span>}
          <span className="spacer" />
          {onConvert && (kind === "word" || kind === "excel" || kind === "ppt") && (
            <button type="button" className="ghost" onClick={() => onConvert(path, "pdf")}>
              {t.files.preview.toPdf}
            </button>
          )}
          {actions}
          {html && phase === "ready" && (
            <button type="button" className="ghost" onClick={() => void openInBrowser()} data-testid="file-preview-open-browser">
              {t.files.preview.openInBrowser}
            </button>
          )}
          <a className="primary" href={api.downloadUrl(path)} download={name} onClick={onDownloadClick} data-testid="file-preview-download">
            {t.files.preview.download}
          </a>
        </footer>
      </div>
    </PopupSurface>,
    document.body,
  );
}
