import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { CapabilitiesResponse, DocumentReadiness, FileEntry, StatusResponse } from "../types";
import { FilePreview } from "./FilePreview";
import { TerminalSessions } from "./TerminalSessions";
import { BrowserViewerController } from "../browserViewer";
import { BrowserStatusBar, fetchBrowserStatus, STATUS_POLL_MS } from "./BrowserStatusBar";
import { needsRestore } from "../browserStatusView";
import { DESKTOP_PATH } from "./TaskConsole";
import { browserApi, UI_KEEP_ALIVE_NOTE, type BrowserLifecycleStateView } from "../api";
import { baseName, isPreviewableKind, kindLabel, workspaceFileKind, type WorkspaceFileKind } from "../sandboxLink";
interface Props {
  canConfigure?: boolean;
  open: boolean;
  status: StatusResponse | null;
  initialPath?: string;
  onClose: () => void;
  onNotify: (message: string, level?: "info" | "error") => void;
  /** Bumped by the app after it creates a sandbox browser tab, to reveal it. */
  browserNonce?: number;
}

type TabId = "browser" | "terminal" | "files" | "editor" | "notebook" | "preview" | "api";

const TABS: Array<{ id: TabId; label: string; path?: string; kind: "frame" | "native" }> = [
  // The browser is shown on the sandbox desktop (noVNC): its own keyboard, gestures and windows.
  { id: "browser", label: "浏览器", path: DESKTOP_PATH, kind: "frame" },
  { id: "terminal", label: "终端", path: "/terminal", kind: "native" },
  { id: "files", label: "文件", kind: "native" },
  { id: "editor", label: "编辑器", path: "/code-server/", kind: "frame" },
  { id: "notebook", label: "笔记本", path: "/jupyter/lab", kind: "frame" },
  { id: "preview", label: "预览", kind: "native" },
  { id: "api", label: "接口与 MCP", kind: "native" },
];

export function Workspace({ open, status, initialPath, onClose, onNotify, browserNonce, canConfigure = true }: Props) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("browser");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [originHint, setOriginHint] = useState("");
  const [frameError, setFrameError] = useState<string | null>(null);
  /** Monotonic navigation id: a late async result must never override a newer choice. */
  const navGenRef = useRef(0);
  const userNavigatedRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [previewPath, setPreviewPath] = useState("/");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  /** Workspace file shown in the unified preview dialog (null = closed). */
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [frameStatus, setFrameStatus] = useState<"idle" | "loading" | "loaded" | "timeout">("idle");
  const origin = status?.workspaceOrigin ?? originHint;
  const bootstrapping = useRef(false);
  /** True while this window holds a viewer lease on the sandbox browser. */
  const [watching, setWatching] = useState(false);
  /** Read-only lifecycle status; polling it never wakes or extends the browser. */
  const [browserStatus, setBrowserStatus] = useState<BrowserLifecycleStateView | null>(null);
  /**
   * The keep-awake switch is *derived* from the server status by its fixed note,
   * never remembered only here: a reload, a second window or a re-login rebuilds
   * the exact same pin, so the toggle can always release a pin it once created.
   */
  const keepAlivePin = useMemo(
    () => browserStatus?.pins?.find((pin) => pin.note === UI_KEEP_ALIVE_NOTE) ?? null,
    [browserStatus],
  );
  /**
   * A released browser has no live page to show, so the panel suspends its frame
   * until a restore confirms an awake browser. The generation makes a slow restore
   * unable to remount a frame after the user already switched away.
   */
  const [suspended, setSuspended] = useState(false);
  const [restoringBrowser, setRestoringBrowser] = useState(false);
  const browserStatusRef = useRef<BrowserLifecycleStateView | null>(null);
  /**
   * Document visibility. A backgrounded console must not keep the browser alive
   * nor keep its iframe/WebSocket stream mounted, so both the lease and the frame
   * follow this flag.
   */
  const [docVisible, setDocVisible] = useState(() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));

  /**
   * Every frame navigation redeems its own short-lived one-time ticket. Tickets
   * are cheap and single-use, so no shared "bootstrapping" state can leave a tab
   * selected while the frame still shows the previous page, and a stale cookie
   * can never wedge the panel.
   */
  const navigateTo = useCallback(
    async (id: TabId, explicitPath?: string): Promise<void> => {
      const def = TABS.find((t) => t.id === id);
      userNavigatedRef.current = true;
      setTab(id);
      setFrameError(null);
      // Bump the generation for every navigation, including native tabs: a frame
      // result that is still in flight must not land after the user left the frame.
      const generation = ++navGenRef.current;
      if (!def || def.kind !== "frame" || (!def.path && !explicitPath)) return;
      const path = explicitPath ?? def.path!;
      setFrameStatus("loading");
      try {
        const ticket = await api.ticket(path);
        if (generation !== navGenRef.current) return; // superseded by a newer tap
        setOriginHint(ticket.origin);
        setFrameSrc(ticket.url);
        setFrameKey((k) => k + 1);
      } catch (err) {
        if (generation !== navGenRef.current) return;
        setFrameStatus("timeout");
        setFrameError(err instanceof Error ? err.message : String(err));
        onNotify(`工作区会话获取失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
    [onNotify],
  );

  /** Open a path (or a port) in the preview tab with the same generation guard. */
  const openPreview = useCallback(
    async (input: string): Promise<void> => {
      const path = normalizePreviewTarget(input);
      userNavigatedRef.current = true;
      setTab("preview");
      setFrameError(null);
      const generation = ++navGenRef.current;
      try {
        const ticket = await api.ticket(path);
        if (generation !== navGenRef.current) return;
        setOriginHint(ticket.origin);
        setPreviewSrc(ticket.url);
      } catch (err) {
        if (generation !== navGenRef.current) return;
        setFrameError(err instanceof Error ? err.message : String(err));
        onNotify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [onNotify],
  );

  /** Verify the companion cookie really works (used for the renewal timer only). */
  const verifyCompanionSession = useCallback(async (base: string): Promise<boolean> => {
    try {
      const res = await fetch(`${base}/api/workspace/session`, { credentials: "include" });
      if (!res.ok) return false;
      const body = (await res.json()) as { authenticated?: boolean };
      return body.authenticated === true;
    } catch {
      return false;
    }
  }, []);

  /** Renew the companion cookie from the control plane (dedicated CORS-enabled endpoint). */
  const renewCompanionSession = useCallback(async (base: string): Promise<void> => {
    try {
      await fetch(`${base}/api/workspace/refresh`, { method: "POST", credentials: "include" });
    } catch {
      /* a failed renew simply means the next navigation bootstraps again */
    }
  }, []);

  const openedRef = useRef(false);

  /**
   * A link the agent rendered was opened as a sandbox browser tab. If the
   * workspace is already showing, reload the browser view (a fresh one-time
   * ticket) so the newly created tab becomes visible; if it is closed, the open
   * effect below already lands on the browser tab, so this must not double-load.
   * Declared before the open effect so `openedRef` is still false on that first
   * render.
   */
  const lastBrowserNonceRef = useRef(browserNonce ?? 0);
  useEffect(() => {
    if (browserNonce === undefined || browserNonce === lastBrowserNonceRef.current) return;
    lastBrowserNonceRef.current = browserNonce;
    if (!open || !openedRef.current) return;
    void navigateTo("browser");
  }, [browserNonce, navigateTo, open]);

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      userNavigatedRef.current = false;
      navGenRef.current += 1; // invalidate anything still in flight
      setFrameSrc(null);
      setPreviewSrc(null);
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;

    // Choose the initial tab synchronously so anything the user taps next wins.
    if (initialPath && initialPath.startsWith("/")) {
      setPreviewPath(initialPath);
      void openPreview(initialPath);
    } else {
      void navigateTo("browser");
    }

    // Background session check: it may set the renewal flag but must never move tabs.
    if (origin) {
      void (async () => {
        const valid = await verifyCompanionSession(origin);
        if (!userNavigatedRef.current) setSessionReady(valid);
        else setSessionReady((prev) => prev || valid);
      })();
    }
  }, [initialPath, navigateTo, open, openPreview, origin, verifyCompanionSession]);

  // Renew the companion session periodically and when the tab comes back.
  useEffect(() => {
    if (!open || !origin || !sessionReady) return;
    const timer = window.setInterval(() => void renewCompanionSession(origin), 10 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void renewCompanionSession(origin);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, origin, renewCompanionSession, sessionReady]);

  // The load event is authoritative; the timer only covers a frame that never fires it.
  useEffect(() => {
    if (!frameSrc || !docVisible || (tab === "browser" && (suspended || restoringBrowser))) return;
    setFrameStatus("loading");
    const timer = window.setTimeout(
      () =>
        setFrameStatus((prev) => {
          if (prev !== "loading") return prev;
          // Force a fresh one-time ticket on the next attempt.
          setSessionReady(false);
          return "timeout";
        }),
      12000,
    );
    return () => window.clearTimeout(timer);
  }, [frameSrc, frameKey, tab, suspended, restoringBrowser, docVisible]);

  const openExternal = useCallback(
    async (path: string) => {
      try {
        const ticket = await api.ticket(path);
        window.open(ticket.url, "_blank", "noopener,noreferrer");
      } catch (err) {
        onNotify(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [onNotify],
  );

  /**
   * Viewer lease for the sandbox browser.
   *
   * The lease is claimed only while the browser/desktop panel is the visible tab
   * AND the document is visible, and it is released the moment the panel hides,
   * the workspace closes or the window is backgrounded - so nobody has to wait for
   * the server TTL to get their memory back. The controller is per-window, so two
   * open consoles never share an incarnation.
   */
  const viewerRef = useRef<BrowserViewerController | null>(null);
  if (viewerRef.current === null) {
    viewerRef.current = new BrowserViewerController({
      transport: {
        heartbeat: async (id, generation) => {
          try {
            const res = await browserApi.heartbeat(id, generation);
            browserStatusRef.current = res.status;
            setBrowserStatus(res.status);
            return { kind: "ok", generation: res.generation };
          } catch (err) {
            const code = err instanceof ApiError ? err.code : "";
            if (code === "stale_viewer") return { kind: "stale" };
            return { kind: "error", message: err instanceof Error ? err.message : String(err) };
          }
        },
        release: async (id, generation) => {
          try {
            await browserApi.releaseViewer(id, generation);
          } catch {
            // The server expires the lease by TTL; a failed release is not fatal.
          }
        },
      },
      onError: (message) => onNotify(message, "error"),
    });
  }
  const viewer = viewerRef.current;

  /** The browser/desktop panels are the only ones that need a live Chromium. */
  const holdsBrowser = open && tab === "browser";

  /**
   * The frame's ticket was spent by its first load, so a frame unmounted while
   * hidden (a backgrounded window, a released browser) must come back on a fresh
   * one, never replay the spent link into "链接已失效".
   */
  const frameShown = open && docVisible && !(holdsBrowser && (suspended || restoringBrowser));
  const frameShownRef = useRef(frameShown);
  useEffect(() => {
    const wasShown = frameShownRef.current;
    frameShownRef.current = frameShown;
    if (wasShown || !frameShown || !frameSrc || TABS.find((t) => t.id === tab)?.kind !== "frame") return;
    setFrameSrc(null);
    void navigateTo(tab);
  }, [frameShown, frameSrc, navigateTo, tab]);

  // Follow document visibility so a hidden console unmounts its frame and stream.
  useEffect(() => {
    const onVisibility = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Poll the read-only status while the workspace is open. This never renews the
  // lease, which is what lets the countdown actually run down in the UI.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchBrowserStatus();
        if (!cancelled) setBrowserStatus(next);
      } catch {
        /* a failed poll leaves the previous status; it must not force a wake */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  // Hold the lease exactly while a browser panel is genuinely on screen.
  useEffect(() => {
    if (!holdsBrowser || document.visibilityState !== "visible") {
      void viewer.release();
      setWatching(false);
      return;
    }
    let cancelled = false;
    const join = async () => {
      const generation = await viewer.claim();
      if (cancelled || !generation || !viewer.isCurrent(generation)) return;
      setWatching(true);
      if (!needsRestore(browserStatusRef.current)) { setSuspended(false); return; }
      setSuspended(true);
      setRestoringBrowser(true);
      try {
        const res = await browserApi.wake();
        if (cancelled || !viewer.isCurrent(generation)) return;
        browserStatusRef.current = res.status;
        setBrowserStatus(res.status);
        setSuspended(false);
      } catch (err) {
        // Read the failed transition immediately, instead of leaving the old
        // asleep message visible until the next 15-second status poll.
        try {
          const status = await fetchBrowserStatus();
          if (!cancelled && viewer.isCurrent(generation)) {
            browserStatusRef.current = status;
            setBrowserStatus(status);
          }
        } catch { /* retain the last known state if status is unavailable */ }
        if (!cancelled && viewer.isCurrent(generation))
          onNotify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        if (!cancelled && viewer.isCurrent(generation)) setRestoringBrowser(false);
      }
    };
    void join();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void join();
      else {
        void viewer.release();
        setWatching(false);
        setRestoringBrowser(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void viewer.release();
      setWatching(false);
      setRestoringBrowser(false);
    };
  }, [holdsBrowser, viewer, onNotify]);

  // Release the lease when the whole page goes away (close/navigate/logout).
  useEffect(() => {
    // Best-effort: the request may be dropped during teardown, in which case the
    // server TTL expires the lease on its own.
    const bye = () => void viewer.release();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      viewer.dispose();
    };
  }, [viewer]);

  // Suspend the frame while the browser is released, so the panel never shows a
  // dead iframe as if it worked. The proxy rebuilds the browser on the next
  // browser-bound request; this only reflects the state honestly.
  useEffect(() => {
    if (!holdsBrowser) return;
    setSuspended(needsRestore(browserStatus));
  }, [holdsBrowser, browserStatus]);

  const wakeBrowser = useCallback(async () => {
    try {
      const res = await browserApi.wake();
      setBrowserStatus(res.status);
    } catch (err) {
      try {
        setBrowserStatus(await fetchBrowserStatus());
      } catch {
        /* keep the previous status */
      }
      throw err;
    }
  }, []);

  const togglePin = useCallback(() => {
    void (async () => {
      try {
        // Idempotent on the server, and the response carries the authoritative
        // status, so a double click in two windows cannot stack two pins.
        const res = keepAlivePin ? await browserApi.unpinUi() : await browserApi.pinUi();
        setBrowserStatus(res.status);
        onNotify(keepAlivePin ? "已取消保留浏览器" : "已保留浏览器，空闲时不会自动释放");
      } catch (err) {
        onNotify(err instanceof Error ? err.message : String(err), "error");
      }
    })();
  }, [keepAlivePin, onNotify]);

  const currentDef = TABS.find((t) => t.id === tab);
  const externalPath = tab === "terminal" ? (terminalId ? `/terminal?session_id=${encodeURIComponent(terminalId)}` : undefined) : currentDef?.path;

  if (!open) return null;

  return (
    <section className={`workspace ${fullscreen ? "fullscreen" : ""}`}>
      <header className="ws-head">
        <nav className="ws-tabs" role="tablist">
          {TABS.filter(t => canConfigure || t.id !== "api").map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => void navigateTo(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ws-actions">
          {externalPath && (
            <button type="button" className="ghost" onClick={() => void openExternal(externalPath)}>
              新标签页
            </button>
          )}
          <button type="button" className="ghost" onClick={() => setFullscreen((v) => !v)}>
            {fullscreen ? "退出全屏" : "全屏"}
          </button>
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭工作区">
            关闭
          </button>
        </div>
      </header>

      <div className="ws-body">
        {tab === "terminal" && <TerminalSessions active={docVisible} selectedId={terminalId} onSelect={setTerminalId} onNotify={onNotify}/>}
        {holdsBrowser && (
          <BrowserStatusBar
            status={browserStatus}
            watching={watching}
            onWake={wakeBrowser}
            onNotify={onNotify}
            pinned={keepAlivePin}
            onPinToggle={togglePin}
          />
        )}
        {tab === "files" && <FilesTab canConfigure={canConfigure} notify={onNotify} onPreview={setFilePreview} />}
        {tab === "preview" && (
          <div className="preview">
            <div className="row">
              <input
                value={previewPath}
                onChange={(e) => setPreviewPath(e.target.value)}
                placeholder="路径（/jupyter/lab）或端口（3000）"
              />
              <button
                type="button"
                className="primary"
                onClick={() => void openPreview(previewPath)}
              >
                打开
              </button>
              <button type="button" className="ghost" onClick={() => void openExternal(normalizePreviewTarget(previewPath))}>
                新标签页
              </button>
            </div>
            <p className="muted tiny">
              端口会通过沙箱的代理入口打开（例如 3000 → <code>/proxy/3000/</code>），用于访问你在沙箱里启动的服务。
            </p>
            {previewSrc ? (
              <iframe
                key={previewSrc}
                src={previewSrc}
                title="预览"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
                onLoad={() => setSessionReady(true)}
              />
            ) : (
              <p className="muted">输入沙箱内的路径（例如 /jupyter/lab 或你自己生成的 HTML 文件）。</p>
            )}
          </div>
        )}
        {canConfigure && tab === "api" && <ApiTab notify={onNotify} />}
        {TABS.find((t) => t.id === tab)?.kind === "frame" && (
          <>
            {holdsBrowser && (suspended || restoringBrowser) ? (
              <div className="frame-hint">
                <p>
                  {restoringBrowser ? "正在按快照恢复浏览器…" : browserStatus?.lastErrorCode === "wake_failed" ? "浏览器恢复尚未完成，现有标签和快照已保留" : "浏览器已释放以节省内存"}
                  {browserStatus?.restorePending ? "，上一次快照仍在等待恢复。" : "。"}
                </p>
                <p className="muted tiny">恢复后会按保存的标签、滚动位置与站点会话重建页面；正在进行的下载和未提交的表单不会被恢复。</p>
                <button
                  type="button"
                  className="primary"
                  disabled={restoringBrowser}
                  onClick={() =>
                    void wakeBrowser().catch((err) => onNotify(err instanceof Error ? err.message : String(err), "error"))
                  }
                >
                  {restoringBrowser ? "正在恢复…" : "重试恢复浏览器"}
                </button>
              </div>
            ) : !docVisible ? (
              <p className="muted">窗口在后台，已暂停该面板并释放浏览器占用。</p>
            ) : frameSrc ? (
              <iframe
                key={frameKey}
                src={frameSrc}
                title={currentDef?.label ?? "沙箱"}
                allow="clipboard-read; clipboard-write; fullscreen"
                onLoad={() => {
                  setFrameStatus("loaded");
                  setSessionReady(true);
                }}
              />
            ) : (
              <p className="muted">正在建立工作区会话…</p>
            )}
            {frameError && <div className="frame-hint error">{frameError}</div>}
            {frameStatus === "timeout" && (
              <div className="frame-hint">
                页面加载超时。
                <button type="button" className="link" onClick={() => currentDef?.path && void openExternal(currentDef.path)}>
                  在新标签页打开
                </button>
                <button type="button" className="link" onClick={() => void navigateTo(tab)}>
                  重试
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {filePreview && <FilePreview path={filePreview} onClose={() => setFilePreview(null)} onOpenLink={async url => {
        try { await api.openBrowserTab(url); await navigateTo("browser"); }
        catch (err) { onNotify(err instanceof Error ? err.message : String(err), "error"); }
      }} />}
    </section>
  );
}

/** Fixed workspace root inside the AIO sandbox (matches the control plane). */
const WORKSPACE_HOME = "/home/gem/workspace";

/** Lowercase extension of a path ("" when it has none). */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/**
 * Conversions the sandbox toolchain can actually perform for a source file.
 *
 * Only real combinations are offered: showing "Excel" for a Word file would be a
 * promise LibreOffice cannot keep, an unsupported source simply has no
 * conversion entry at all, and a format is never offered as a target of itself
 * (the server rejects a same-format conversion).
 */
function convertTargetsFor(path: string | null): Array<{ value: string; label: string }> {
  const kind = path ? workspaceFileKind(path) : null;
  const source = path ? extensionOf(path) : "";
  const options = optionsForKind(kind);
  return options.filter((option) => option.value !== source);
}

function optionsForKind(kind: WorkspaceFileKind | null): Array<{ value: string; label: string }> {
  switch (kind) {
    case "word":
      return [
        { value: "pdf", label: "PDF" },
        { value: "docx", label: "Word (.docx)" },
        { value: "txt", label: "纯文本" },
        { value: "odt", label: "OpenDocument 文本 (.odt)" },
      ];
    case "excel":
      return [
        { value: "pdf", label: "PDF" },
        { value: "xlsx", label: "Excel (.xlsx)" },
        { value: "csv", label: "CSV" },
        { value: "ods", label: "OpenDocument 表格 (.ods)" },
      ];
    case "ppt":
      return [
        { value: "pdf", label: "PDF" },
        { value: "pptx", label: "PowerPoint (.pptx)" },
        { value: "odp", label: "OpenDocument 演示 (.odp)" },
      ];
    case "pdf":
      // No verified LibreOffice target for PDF input in this sandbox.
      return [];
    case "image":
      return [{ value: "pdf", label: "PDF" }];
    case "text":
      return [
        { value: "pdf", label: "PDF" },
        { value: "docx", label: "Word (.docx)" },
      ];
    default:
      return [];
  }
}

/**
 * 「文件」tab: one directory, one file list.
 *
 * Browse, upload, create, preview, download, delete and (for plain text) edit a
 * workspace file — plus, for the formats the sandbox can actually convert, a per
 * row conversion entry with a compact panel. Readiness of the sandbox document
 * toolchain is a secondary, collapsed detail at the bottom: a missing toolchain
 * never blocks browsing or uploading ordinary files.
 */
function FilesTab({
  canConfigure,
  notify,
  onPreview,
}: {
  canConfigure: boolean;
  notify: (message: string, level?: "info" | "error") => void;
  onPreview: (path: string) => void;
}) {
  /** The directory the list actually shows. Only a server response sets it. */
  const [path, setPath] = useState(WORKSPACE_HOME);
  /** The path input's own value, so typing never repoints the loaded directory. */
  const [draft, setDraft] = useState(WORKSPACE_HOME);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [newName, setNewName] = useState("");

  // Document tooling is optional for everything above; it only unlocks conversion.
  const [readiness, setReadiness] = useState<DocumentReadiness | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [convertPath, setConvertPath] = useState<string | null>(null);
  const [format, setFormat] = useState("pdf");
  const [converting, setConverting] = useState(false);
  const [output, setOutput] = useState<{ path: string; bytes: number } | null>(null);

  /** Monotonic navigation id: a late listing must never override a newer choice. */
  const navGenRef = useRef(0);
  const convertPanelRef = useRef<HTMLElement | null>(null);

  const load = useCallback(
    async (target: string) => {
      const generation = ++navGenRef.current;
      setLoading(true);
      try {
        const data = await api.listFiles(target);
        if (generation !== navGenRef.current) return; // superseded by a newer navigation
        const shown = data.path ?? target;
        setEntries(data.files ?? []);
        setPath(shown);
        setDraft(shown);
      } catch (err) {
        if (generation !== navGenRef.current) return;
        notify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        if (generation === navGenRef.current) setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void load(WORKSPACE_HOME);
  }, [load]);

  /** Move to another directory: anything selected for the previous one is stale. */
  const navigate = useCallback(
    (dir: string) => {
      setConvertPath(null);
      setOutput(null);
      setEditing(null);
      void load(dir);
    },
    [load],
  );

  /** Stay where the user is and re-read the directory that is actually shown. */
  const refresh = useCallback(() => void load(path), [load, path]);

  /**
   * Re-list the directory an operation ran in, but only if the user has not
   * navigated elsewhere meanwhile: an unconditional reload would bump the
   * navigation id and cancel the listing already on its way to the directory
   * they chose.
   */
  const reloadIfUnchanged = useCallback(
    (generation: number, dir: string) => {
      if (navGenRef.current === generation) void load(dir);
    },
    [load],
  );

  const check = useCallback(
    async (refreshReadiness = false) => {
      setChecking(true);
      try {
        setReadiness(await api.documentReadiness(refreshReadiness));
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        setChecking(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void check();
  }, [check]);

  const install = useCallback(async () => {
    setInstalling(true);
    try {
      const result = await api.provisionDocuments();
      setReadiness(result.readiness);
      notify(result.message, result.ok ? "info" : "error");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setInstalling(false);
    }
  }, [notify]);

  const parent = useMemo(() => path.replace(/\/[^/]+\/?$/, "") || "/", [path]);
  const ready = readiness?.ready === true;
  const previewReady = readiness?.previewReady === true;
  const authoringReady = readiness?.authoringReady === true;
  const convertTargets = useMemo(() => convertTargetsFor(convertPath), [convertPath]);
  const convertKind = convertPath ? workspaceFileKind(convertPath) : null;

  // Keep the chosen format valid for the file currently in the panel.
  useEffect(() => {
    if (convertTargets.length === 0) return;
    if (!convertTargets.some((option) => option.value === format)) setFormat(convertTargets[0].value);
  }, [convertTargets, format]);

  // The panel sits below the list, so picking 转换 from a row far down must bring
  // it into view instead of leaving the feedback off-screen.
  useEffect(() => {
    if (!convertPath) return;
    convertPanelRef.current?.scrollIntoView({ block: "nearest" });
  }, [convertPath]);

  const convert = useCallback(async () => {
    const source = convertPath;
    if (!source || converting) return; // one conversion at a time
    // Remember the navigation this conversion belongs to: if the user moves to
    // another directory while it runs, the finished result must not load the
    // old one back (that would also supersede the newer, still-pending listing).
    const generation = navGenRef.current;
    setConverting(true);
    setOutput(null);
    try {
      // The server validates the path and format and runs the fixed container
      // command; the console never builds a shell string.
      const result = await api.convertDocument(source, format);
      setOutput(result);
      notify(`已生成 ${result.path}（原文件未被修改）`);
      if (navGenRef.current === generation) void load(path);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setConverting(false);
    }
  }, [convertPath, converting, format, load, notify, path]);

  // One line per user-facing capability, with the underlying library/command in
  // a collapsed detail: the operator sees readiness, not an implementation list.
  const capabilityRows = [
    { label: "Word（.doc/.docx）", ok: readiness?.tools.soffice === true && readiness?.python.docx === true, detail: "LibreOffice + python-docx" },
    { label: "Excel（.xls/.xlsx）", ok: readiness?.tools.soffice === true && readiness?.python.openpyxl === true, detail: "LibreOffice + openpyxl" },
    { label: "PowerPoint（.ppt/.pptx）", ok: readiness?.tools.soffice === true && readiness?.python.pptx === true, detail: "LibreOffice + python-pptx" },
    { label: "PDF 预览", ok: readiness?.tools.pdftoppm === true, detail: "poppler（pdftoppm / pdfinfo）" },
    { label: "中文字体", ok: readiness?.tools.cjkFont === true, detail: "fonts-noto-cjk" },
  ];

  return (
    <div className="files">
      <div className="row">
        <button type="button" className="ghost" onClick={() => navigate(parent)} disabled={path === "/"}>
          上一级
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigate(draft)}
          aria-label="当前目录"
        />
        <button type="button" className="ghost" onClick={refresh}>
          刷新
        </button>
      </div>
      <div className="row">
        <input placeholder="新建文件/目录名" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const name = newName.trim();
            if (!name) return;
            // The loaded directory, captured now: a later draft edit or a
            // navigation must not retarget this write.
            const dir = path;
            const generation = navGenRef.current;
            void (async () => {
              try {
                await api.writeFile(`${dir}/${name}`, "");
                setNewName("");
                reloadIfUnchanged(generation, dir);
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err), "error");
              }
            })();
          }}
        >
          新建文件
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const name = newName.trim();
            if (!name) return;
            const dir = path;
            const generation = navGenRef.current;
            void (async () => {
              try {
                await api.mkdir(`${dir}/${name}`);
                setNewName("");
                reloadIfUnchanged(generation, dir);
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err), "error");
              }
            })();
          }}
        >
          新建目录
        </button>
        {/* Same robust pattern as the chat composer: a real label opens the
            native picker instead of a programmatic click on a hidden input. */}
        <label className="file-button">
          上传
          <input
            type="file"
            className="file-input"
            aria-label="上传文件"
            data-testid="workspace-upload-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const dir = path;
              const generation = navGenRef.current;
              void (async () => {
                try {
                  const uploaded = await api.upload(file, dir);
                  notify(`已上传到 ${dir} → ${uploaded.path}`);
                  reloadIfUnchanged(generation, dir);
                } catch (err) {
                  notify(err instanceof Error ? err.message : String(err), "error");
                }
              })();
            }}
          />
        </label>
      </div>

      <ul className="file-list">
        {loading && <li className="muted">加载中…</li>}
        {!loading && entries.length === 0 && <li className="muted">空目录</li>}
        {entries.map((entry) => {
          const kind = entry.is_directory ? null : workspaceFileKind(entry.path);
          const canConvert = entry.is_directory ? [] : convertTargetsFor(entry.path);
          return (
            <li
              key={entry.path}
              className={[entry.is_directory ? "is-directory" : "", convertPath === entry.path ? "selected" : ""]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="file-main">
                <button
                  type="button"
                  className="file-name"
                  title={entry.name}
                  onClick={() => {
                    if (entry.is_directory) {
                      navigate(entry.path);
                      return;
                    }
                    // Previewable documents and images open the unified preview;
                    // plain text does too (shown as escaped text). Editing is a
                    // separate, explicit control, so nothing binary ever reaches
                    // the textarea.
                    onPreview(entry.path);
                  }}
                >
                  {entry.is_directory ? "📁" : "📄"} {entry.name}
                </button>
                <span className="file-size">{entry.is_directory ? "" : formatSize(entry.size)}</span>
              </div>
              <div className="file-actions">
                {!entry.is_directory && (
                  <>
                    <button type="button" className="link" onClick={() => onPreview(entry.path)}>
                      预览
                    </button>
                    {kind === "text" && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          // Remember the directory this edit belongs to: a slow
                          // read must not open the old file in a new directory.
                          const generation = navGenRef.current;
                          void (async () => {
                            try {
                              const data = await api.readFile(entry.path);
                              if (navGenRef.current !== generation) return;
                              setEditing({ path: data.path, content: data.content });
                            } catch (err) {
                              notify(err instanceof Error ? err.message : String(err), "error");
                            }
                          })();
                        }}
                      >
                        编辑
                      </button>
                    )}
                    {canConvert.length > 0 && (
                      <button
                        type="button"
                        className="link"
                        aria-label={`转换 ${entry.name}`}
                        disabled={converting}
                        onClick={() => {
                          setOutput(null);
                          if (convertPath === entry.path) {
                            setConvertPath(null);
                            return;
                          }
                          setFormat(canConvert[0].value);
                          setConvertPath(entry.path);
                        }}
                      >
                        转换
                      </button>
                    )}
                    <a className="link" href={api.downloadUrl(entry.path)} download>
                      下载
                    </a>
                  </>
                )}
                <button
                  type="button"
                  className="link danger-text"
                  onClick={() => {
                    const label = entry.is_directory ? "目录及其全部内容" : "文件";
                    if (!window.confirm(`确定删除${label}？\n${entry.path}`)) return;
                    const dir = path;
                    const generation = navGenRef.current;
                    void (async () => {
                      try {
                        await api.deleteFile(entry.path);
                        if (convertPath === entry.path) {
                          setConvertPath(null);
                          setOutput(null);
                        }
                        reloadIfUnchanged(generation, dir);
                      } catch (err) {
                        notify(err instanceof Error ? err.message : String(err), "error");
                      }
                    })();
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {convertPath && (
        <section
          className="docs-convert"
          data-testid="file-convert-panel"
          aria-live="polite"
          ref={convertPanelRef}
        >
          <div className="row">
            <strong className="docs-convert-name" title={convertPath}>
              转换 {baseName(convertPath)}
            </strong>
            <label className="field">
              <span>转换为</span>
              <select value={format} onChange={(e) => setFormat(e.target.value)} disabled={converting}>
                {convertTargets.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="primary" onClick={() => void convert()} disabled={converting || !ready}>
              {converting ? "转换中…" : "执行转换"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setConvertPath(null);
                setOutput(null);
              }}
              disabled={converting}
            >
              取消
            </button>
          </div>
          {convertKind && <p className="muted tiny">当前文件类型：{kindLabel(convertKind)}</p>}
          {canConfigure && !ready && (
            <p className="muted tiny">
              {readiness?.enabled === false
                ? "文档处理已被配置关闭；文件浏览、上传与下载不受影响。"
                : authoringReady
                  ? "创建/修改已就绪；预览 PDF/图片仍可用。"
                  : "转换需要文档处理就绪；预览 PDF/图片仍可用。"}
            </p>
          )}
          {output && (
            <p className="banner" role="status">
              已生成 <code>{output.path}</code>
              <button type="button" className="link" onClick={() => onPreview(output.path)}>
                预览
              </button>
              <a className="link" href={api.downloadUrl(output.path)} download>
                下载
              </a>
            </p>
          )}
        </section>
      )}

      {editing && (
        <div className="editor">
          <div className="row">
            <strong>{editing.path}</strong>
            <span className="spacer" />
            <button
              type="button"
              className="primary"
              onClick={() => {
                const dir = path;
                const generation = navGenRef.current;
                void (async () => {
                  try {
                    await api.writeFile(editing.path, editing.content);
                    notify("已保存");
                    setEditing(null);
                    reloadIfUnchanged(generation, dir);
                  } catch (err) {
                    notify(err instanceof Error ? err.message : String(err), "error");
                  }
                })();
              }}
            >
              保存
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              关闭
            </button>
          </div>
          <textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} spellCheck={false} />
        </div>
      )}

      {/* Secondary by design: the file list stays the primary surface, and a
          missing toolchain only disables conversion. */}
      <details className="docs-processing" data-testid="docs-processing">
        <summary>
          文档处理 ·{" "}
          <span className={`docs-badge ${ready ? "ok" : previewReady ? "warn" : "error"}`} data-testid="docs-readiness-badge">
            {checking ? "检查中…" : ready ? "全部就绪" : previewReady ? "仅预览可用" : "尚未就绪"}
          </span>
        </summary>
        <div className="row">
          <span className="muted tiny">沙箱内创建 / 修改 / 转换 Word、Excel、PPT 与 PDF。</span>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => void check(true)} disabled={checking}>
            重新检查
          </button>
          {canConfigure && !ready && (
            <button type="button" className="primary" onClick={() => void install()} disabled={installing || !readiness?.enabled}>
              {installing ? "安装中…" : "安装/修复"}
            </button>
          )}
        </div>
        {readiness?.error && (
          <p className="banner warn" role="status">
            {readiness.error}
          </p>
        )}
        {readiness && readiness.enabled && (
          <ul className="docs-checks">
            {capabilityRows.map((row) => (
              <li key={row.label}>
                <span aria-hidden="true">{row.ok ? "✅" : "⬜"}</span> {row.label}
                <details className="docs-detail">
                  <summary>实现</summary>
                  <code>{row.detail}</code>
                </details>
              </li>
            ))}
          </ul>
        )}
        <p className="muted tiny">
          转换在沙箱中进行，不依赖宿主机 Office，也不覆盖原文件。字体与复杂排版可能与本机 Office 存在差异，
          不承诺 100% 保真。也可以直接在对话里让智能体做（例如「把这个 Word 转成 PDF」）。
        </p>
      </details>
    </div>
  );
}

function ApiTab({ notify }: { notify: (message: string, level?: "info" | "error") => void }) {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [capsLoading, setCapsLoading] = useState(true);
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/v1/sandbox");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.capabilities();
        if (!cancelled) setCaps(data);
      } catch (err) {
        if (!cancelled) notify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        if (!cancelled) setCapsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  return (
    <div className="caps">
      <div className="cap-groups">
        {capsLoading && !caps && <p className="muted">正在读取沙箱能力清单…</p>}
        {caps?.inventory.groups.map((group) => (
          <details key={group.id} open={group.id === "browser"}>
            <summary>
              {group.title}
              <span className="muted"> · {group.endpoints.length} 个接口</span>
            </summary>
            <p className="muted">{group.description}</p>
            {group.surfaces.length > 0 && (
              <div className="chips">
                {group.surfaces.map((s) => (
                  <button
                    key={s.path}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setMethod("GET");
                      setPath(s.path);
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <ul className="endpoints">
              {group.endpoints.map((e) => (
                <li key={`${e.method}${e.path}`}>
                  <button
                    type="button"
                    className="endpoint"
                    onClick={() => {
                      setMethod(e.method);
                      setPath(e.path);
                    }}
                  >
                    <span className={`method ${e.method}`}>{e.method}</span>
                    <code>{e.path}</code>
                    <span className="muted">{e.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>

      <div className="explorer">
        <h4>接口调用</h4>
        <div className="row">
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/v1/..." />
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  let parsed: unknown;
                  if (body.trim()) parsed = JSON.parse(body);
                  const res = await api.sandboxRequest(method, path, parsed);
                  setResult(`HTTP ${res.status}\n${res.body}`);
                } catch (err) {
                  setResult(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            发送
          </button>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder='请求体（JSON，可留空）：{"url":"https://example.com"}' spellCheck={false} />
        {result !== null && <pre className="result">{result}</pre>}

        <h4>MCP 服务器</h4>
        <p className="muted">
          {capsLoading && !caps
            ? "正在读取…"
            : caps?.mcpServers.length
              ? caps.mcpServers.join("、")
              : caps
                ? "沙箱未报告 MCP 服务器"
                : "读取失败"}
        </p>
        <h4>技能</h4>
        <p className="muted">
          {capsLoading && !caps
            ? "正在读取…"
            : caps?.skills.length
              ? caps.skills.map((s) => s.name).join("、")
              : caps
                ? "沙箱未注册额外技能"
                : "读取失败"}
        </p>
        {caps?.inventory.sandboxVersion && <p className="muted">沙箱版本：{caps.inventory.sandboxVersion}</p>}
      </div>
    </div>
  );
}

/** Accept a path, a bare port, or `port/path`; ports go through the sandbox proxy entry. */
export function normalizePreviewTarget(input: string): string {
  const value = input.trim();
  if (!value) return "/";
  const bare = value.replace(/^https?:\/\//, "");
  const portMatch = /^(\d{2,5})(\/.*)?$/.exec(bare.startsWith("/") ? "" : bare);
  if (portMatch) return `/proxy/${portMatch[1]}${portMatch[2] ?? "/"}`;
  return value.startsWith("/") ? value : `/${value}`;
}

function formatSize(size: number | null): string {
  if (size === null || size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
