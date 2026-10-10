import { PopupPresence, PopupSurface } from "./PopupMotion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { CapabilitiesResponse, DocumentReadiness, FileEntry, StatusResponse } from "../types";
import { FilePreview } from "./FilePreview";
import { TerminalSessions } from "./TerminalSessions";
import { PhoneScreen } from "./PhoneScreen";
import { BrowserViewerController } from "../browserViewer";
import { BrowserStatusBar, fetchBrowserStatus, STATUS_POLL_MS } from "./BrowserStatusBar";
import { needsRestore } from "../browserStatusView";
import { DESKTOP_PATH } from "./TaskConsole";
import { DesktopFrame } from "./DesktopFrame";
import { BrowserTabs } from "./BrowserTabs";
import { AppIcon } from "./AppIcon";
import { browserApi, UI_KEEP_ALIVE_NOTE, type BrowserLifecycleStateView } from "../api";
import { baseName, kindLabel, workspaceFileKind, type WorkspaceFileKind } from "../sandboxLink";
import { locale, t } from "../i18n";
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

type TabId = "browser" | "terminal" | "files" | "editor" | "notebook" | "preview" | "phone" | "api";

const TABS: Array<{ id: TabId; label: string; path?: string; kind: "frame" | "native" }> = [
  // The browser is shown on the sandbox desktop (noVNC): its own keyboard, gestures and windows.
  { id: "browser", label: t.workspace.apps.browser, path: DESKTOP_PATH, kind: "frame" },
  { id: "terminal", label: t.workspace.apps.terminal, path: "/terminal", kind: "native" },
  { id: "files", label: t.workspace.apps.files, kind: "native" },
  { id: "editor", label: t.workspace.apps.editor, path: "/code-server/", kind: "frame" },
  { id: "notebook", label: t.workspace.apps.notebook, path: "/jupyter/lab", kind: "frame" },
  { id: "preview", label: t.workspace.apps.preview, kind: "native" },
  // The owner's own Android phone (USB on the host), shown only when the host offers it.
  { id: "phone", label: t.workspace.apps.phone, kind: "native" },
  { id: "api", label: t.workspace.apps.api, kind: "native" },
];

export function Workspace({ open, status, initialPath, onClose, onNotify, browserNonce, canConfigure = true }: Props) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  /** The owner's phone is offered by the host (the tab exists only then). */
  const [phoneAvailable, setPhoneAvailable] = useState(false);
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
  /** The app window is closed or minimized to the Dock: only the desktop shows. */
  const [minimized, setMinimized] = useState(false);
  const clock = useClock();
  const [previewPath, setPreviewPath] = useState("/");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  /** Workspace file shown in the unified preview dialog (null = closed). */
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [frameStatus, setFrameStatus] = useState<"idle" | "loading" | "loaded" | "timeout">("idle");
  const origin = status?.workspaceOrigin ?? originHint;
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
      setMinimized(false);
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
        onNotify(t.workspace.sessionFailed(err instanceof Error ? err.message : String(err)), "error");
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

  // Whether the host offers the owner's phone; asked each time the workspace opens.
  useEffect(() => {
    if (!open || !canConfigure) return;
    let cancelled = false;
    api.phone().then((res) => { if (!cancelled) setPhoneAvailable(res.available); }, () => undefined);
    return () => { cancelled = true; };
  }, [open, canConfigure]);

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
      // A lost or regained lease (a failed heartbeat, the retry that follows) shows up at once.
      onHeldChange: setWatching,
    });
  }
  const viewer = viewerRef.current;

  /** The browser/desktop panels are the only ones that need a live Chromium. */
  const holdsBrowser = open && tab === "browser" && !minimized;
  // The overview of every open page belongs to the browser window on screen.
  const [tabsOpen, setTabsOpen] = useState(false);
  useEffect(() => { if (!holdsBrowser) setTabsOpen(false); }, [holdsBrowser]);

  /**
   * The frame's ticket was spent by its first load, so a frame unmounted while
   * hidden (a backgrounded window, a released browser) must come back on a fresh
   * one, never replay the spent link into "链接已失效".
   */
  const frameShown = open && !minimized && docVisible && !(holdsBrowser && (suspended || restoringBrowser));
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
        onNotify(keepAlivePin ? t.workspace.pin.unpinned : t.workspace.pin.pinned);
      } catch (err) {
        onNotify(err instanceof Error ? err.message : String(err), "error");
      }
    })();
  }, [keepAlivePin, onNotify]);

  const currentDef = TABS.find((t) => t.id === tab);
  const apps = TABS.filter((t) => (canConfigure || t.id !== "api") && (t.id !== "phone" || (canConfigure && phoneAvailable)));
  const externalPath = tab === "terminal" ? (terminalId ? `/terminal?session_id=${encodeURIComponent(terminalId)}` : undefined) : currentDef?.path;

  return (
    <PopupPresence>{open && <PopupSurface as="section" className={`workspace desktop ${fullscreen ? "fullscreen" : ""}`}>
      <header className="ws-head menubar">
        <span className="menubar-app">{minimized ? t.workspace.menubar.desktop : currentDef?.label}</span>
        {!minimized && externalPath && (
          <button type="button" className="menubar-item" onClick={() => void openExternal(externalPath)}>
            {t.workspace.menubar.newTab}
          </button>
        )}
        {holdsBrowser && (
          <button type="button" className="menubar-item" aria-expanded={tabsOpen} onClick={() => setTabsOpen((v) => !v)}>
            {t.workspace.menubar.tabs}
          </button>
        )}
        <span className="menubar-spacer" />
        <time className="menubar-clock" dateTime={clock.iso}>{clock.label}</time>
        <button type="button" className="menubar-item" onClick={onClose} aria-label={t.workspace.menubar.close} title={t.workspace.menubar.close}>
          ✕
        </button>
      </header>

      <div className="desktop-area">
        {minimized ? (
          <div className="desktop-icons">
            {apps.map((t) => (
              <button key={t.id} type="button" className="desktop-icon" onClick={() => void navigateTo(t.id)}>
                <AppIcon app={t.id} size={52} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="window" role="tabpanel" aria-label={currentDef?.label}>
            <div className="window-titlebar">
              <div className="traffic-lights">
                <button type="button" className="light close" aria-label={t.workspace.window.close} title={t.workspace.window.close} onClick={() => { setMinimized(true); setFullscreen(false); }} />
                <button type="button" className="light minimize" aria-label={t.workspace.window.minimize} title={t.workspace.window.minimize} onClick={() => { setMinimized(true); setFullscreen(false); }} />
                <button type="button" className="light zoom" aria-label={fullscreen ? t.workspace.window.exitFullscreen : t.workspace.window.fullscreen} title={fullscreen ? t.workspace.window.exitFullscreen : t.workspace.window.fullscreen} onClick={() => setFullscreen((v) => !v)} />
              </div>
              <span className="window-title">{currentDef?.label}</span>
            </div>
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
              <PopupPresence>{holdsBrowser && tabsOpen && <BrowserTabs onClose={() => setTabsOpen(false)} onNotify={onNotify}/>}</PopupPresence>
              {tab === "files" && <FilesTab canConfigure={canConfigure} notify={onNotify} onPreview={setFilePreview} />}
              {tab === "preview" && (
                <div className="preview">
                  <div className="row">
                    <input
                      value={previewPath}
                      onChange={(e) => setPreviewPath(e.target.value)}
                      placeholder={t.workspace.preview.placeholder}
                    />
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void openPreview(previewPath)}
                    >
                      {t.workspace.preview.open}
                    </button>
                    <button type="button" className="ghost" onClick={() => void openExternal(normalizePreviewTarget(previewPath))}>
                      {t.workspace.preview.newTab}
                    </button>
                  </div>
                  <p className="muted tiny">
                    {t.workspace.preview.proxyBefore}<code>/proxy/3000/</code>{t.workspace.preview.proxyAfter}
                  </p>
                  {previewSrc ? (
                    <iframe
                      key={previewSrc}
                      src={previewSrc}
                      title={t.workspace.preview.frameTitle}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
                      onLoad={() => setSessionReady(true)}
                    />
                  ) : (
                    <p className="muted">{t.workspace.preview.empty}</p>
                  )}
                </div>
              )}
              {canConfigure && tab === "api" && <ApiTab notify={onNotify} />}
              {canConfigure && phoneAvailable && tab === "phone" && <PhoneScreen active={docVisible} onNotify={onNotify} />}
              {TABS.find((t) => t.id === tab)?.kind === "frame" && (
                <>
                  {holdsBrowser && (suspended || restoringBrowser) ? (
                    <div className="frame-hint">
                      <p>
                        {restoringBrowser ? t.workspace.released.restoring : browserStatus?.lastErrorCode === "wake_failed" ? t.workspace.released.wakeFailed : t.workspace.released.released}
                        {browserStatus?.restorePending ? t.workspace.released.restorePending : t.workspace.released.end}
                      </p>
                      <p className="muted tiny">{t.workspace.released.restoreNote}</p>
                      <button
                        type="button"
                        className="primary"
                        disabled={restoringBrowser}
                        onClick={() =>
                          void wakeBrowser().catch((err) => onNotify(err instanceof Error ? err.message : String(err), "error"))
                        }
                      >
                        {restoringBrowser ? t.workspace.released.retrying : t.workspace.released.retry}
                      </button>
                    </div>
                  ) : !docVisible ? (
                    <p className="muted">{t.workspace.window.background}</p>
                  ) : frameSrc && tab === "browser" ? (
                    <DesktopFrame
                      key={frameKey}
                      src={frameSrc}
                      title={currentDef?.label ?? t.workspace.window.fallbackTitle}
                      onLoad={() => {
                        setFrameStatus("loaded");
                        setSessionReady(true);
                      }}
                    />
                  ) : frameSrc ? (
                    <iframe
                      key={frameKey}
                      src={frameSrc}
                      title={currentDef?.label ?? t.workspace.window.fallbackTitle}
                      allow="clipboard-read; clipboard-write; fullscreen"
                      onLoad={() => {
                        setFrameStatus("loaded");
                        setSessionReady(true);
                      }}
                    />
                  ) : (
                    <p className="muted">{t.workspace.window.connecting}</p>
                  )}
                  {frameError && <div className="frame-hint error">{frameError}</div>}
                  {frameStatus === "timeout" && (
                    <div className="frame-hint">
                      {t.workspace.window.loadTimeout}
                      <button type="button" className="link" onClick={() => currentDef?.path && void openExternal(currentDef.path)}>
                        {t.workspace.window.openInNewTab}
                      </button>
                      <button type="button" className="link" onClick={() => void navigateTo(tab)}>
                        {t.workspace.window.retry}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <nav className="dock" role="tablist" aria-label={t.workspace.apps.dock}>
        {apps.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-label={t.label}
            aria-selected={tab === t.id && !minimized}
            className={`dock-item ${tab === t.id ? "running" : ""}`}
            title={t.label}
            onClick={() => void navigateTo(t.id)}
          >
            <AppIcon app={t.id} />
            <span className="dock-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <PopupPresence>{filePreview && <FilePreview path={filePreview} onClose={() => setFilePreview(null)} onOpenLink={async url => {
        try { await api.openBrowserTab(url); await navigateTo("browser"); }
        catch (err) { onNotify(err instanceof Error ? err.message : String(err), "error"); }
      }} onOpenInBrowser={async path => {
        try { await api.openBrowserFile(path); await navigateTo("browser"); }
        catch (err) { onNotify(err instanceof Error ? err.message : String(err), "error"); }
      }} />}</PopupPresence>
    </PopupSurface>}</PopupPresence>
  );
}

/** The menu bar clock (周四 01:23), refreshed on the minute. */
function useClock(): { label: string; iso: string } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const label = `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(now)} ${now.toTimeString().slice(0, 5)}`;
  return { label, iso: now.toISOString() };
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
        { value: "txt", label: t.workspace.convert.formats.txt },
        { value: "odt", label: t.workspace.convert.formats.odt },
      ];
    case "excel":
      return [
        { value: "pdf", label: "PDF" },
        { value: "xlsx", label: "Excel (.xlsx)" },
        { value: "csv", label: "CSV" },
        { value: "ods", label: t.workspace.convert.formats.ods },
      ];
    case "ppt":
      return [
        { value: "pdf", label: "PDF" },
        { value: "pptx", label: "PowerPoint (.pptx)" },
        { value: "odp", label: t.workspace.convert.formats.odp },
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
      notify(t.workspace.convert.done(result.path));
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
    { label: t.workspace.docs.rows.word, ok: readiness?.tools.soffice === true && readiness?.python.docx === true, detail: "LibreOffice + python-docx" },
    { label: t.workspace.docs.rows.excel, ok: readiness?.tools.soffice === true && readiness?.python.openpyxl === true, detail: "LibreOffice + openpyxl" },
    { label: t.workspace.docs.rows.ppt, ok: readiness?.tools.soffice === true && readiness?.python.pptx === true, detail: "LibreOffice + python-pptx" },
    { label: t.workspace.docs.rows.pdf, ok: readiness?.tools.pdftoppm === true, detail: "poppler (pdftoppm / pdfinfo)" },
    { label: t.workspace.docs.rows.cjkFont, ok: readiness?.tools.cjkFont === true, detail: "fonts-noto-cjk" },
  ];

  return (
    <div className="files">
      <div className="row">
        <button type="button" className="ghost" onClick={() => navigate(parent)} disabled={path === "/"}>
          {t.workspace.files.up}
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigate(draft)}
          aria-label={t.workspace.files.currentDir}
        />
        <button type="button" className="ghost" onClick={refresh}>
          {t.workspace.files.refresh}
        </button>
      </div>
      <div className="row">
        <input placeholder={t.workspace.files.newNamePlaceholder} value={newName} onChange={(e) => setNewName(e.target.value)} />
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
          {t.workspace.files.newFile}
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
          {t.workspace.files.newDir}
        </button>
        {/* Same robust pattern as the chat composer: a real label opens the
            native picker instead of a programmatic click on a hidden input. */}
        <label className="file-button">
          {t.workspace.files.upload}
          <input
            type="file"
            className="file-input"
            aria-label={t.workspace.files.uploadInput}
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
                  notify(t.workspace.files.uploaded(dir, uploaded.path));
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
        {loading && <li className="muted">{t.workspace.files.loading}</li>}
        {!loading && entries.length === 0 && <li className="muted">{t.workspace.files.empty}</li>}
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
                      {t.workspace.files.preview}
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
                        {t.workspace.files.edit}
                      </button>
                    )}
                    {canConvert.length > 0 && (
                      <button
                        type="button"
                        className="link"
                        aria-label={t.workspace.files.convertItem(entry.name)}
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
                        {t.workspace.files.convert}
                      </button>
                    )}
                    <a className="link" href={api.downloadUrl(entry.path)} download>
                      {t.workspace.files.download}
                    </a>
                  </>
                )}
                <button
                  type="button"
                  className="link danger-text"
                  onClick={() => {
                    const label = entry.is_directory ? t.workspace.files.deleteDir : t.workspace.files.deleteFile;
                    if (!window.confirm(t.workspace.files.confirmDelete(label, entry.path))) return;
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
                  {t.workspace.files.delete}
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
              {t.workspace.convert.title(baseName(convertPath))}
            </strong>
            <label className="field">
              <span>{t.workspace.convert.to}</span>
              <select value={format} onChange={(e) => setFormat(e.target.value)} disabled={converting}>
                {convertTargets.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="primary" onClick={() => void convert()} disabled={converting || !ready}>
              {converting ? t.workspace.convert.converting : t.workspace.convert.run}
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
              {t.workspace.convert.cancel}
            </button>
          </div>
          {convertKind && <p className="muted tiny">{t.workspace.convert.currentKind(kindLabel(convertKind))}</p>}
          {canConfigure && !ready && (
            <p className="muted tiny">
              {readiness?.enabled === false
                ? t.workspace.convert.disabled
                : authoringReady
                  ? t.workspace.convert.authoringReady
                  : t.workspace.convert.notReady}
            </p>
          )}
          {output && (
            <p className="banner" role="status">
              {t.workspace.convert.generated}<code>{output.path}</code>
              <button type="button" className="link" onClick={() => onPreview(output.path)}>
                {t.workspace.files.preview}
              </button>
              <a className="link" href={api.downloadUrl(output.path)} download>
                {t.workspace.files.download}
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
                    notify(t.workspace.files.saved);
                    setEditing(null);
                    reloadIfUnchanged(generation, dir);
                  } catch (err) {
                    notify(err instanceof Error ? err.message : String(err), "error");
                  }
                })();
              }}
            >
              {t.workspace.files.save}
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              {t.workspace.files.close}
            </button>
          </div>
          <textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} spellCheck={false} />
        </div>
      )}

      {/* Secondary by design: the file list stays the primary surface, and a
          missing toolchain only disables conversion. */}
      <details className="docs-processing" data-testid="docs-processing">
        <summary>
          {t.workspace.docs.title}{" "}
          <span className={`docs-badge ${ready ? "ok" : previewReady ? "warn" : "error"}`} data-testid="docs-readiness-badge">
            {checking ? t.workspace.docs.checking : ready ? t.workspace.docs.allReady : previewReady ? t.workspace.docs.previewOnly : t.workspace.docs.notReady}
          </span>
        </summary>
        <div className="row">
          <span className="muted tiny">{t.workspace.docs.summary}</span>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => void check(true)} disabled={checking}>
            {t.workspace.docs.recheck}
          </button>
          {canConfigure && !ready && (
            <button type="button" className="primary" onClick={() => void install()} disabled={installing || !readiness?.enabled}>
              {installing ? t.workspace.docs.installing : t.workspace.docs.install}
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
                  <summary>{t.workspace.docs.implementation}</summary>
                  <code>{row.detail}</code>
                </details>
              </li>
            ))}
          </ul>
        )}
        <p className="muted tiny">
          {t.workspace.docs.note}
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
        {capsLoading && !caps && <p className="muted">{t.workspace.api.loading}</p>}
        {caps?.inventory.groups.map((group) => (
          <details key={group.id} open={group.id === "browser"}>
            <summary>
              {group.title}
              <span className="muted">{t.workspace.api.endpointCount(group.endpoints.length)}</span>
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
        <h4>{t.workspace.api.call}</h4>
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
            {t.workspace.api.send}
          </button>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t.workspace.api.bodyPlaceholder} spellCheck={false} />
        {result !== null && <pre className="result">{result}</pre>}

        <h4>{t.workspace.api.mcpServers}</h4>
        <p className="muted">
          {capsLoading && !caps
            ? t.workspace.api.reading
            : caps?.mcpServers.length
              ? caps.mcpServers.join(t.workspace.api.listSeparator)
              : caps
                ? t.workspace.api.noMcp
                : t.workspace.api.readFailed}
        </p>
        <h4>{t.workspace.api.skills}</h4>
        <p className="muted">
          {capsLoading && !caps
            ? t.workspace.api.reading
            : caps?.skills.length
              ? caps.skills.map((s) => s.name).join(t.workspace.api.listSeparator)
              : caps
                ? t.workspace.api.noSkills
                : t.workspace.api.readFailed}
        </p>
        {caps?.inventory.sandboxVersion && <p className="muted">{t.workspace.api.sandboxVersion(caps.inventory.sandboxVersion)}</p>}
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
