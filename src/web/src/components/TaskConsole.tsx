import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { TaskTab } from "../types";
import { RemoteKeyboard } from "./RemoteKeyboard";

const REFRESH_MS = 1500;
const SCROLL_PX = 600;

/**
 * Operating a task's tab you took over, from any screen: a live picture of that
 * one tab (tap it to click there), scroll and back, and a native input bar that
 * raises the phone keyboard. Everything goes to this task's tab only, never to
 * whatever else the shared browser shows.
 */
export function TaskConsole({ taskId, tab, live, busy, onRelease, onClose, onReveal }: {
  taskId: string;
  tab: TaskTab;
  live: boolean;
  busy: boolean;
  onRelease: () => void;
  onClose: () => void;
  onReveal: () => void;
}) {
  // The picture on screen swaps only once the next one has loaded, so it never flashes.
  const [shown, setShown] = useState(() => api.taskBrowserScreenshotUrl(taskId, tab.id, Date.now()));
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
    const next = api.taskBrowserScreenshotUrl(taskId, tab.id, Date.now());
    const img = new Image();
    img.onload = () => { loading.current = false; setShown(next); setShotFailed(false); };
    img.onerror = () => { loading.current = false; setShotFailed(true); };
    img.src = next;
  }, [taskId, tab.id]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  const act = async (input: Parameters<typeof api.taskBrowserPointer>[2]) => {
    setNotice(null);
    try {
      const out = await api.taskBrowserPointer(taskId, tab.id, input);
      setPage({ title: out.title, url: out.url });
      if (input.action === "click") setFieldTapped(Boolean(out.editable));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    refresh();
  };

  return createPortal(
    <div ref={overlay} className="task-console-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="task-console" role="dialog" aria-modal="true" aria-label="操作任务页面">
        <header className="task-console-head">
          <span className="task-console-title" title={page.url}>{page.title || page.url}</span>
          <button type="button" className="primary" disabled={busy} onClick={onRelease}>{live ? "完成，交还给 AI" : "结束查看"}</button>
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭操作面板">关闭</button>
        </header>
        <div className={`task-console-screen ${zoomed ? "zoomed" : ""}`}>
          {shotFailed && <p className="muted tiny">页面画面暂时取不到，稍后会自动重试。</p>}
          <img
            src={shown}
            alt={`${page.title || page.url} 的实时画面，点按即点击网页`}
            // Tapping the picture must not blur the input bar and drop the phone keyboard.
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              void act({ action: "click", x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
            }}
          />
        </div>
        {notice && <p className="task-console-notice" role="alert">{notice}</p>}
        <div className="task-console-tools" role="group" aria-label="页面操作">
          <button type="button" className="ghost" aria-label="后退" onPointerDown={(e) => e.preventDefault()} onClick={() => void act({ action: "back" })}>←</button>
          <button type="button" className="ghost" aria-label="向上滚动" onPointerDown={(e) => e.preventDefault()} onClick={() => void act({ action: "scroll", dy: -SCROLL_PX })}>↑</button>
          <button type="button" className="ghost" aria-label="向下滚动" onPointerDown={(e) => e.preventDefault()} onClick={() => void act({ action: "scroll", dy: SCROLL_PX })}>↓</button>
          <button type="button" className="ghost" aria-label="放大画面" aria-pressed={zoomed} onPointerDown={(e) => e.preventDefault()} onClick={() => setZoomed((z) => !z)}>{zoomed ? "缩小" : "放大"}</button>
          <span className="spacer" />
          <button type="button" className="ghost tiny" onClick={onReveal}>在工作区打开</button>
        </div>
        <RemoteKeyboard
          placeholder={fieldTapped ? "在这里打字" : "先点上方输入框"}
          onSend={async (input) => { await api.taskBrowserInput(taskId, tab.id, input); refresh(); }}
        />
      </div>
    </div>,
    document.body,
  );
}
