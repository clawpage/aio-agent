import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, browserApi, type PointerInput, type PointerResult } from "../api";
import { BrowserViewerController } from "../browserViewer";
import { RemoteKeyboard } from "./RemoteKeyboard";
import { keepFocusTap } from "../keepFocusTap";

const REFRESH_MS = 1500;
const SCROLL_PX = 600;

/** Where a console's picture, taps and typing go: a task's tab, or the person's own. */
export interface ConsoleTarget {
  screenshotUrl: (tab: string, at: number) => string;
  pointer: (tab: string, input: PointerInput) => Promise<PointerResult>;
  input: (tab: string, input: { text?: string; key?: string }) => Promise<unknown>;
  /** Follow a window the page opens (only the person's own tabs are theirs to follow). */
  follow?: boolean;
}

export const taskConsoleTarget = (taskId: string): ConsoleTarget => ({
  screenshotUrl: (tab, at) => api.taskBrowserScreenshotUrl(taskId, tab, at),
  pointer: (tab, input) => api.taskBrowserPointer(taskId, tab, input),
  input: (tab, input) => api.taskBrowserInput(taskId, tab, input),
});

export const personConsoleTarget: ConsoleTarget = {
  screenshotUrl: api.personBrowserScreenshotUrl,
  pointer: api.personBrowserPointer,
  input: api.personBrowserInput,
  follow: true,
};

/**
 * Operating one browser tab from any screen: a live picture of that tab (tap it
 * to click there), scroll and back, and a native input bar that raises the phone
 * keyboard. Everything goes to this tab only, never to whatever else the shared
 * browser shows. Used for a task tab you took over and for a link you opened.
 */
export function TaskConsole({ target, tab, label, primary, closeLabel = "关闭", onClose, onReveal }: {
  target: ConsoleTarget;
  tab: { id: string; title: string; url: string };
  label: string;
  primary?: { label: string; busy: boolean; onClick: () => void };
  closeLabel?: string;
  /** Called with every tab this console showed (a followed window included). */
  onClose: (visited: string[]) => void;
  onReveal: () => void;
}) {
  const [tabId, setTabId] = useState(tab.id);
  const visited = useRef(new Set([tab.id]));
  // The picture on screen swaps only once the next one has loaded, so it never flashes.
  const [shown, setShown] = useState(() => target.screenshotUrl(tab.id, Date.now()));
  const [shotFailed, setShotFailed] = useState(false);
  const [page, setPage] = useState({ title: tab.title, url: tab.url });
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldTapped, setFieldTapped] = useState(false);
  // A desktop-width page is small on a phone: zoom in and pan to tap small fields.
  const [zoomed, setZoomed] = useState(false);
  const loading = useRef(false);
  const overlay = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    const next = target.screenshotUrl(tabId, Date.now());
    const img = new Image();
    img.onload = () => { loading.current = false; setShown(next); setShotFailed(false); };
    img.onerror = () => { loading.current = false; setShotFailed(true); };
    img.src = next;
  }, [target, tabId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Someone is looking at this browser: keep it from being released as idle while the
  // console is on screen, and bring it back if it already was.
  useEffect(() => {
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
    const join = () => void viewer.claim().then(() => browserApi.wake()).catch(() => undefined);
    const onVisibility = () => (document.visibilityState === "visible" ? join() : void viewer.release());
    join();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void viewer.release();
      viewer.dispose();
    };
  }, []);

  // A phone keyboard shrinks only the visual viewport: keep the panel (and its input bar) inside it.
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

  const close = useCallback(() => onClose([...visited.current]), [onClose]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);

  // A followed window shows at once, not on the next tick.
  const firstShot = useRef(true);
  useEffect(() => {
    if (firstShot.current) { firstShot.current = false; return; }
    refresh();
  }, [refresh]);

  const act = async (input: PointerInput) => {
    setNotice(null);
    try {
      const out = await target.pointer(tabId, input);
      setPage({ title: out.title, url: out.url });
      if (input.action === "click") setFieldTapped(Boolean(out.editable));
      if (target.follow && out.current && out.current !== tabId) {
        visited.current.add(out.current);
        setTabId(out.current);
        return;
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    refresh();
  };

  return createPortal(
    <div ref={overlay} className="task-console-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="task-console" role="dialog" aria-modal="true" aria-label={label}>
        <header className="task-console-head">
          <span className="task-console-title" title={page.url}>{page.title || page.url}</span>
          {primary && <button type="button" className="primary" disabled={primary.busy} onClick={primary.onClick}>{primary.label}</button>}
          <button type="button" className="ghost" onClick={close} aria-label="关闭操作面板">{closeLabel}</button>
        </header>
        <div className={`task-console-screen ${zoomed ? "zoomed" : ""}`}>
          {shotFailed && <p className="muted tiny">页面画面暂时取不到，稍后会自动重试。</p>}
          <img
            src={shown}
            alt={`${page.title || page.url} 的实时画面，点按即点击网页`}
            // Tapping the picture must not blur the input bar and drop the phone keyboard.
            {...keepFocusTap<HTMLImageElement>(({ clientX, clientY, target }) => {
              const box = target.getBoundingClientRect();
              void act({ action: "click", x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height });
            })}
          />
        </div>
        {notice && <p className="task-console-notice" role="alert">{notice}</p>}
        <div className="task-console-tools" role="group" aria-label="页面操作">
          <button type="button" className="ghost" aria-label="后退" {...keepFocusTap(() => void act({ action: "back" }))}>←</button>
          <button type="button" className="ghost" aria-label="向上滚动" {...keepFocusTap(() => void act({ action: "scroll", dy: -SCROLL_PX }))}>↑</button>
          <button type="button" className="ghost" aria-label="向下滚动" {...keepFocusTap(() => void act({ action: "scroll", dy: SCROLL_PX }))}>↓</button>
          <button type="button" className="ghost" aria-label="放大画面" aria-pressed={zoomed} {...keepFocusTap(() => setZoomed((z) => !z))}>{zoomed ? "缩小" : "放大"}</button>
          <span className="spacer" />
          <button type="button" className="ghost tiny" onClick={onReveal}>在工作区打开</button>
        </div>
        <RemoteKeyboard
          placeholder={fieldTapped ? "在这里打字" : "先点上方输入框"}
          onSend={async (input) => { await target.input(tabId, input); refresh(); }}
        />
      </div>
    </div>,
    document.body,
  );
}
