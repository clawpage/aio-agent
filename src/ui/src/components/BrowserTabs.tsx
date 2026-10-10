import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { OverviewPage } from "../types";
import { PopupSurface } from "./PopupMotion";

/** How often the open overview refreshes its list. */
const REFRESH_MS = 4000;
/** A preview costs a sandbox screenshot: retake one only when its page changed, or this often. */
const SHOT_MS = 15_000;

const hostOf = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };

function ownerLabel(page: OverviewPage): string {
  if (page.owner === "person") return t.browser.tabs.ownerPerson;
  if (page.owner === "task") return page.holder === "human" ? t.browser.tabs.humanTask(page.task ?? t.browser.tabs.task) : t.browser.tabs.aiTask(page.task ?? t.browser.tabs.task);
  return t.browser.tabs.unowned;
}

/**
 * Every page open in the workspace browser at a glance: a preview, title and
 * site of each, and whose it is. Choosing one brings its window to the front of
 * the desktop the person is watching; nobody's control over a page changes.
 */
export function BrowserTabs({ onClose, onNotify }: { onClose: () => void; onNotify: (message: string, tone?: "error") => void }) {
  const [pages, setPages] = useState<OverviewPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  // When each page's preview was taken, and of what (its url and title).
  const [shots, setShots] = useState<Record<string, { key: string; at: number }>>({});
  const [switching, setSwitching] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { pages } = await api.browserOverview();
      setPages(pages);
      setFailed(false);
      const now = Date.now();
      setShots(old => Object.fromEntries(pages.map(p => { const key = `${p.url}\n${p.title}`, prev = old[p.target]; return [p.target, prev && prev.key === key && now - prev.at < SHOT_MS ? prev : { key, at: now }]; })));
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

  return <PopupSurface className="browser-tabs" role="dialog" aria-label={t.browser.tabs.dialog} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="browser-tabs-panel">
      <header className="browser-tabs-head">
        <strong>{t.browser.tabs.title}{pages ? ` · ${pages.length}` : ""}</strong>
        <span className="muted tiny">{t.browser.tabs.hint}</span>
        <button type="button" className="ghost" onClick={onClose} aria-label={t.browser.tabs.close}>✕</button>
      </header>
      {pages === null
        ? <p className="browser-tabs-empty muted">{failed ? t.browser.tabs.failed : t.browser.tabs.loading}</p>
        : !pages.length
          ? <p className="browser-tabs-empty muted">{t.browser.tabs.empty}</p>
          : <ul className="browser-tabs-grid">
            {pages.map(page => <li key={page.target}>
              <button type="button" className={`browser-tab-card${page.front ? " front" : ""}`} disabled={!!switching} onClick={() => void choose(page)} aria-label={t.browser.tabs.switchTo(page.title || hostOf(page.url))}>
                <span className="browser-tab-shot"><img src={api.browserOverviewShotUrl(page.target, shots[page.target]?.at ?? 0)} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = "hidden"; }} onLoad={event => { event.currentTarget.style.visibility = ""; }}/>{page.front && <span className="browser-tab-badge">{t.browser.tabs.front}</span>}{switching === page.target && <span className="browser-tab-badge">{t.browser.tabs.switching}</span>}</span>
                <span className="browser-tab-title">{page.title || hostOf(page.url) || t.browser.tabs.blank}</span>
                <span className="browser-tab-meta"><span className="browser-tab-host">{hostOf(page.url)}</span><span className={`browser-tab-owner ${page.owner ?? "none"}${page.holder === "human" ? " human" : ""}`}>{ownerLabel(page)}</span></span>
              </button>
            </li>)}
          </ul>}
    </div>
  </PopupSurface>;
}
