import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { OverviewPage } from "../types";
import { PopupSurface } from "./PopupMotion";

/** How often the open overview refreshes its list and previews. */
const REFRESH_MS = 4000;

const hostOf = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };

function ownerLabel(page: OverviewPage): string {
  if (page.owner === "person") return "你打开的";
  if (page.owner === "task") return page.holder === "human" ? `你在操作 · ${page.task ?? "任务"}` : `AI 在用 · ${page.task ?? "任务"}`;
  return "未归属";
}

/**
 * Every page open in the workspace browser at a glance: a preview, title and
 * site of each, and whose it is. Choosing one brings its window to the front of
 * the desktop the person is watching; nobody's control over a page changes.
 */
export function BrowserTabs({ onClose, onNotify }: { onClose: () => void; onNotify: (message: string, tone?: "error") => void }) {
  const [pages, setPages] = useState<OverviewPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(() => Date.now());
  const [switching, setSwitching] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { pages } = await api.browserOverview();
      setPages(pages);
      setFailed(false);
      setAt(Date.now());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const choose = async (page: OverviewPage) => {
    if (switching) return;
    setSwitching(page.target);
    try {
      await api.browserFront(page.target);
      onClose();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), "error");
      void load();
    } finally {
      setSwitching(null);
    }
  };

  return <PopupSurface className="browser-tabs" role="dialog" aria-label="浏览器标签页" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="browser-tabs-panel">
      <header className="browser-tabs-head">
        <strong>标签页{pages ? ` · ${pages.length}` : ""}</strong>
        <span className="muted tiny">点一个切换到它</span>
        <button type="button" className="ghost" onClick={onClose} aria-label="关闭标签页总览">✕</button>
      </header>
      {pages === null
        ? <p className="browser-tabs-empty muted">{failed ? "浏览器暂时打不开标签页列表，稍后会自动重试" : "正在读取标签页…"}</p>
        : !pages.length
          ? <p className="browser-tabs-empty muted">浏览器里还没有打开的标签页</p>
          : <ul className="browser-tabs-grid">
            {pages.map(page => <li key={page.target}>
              <button type="button" className={`browser-tab-card${page.front ? " front" : ""}`} disabled={!!switching} onClick={() => void choose(page)} aria-label={`切换到：${page.title || hostOf(page.url)}`}>
                <span className="browser-tab-shot"><img src={api.browserOverviewShotUrl(page.target, at)} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = "hidden"; }} onLoad={event => { event.currentTarget.style.visibility = ""; }}/>{page.front && <span className="browser-tab-badge">正在显示</span>}{switching === page.target && <span className="browser-tab-badge">切换中…</span>}</span>
                <span className="browser-tab-title">{page.title || hostOf(page.url) || "空白页"}</span>
                <span className="browser-tab-meta"><span className="browser-tab-host">{hostOf(page.url)}</span><span className={`browser-tab-owner ${page.owner ?? "none"}${page.holder === "human" ? " human" : ""}`}>{ownerLabel(page)}</span></span>
              </button>
            </li>)}
          </ul>}
    </div>
  </PopupSurface>;
}
