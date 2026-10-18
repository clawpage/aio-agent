import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { MacBrowserPage } from "../types";
import { UserBrowserScreen } from "./UserBrowserScreen";

type State = "unlinked" | "offline" | "unavailable" | "ready";
/** The page list is read again this often while the app is shown. */
const POLL_MS = 4000;

/** Host and path of a page, as a tab names it when it has no title. */
function place(page: MacBrowserPage): string {
  try {
    const u = new URL(page.url);
    return u.pathname === "/" ? u.host : `${u.host}${u.pathname}`;
  } catch {
    return page.url;
  }
}

/**
 * The workspace's Mac browser: the AI's own Chrome on the account's Mac (beside
 * the sandbox browser, which is the sandbox desktop). It lists every page open
 * there and who works in each, shows the chosen one live, and opens pages of
 * the person's own, to sign in to the sites the AI will use, say. The person's
 * pages (and pages nobody claims, such as a sign-in popup) take their input at
 * once; a task's page only once they take it over, as on its card.
 */
export function MacBrowser({ active, onNotify, onLinkMac }: { active: boolean; onNotify: (message: string, level?: "info" | "error") => void; onLinkMac: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [pages, setPages] = useState<MacBrowserPage[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.macBrowserPages();
      setState(res.state);
      setPages(res.pages);
      setSelected((current) => (current !== null && res.pages.some((p) => p.id === current) ? current : res.pages[0]?.id ?? null));
    } catch {
      setState((current) => current ?? "offline");
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const open = async () => {
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    setBusy(true);
    try {
      const { page } = await api.macBrowserOpen(target);
      setUrl("");
      setSelected(page);
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : t.userBrowser.mac.failed, "error");
    } finally {
      setBusy(false);
    }
  };
  const close = async (page: MacBrowserPage) => {
    try {
      await api.macBrowserClose(page.id);
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : t.userBrowser.mac.failed, "error");
    }
  };
  const control = async (page: MacBrowserPage, action: "take" | "release") => {
    if (!page.task) return;
    setBusy(true);
    try {
      await api.taskUserBrowserControl(page.task.id, action);
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : t.userBrowser.mac.failed, "error");
    } finally {
      setBusy(false);
    }
  };

  const current = pages.find((p) => p.id === selected) ?? null;
  const tag = (page: MacBrowserPage) =>
    page.owner === "you" ? t.userBrowser.mac.yours
      : page.owner === "none" ? t.userBrowser.mac.other
        : page.holder === "human" ? t.userBrowser.mac.human
          : t.userBrowser.mac.task(page.task?.title ?? "");

  if (state !== "ready") {
    return (
      <div className="mac-browser mac-browser-empty">
        <p>{state === null ? t.userBrowser.mac.loading : t.userBrowser.mac[state]}</p>
        {state === "unlinked" && <button type="button" className="primary" onClick={onLinkMac}>{t.userBrowser.mac.linkMac}</button>}
      </div>
    );
  }
  return (
    <div className="mac-browser">
      <form className="mac-browser-bar row" onSubmit={(e) => { e.preventDefault(); void open(); }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t.userBrowser.mac.placeholder} aria-label={t.userBrowser.mac.address} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button type="submit" className="primary" disabled={busy || !url.trim()}>{busy ? t.userBrowser.mac.opening : t.userBrowser.mac.open}</button>
      </form>
      {pages.length > 0 && (
        <div className="mac-browser-tabs" role="tablist" aria-label={t.userBrowser.mac.pages}>
          {pages.map((page) => (
            <div key={page.id} className={`mac-browser-tab ${page.id === selected ? "active" : ""} ${page.owner}`}>
              <button type="button" role="tab" aria-selected={page.id === selected} title={page.url} onClick={() => setSelected(page.id)}>
                <span className={`mac-browser-tag ${page.owner === "task" && page.holder !== "human" ? "ai" : "you"}`}>{tag(page)}</span>
                <span className="mac-browser-name">{page.title || place(page)}</span>
              </button>
              {page.owner !== "task" && (
                <button type="button" className="mac-browser-close" aria-label={t.userBrowser.mac.close(page.title || place(page))} title={t.userBrowser.mac.close(page.title || place(page))} onClick={() => void close(page)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
      {current ? (
        <>
          {current.owner === "task" && (
            <div className="mac-browser-task row">
              <span className="muted tiny">{current.holder === "human" ? t.userBrowser.task.pausedHint : t.userBrowser.mac.taskWatch(current.task?.title ?? "")}</span>
              {current.task && (current.holder === "human"
                ? <button type="button" className="primary tiny" disabled={busy} onClick={() => void control(current, "release")}>{t.userBrowser.task.handBack}</button>
                : <button type="button" className="ghost tiny" disabled={busy} onClick={() => void control(current, "take")}>{t.userBrowser.task.takeOver}</button>)}
            </div>
          )}
          <div className="mac-browser-screen">
            <UserBrowserScreen
              key={current.id}
              target={{ pageId: current.id }}
              canAct={current.owner !== "task" || current.holder === "human"}
              watchHint={t.userBrowser.mac.taskWatch(current.task?.title ?? "")}
            />
          </div>
        </>
      ) : (
        <div className="mac-browser-empty">
          <p>{t.userBrowser.mac.empty}</p>
        </div>
      )}
      <p className="mac-browser-note muted tiny">{t.userBrowser.mac.note}</p>
    </div>
  );
}
