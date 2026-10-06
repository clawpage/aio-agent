import { createPortal } from "react-dom";
import { PopupSurface } from "./PopupMotion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { cachedImage, holdImage, retryImage } from "../imageCache";
import { isSandboxLink } from "../sandboxLink";
import { openDeviceBrowser } from "../deviceBrowser";
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
import { extractFileRefs } from "../fileRefs";

/**
 * Unified preview for a workspace file.
 *
 * Images use typed blobs; Office/PDF are rasterised; Markdown is sanitized.
 * HTML uses an authenticated endpoint with CSP sandbox plus a sandboxed iframe
 * (scripts allowed, same-origin/storage/parent access and network disallowed).
 * An HTML page too large to inline opens in full in the sandbox's real browser.
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

/** "browser": an HTML page over the inline cap, shown in the sandbox browser instead. */
type Phase = "loading" | "ready" | "error" | "unsupported" | "browser";

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
  const autoOpened = useRef<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Focus the close control so Escape/Enter work immediately after opening.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

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
          const held = holdImage(path);
          release = held.release;
          const cached = cachedImage(path);
          if (cached) { setImageUrl(cached); setPhase("ready"); return; }
          try {
            const url = await held.promise;
            if (controller.signal.aborted) return;
            setImageUrl(url);
            setPhase("ready");
          } catch (err) {
            throw new Error(err instanceof Error && err.message === "empty" ? "文件是空的（0 字节）" : "无法加载文件（可能已被移动或删除）");
          }
          return;
        }
        if (kind === "text") {
          // The signal is passed so the in-flight request is cancelled when the
          // dialog switches files or retries; the aborted check below stops a
          // late resolution from writing into the new dialog either way.
          const result = await api.documentText(path, controller.signal);
          if (controller.signal.aborted) return;
          if (html && !result.truncated) {
            const ticket = await api.ticket(api.documentHtmlUrl(path));
            if (controller.signal.aborted) return;
            setHtmlUrl(ticket.url);
          }
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
        if (html && err instanceof ApiError && err.status === 413) {
          setPhase("browser");
          return;
        }
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
    setBrowserNote("正在沙箱浏览器中打开…");
    try {
      await api.openBrowserFile(path);
      setBrowserNote("已在沙箱浏览器的新标签页中打开，可到工作区「浏览器」里查看。");
    }
    catch (err) { setBrowserNote(err instanceof Error ? err.message : String(err)); }
  };
  // A page too large to inline goes straight to the browser, once per file.
  useEffect(() => {
    if (phase !== "browser" || autoOpened.current === path) return;
    autoOpened.current = path;
    void openInBrowser();
  }, [phase, path]);

  return createPortal(
    <PopupSurface
      className="file-preview-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`file-preview ${markdown || html ? "file-preview-document" : ""}`} role="dialog" aria-modal="true" aria-label={`预览 ${name}`}>
        <header className="file-preview-head">
          {history.length > 0 && <button className="ghost" aria-label="返回上个文件" onClick={() => { setPath(history.at(-1)!); setHistory(old => old.slice(0,-1)); }}>←</button>}
          <span className="file-preview-name" title={path}>
            {name}
          </span>
          <span className="muted tiny">{html ? "HTML 页面" : markdown ? "Markdown" : kindLabel(kind)}</span>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose} ref={closeRef} aria-label="关闭预览">
            关闭
          </button>
        </header>

        {phase === "ready" && (markdown || html) && <div className="file-preview-toolbar" role="group" aria-label="文档显示方式">
          <button className="ghost" aria-pressed={!sourceView} onClick={() => { if (html && sourceView) retry(); else setSourceView(false); }}>{html ? "页面" : "阅读"}</button>
          <button className="ghost" aria-pressed={sourceView} onClick={() => setSourceView(true)}>{html ? "源码" : "原文"}</button>
        </div>}
        <div className={`file-preview-body ${html && !sourceView && !textTruncated ? "file-preview-html-body" : ""}`}>
          {phase === "loading" && (
            <p className="muted" role="status">
              {raster ? "正在沙箱中转换并生成预览…" : "正在加载…"}
            </p>
          )}

          {phase === "error" && (
            <div className="banner error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={retry}>
                重试
              </button>
            </div>
          )}

          {phase === "unsupported" && (
            <div className="file-preview-note" role="status">
              <p>该格式暂不支持在线预览。</p>
              <p className="muted tiny">你可以直接下载原文件，或在工作区「文件」页对它有转换入口时把它转换成可预览的格式。</p>
            </div>
          )}

          {phase === "browser" && (
            <div className="file-preview-note" role="status" data-testid="file-preview-browser-note">
              <p>页面较大，超过内联预览上限，改用沙箱浏览器完整打开。</p>
              {browserNote && <p className="muted tiny">{browserNote}</p>}
            </div>
          )}

          {phase === "ready" && kind === "image" && imageUrl && (
            <img src={imageUrl} alt={name} data-testid="file-preview-image" onError={() => {
              setError("图片无法解码，可能已损坏或不是真正的图片格式");
              setPhase("error");
            }} />
          )}

          {phase === "ready" && kind === "video" && (
            <video key={`${path}#${attempt}`} className="file-preview-video" data-testid="file-preview-video"
              aria-label={`播放 ${name}`} src={api.documentMediaUrl(path)} controls playsInline preload="metadata"
              onError={() => { setError("视频无法播放：文件可能已移动、损坏，或编码不受浏览器支持。可以重试或下载原文件查看。"); setPhase("error"); }} />
          )}

          {phase === "ready" && kind === "audio" && (
            <div className="file-preview-audio">
              <span className="file-preview-audio-name">{name}</span>
              <audio key={`${path}#${attempt}`} data-testid="file-preview-audio" aria-label={`播放 ${name}`} src={api.documentMediaUrl(path)} controls preload="metadata"
                onError={() => { setError("音频无法播放：文件可能已移动、损坏，或格式不受这个浏览器支持。可以重试或下载原文件。"); setPhase("error"); }} />
            </div>
          )}

          {phase === "ready" && kind === "text" && text !== null && (
            <div className={`file-preview-text ${html && !sourceView && !textTruncated ? "file-preview-html" : ""}`}>
              {textTruncated && (
                <p className="banner warn" role="status">
                  文件较大，仅显示开头部分；完整内容请下载查看。
                </p>
              )}
              {html && !sourceView && !textTruncated && htmlUrl ? <iframe title={`HTML 页面：${name}`} data-testid="file-preview-html" sandbox="allow-scripts" referrerPolicy="no-referrer" src={htmlUrl} /> : markdown && !sourceView ? <article className="document-reading" data-testid="file-preview-markdown">
                <Markdown source={text} document onOpenLink={url => void openLink(url)} onOpenFile={openFile}/>
                {refs.length > 0 && <div className="file-cards">{refs.map(ref => <FileCard key={ref.path} {...ref} onOpen={openFile}/>)}</div>}
              </article> : <pre data-testid="file-preview-text">{text}</pre>}
            </div>
          )}

          {phase === "ready" && raster && pageCount > 0 && (
            <div className="file-preview-pages">
              {pageFailed ? (
                <div className="banner error" role="alert">
                  <span>这一页无法显示（转换可能部分失败）。</span>
                  <button type="button" onClick={() => setPageFailed(false)}>
                    重试
                  </button>
                </div>
              ) : (
                <img
                  key={`${path}#${page}#${attempt}`}
                  src={api.documentPageUrl(path, page)}
                  alt={`${name} 第 ${page} 页`}
                  data-testid="file-preview-page"
                  onError={() => setPageFailed(true)}
                />
              )}
            </div>
          )}
        </div>

        <footer className="file-preview-foot">
          {raster && pageCount > 0 && (
            <div className="file-preview-pager" role="group" aria-label="翻页">
              <button type="button" className="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                上一页
              </button>
              <span className="muted tiny" data-testid="file-preview-pageno">
                {page} / {pageCount}
                {truncated ? `（共 ${totalPages} 页，仅预览前 ${pageCount} 页）` : ""}
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={page >= pageCount}
              >
                下一页
              </button>
            </div>
          )}
          {truncated && pageCount > 0 && <span className="muted tiny">预览已截断</span>}
          <span className="spacer" />
          {onConvert && (kind === "word" || kind === "excel" || kind === "ppt") && (
            <button type="button" className="ghost" onClick={() => onConvert(path, "pdf")}>
              转换为 PDF
            </button>
          )}
          {actions}
          {html && (phase === "ready" || phase === "browser") && (
            <button type="button" className="ghost" onClick={() => void openInBrowser()} data-testid="file-preview-open-browser">
              在浏览器打开
            </button>
          )}
          <a className="primary" href={api.downloadUrl(path)} download={name} data-testid="file-preview-download">
            下载
          </a>
        </footer>
      </div>
    </PopupSurface>,
    document.body,
  );
}
