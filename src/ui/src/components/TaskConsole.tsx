import { PopupSurface } from "./PopupMotion";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, browserApi } from "../api";
import { t } from "../i18n";
import { BrowserViewerController } from "../browserViewer";
import { DesktopFrame, usePhoneDesktop } from "./DesktopFrame";

/** The sandbox desktop in noVNC: scaled to fit, reconnecting on its own. */
// `aio=<NOVNC_ASSET_VERSION>`: a new URL, so phones load the patched noVNC instead of a cached copy (see novncPatch).
export const DESKTOP_PATH = "/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=ws&aio=5";

/** How often an open console tells the sandbox its tab is still the one on screen (the sandbox forgets after 45 s). */
const CONSOLE_PIN_RENEW_MS = 15_000;

/** How a console puts its tab's window on top of the desktop: a task's tab, or the person's own. */
export interface ConsoleTarget {
  focus: (tab: string) => Promise<unknown>;
}

export const taskConsoleTarget = (taskId: string): ConsoleTarget => ({
  focus: (tab) => api.taskBrowserPointer(taskId, tab, { action: "focus" }),
});

export const personConsoleTarget: ConsoleTarget = {
  focus: (tab) => api.personBrowserPointer(tab, { action: "focus" }),
};

/**
 * Operating one browser tab from any screen, in the sandbox desktop (noVNC): the
 * tab's own window is brought to the top, so what the person sees, taps and
 * types into (noVNC's keyboard button raises the phone keyboard) is that page.
 * Used for a task tab you took over and for a link you opened. `watching` shows
 * the same desktop view-only while the agent keeps working: nothing a tap does
 * reaches the page until the person takes over (the primary action).
 */
export function TaskConsole({ target, tab, label, primary, watching = false, closeLabel = t.browser.console.close, onClose, onReveal }: {
  target: ConsoleTarget;
  watching?: boolean;
  tab: { id: string; title: string; url: string };
  label: string;
  primary?: { label: string; busy: boolean; onClick: () => void };
  closeLabel?: string;
  /** Called with the tabs this console showed. */
  onClose: (visited: string[]) => void;
  onReveal: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const phone = usePhoneDesktop();

  const focus = useCallback(async () => {
    try {
      await target.focus(tab.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [target, tab.id]);

  // While the console is on screen its tab stays on top of the desktop: the sandbox keeps the
  // tab it was last told about above other tasks' new windows for a short while, so renew it.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void target.focus(tab.id).catch(() => undefined);
    }, CONSOLE_PIN_RENEW_MS);
    return () => window.clearInterval(timer);
  }, [target, tab.id]);

  // Someone is looking at this browser: keep it from being released as idle while the
  // console is on screen, bring it back if it already was, then put the tab on top.
  useEffect(() => {
    let cancelled = false;
    const viewer = new BrowserViewerController({
      transport: {
        heartbeat: async (id, generation) => {
          try {
            return { kind: "ok", generation: (await browserApi.heartbeat(id, generation)).generation };
          } catch (err) {
            return err instanceof ApiError && err.code === "stale_viewer" ? { kind: "stale" } : { kind: "error", message: err instanceof Error ? err.message : String(err) };
          }
        },
        release: async (id, generation) => { await browserApi.releaseViewer(id, generation).catch(() => undefined); },
      },
    });
    const join = async () => {
      await viewer.claim().then(() => browserApi.wake()).catch(() => undefined);
      if (!cancelled) await focus();
    };
    const onVisibility = () => (document.visibilityState === "visible" ? void join() : void viewer.release());
    void join();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void viewer.release();
      viewer.dispose();
    };
  }, [focus]);

  // The desktop on a fresh one-time ticket: view-only while watching, interactive once taken over.
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    api.ticket(watching ? `${DESKTOP_PATH}&view_only=1` : DESKTOP_PATH).then(
      (ticket) => { if (!cancelled) setSrc(ticket.url); },
      (err) => { if (!cancelled) setNotice(err instanceof Error ? err.message : String(err)); },
    );
    return () => { cancelled = true; };
  }, [watching]);

  // A phone keyboard shrinks only the visual viewport: keep the panel inside it.
  useEffect(() => {
    const vv = window.visualViewport;
    const el = overlay.current;
    if (!vv || !el) return;
    const fit = () => { el.style.top = `${vv.offsetTop}px`; el.style.height = `${vv.height}px`; };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); };
  }, []);

  const close = useCallback(() => onClose([tab.id]), [onClose, tab.id]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);

  return createPortal(
    <PopupSurface ref={overlay} className="task-console-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`task-console ${watching ? "watching" : ""}`} role="dialog" aria-modal="true" aria-label={label}>
        <header className="task-console-head">
          <span className="task-console-title" title={tab.url}>{tab.title || tab.url}</span>
          {primary && <button type="button" className="primary" disabled={primary.busy} onClick={primary.onClick}>{primary.label}</button>}
          <button type="button" className="ghost" onClick={close} aria-label={t.browser.console.closePanel}>{closeLabel}</button>
        </header>
        <div className="task-console-screen">
          {src ? <DesktopFrame src={src} title={t.browser.console.desktopTitle} interactive={!watching} /> : <p className="muted tiny">{t.browser.console.opening}</p>}
        </div>
        {notice && <p className="task-console-notice" role="alert">{notice}</p>}
        <div className="task-console-tools" role="group" aria-label={t.browser.console.tools}>
          <span className="muted tiny task-console-hint">{watching ? t.browser.console.watchingHint : phone ? t.browser.console.phoneHint : t.browser.console.hint}</span>
          <span className="spacer" />
          <button type="button" className="ghost tiny" onClick={() => void focus()}>{t.browser.console.focus}</button>
          <button type="button" className="ghost tiny" onClick={onReveal}>{t.browser.console.reveal}</button>
        </div>
      </div>
    </PopupSurface>,
    document.body,
  );
}
