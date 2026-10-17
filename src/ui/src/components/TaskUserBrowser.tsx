import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PopupPresence, PopupSurface } from "./PopupMotion";
import { api } from "../api";
import { t } from "../i18n";
import type { Task, UserBrowserState } from "../types";
import { UserBrowserScreen } from "./UserBrowserScreen";

const LIVE = new Set(["running", "stopping", "queued", "needs_input"]);
const SHOT_MS = 10_000;

/** Host and path of a page, as the card names it. */
function place(url: string, title: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.host : `${u.host}${u.pathname}`;
  } catch {
    return title || url;
  }
}

/**
 * The page a task's agent works in on the account's own Chrome, inside its card,
 * like the task browser: a one-line strip of who drives it, a recent picture on
 * a tap, and the live page to watch. Taking over shuts the agent out of the page
 * until it is handed back; an agent that asked for the person (request_human)
 * continues when they do.
 */
export function TaskUserBrowser({ task }: { task: Task }) {
  const [view, setView] = useState<UserBrowserState>(task.userBrowser!);
  const [shotAt, setShotAt] = useState(() => Date.now());
  const [shotFailed, setShotFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = LIVE.has(task.status);
  useEffect(() => { setView(task.userBrowser!); }, [task.userBrowser?.holder, task.userBrowser?.request, task.userBrowser?.url, task.userBrowser?.page]);

  // A fresh picture every few seconds while the preview is open on a visible page and the live view is closed.
  useEffect(() => {
    if (open || !expanded || !live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setShotAt(Date.now());
    }, SHOT_MS);
    return () => window.clearInterval(timer);
  }, [open, expanded, live]);

  const close = useCallback(() => { setOpen(false); setShotAt(Date.now()); }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, close]);

  const control = async (action: "take" | "release") => {
    setBusy(true);
    setError(null);
    try {
      setView((await api.taskUserBrowserControl(task.id, action)).userBrowser);
      if (action === "take") setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.userBrowser.task.failed);
    } finally {
      setBusy(false);
      setShotAt(Date.now());
    }
  };

  const toggle = () => {
    if (!expanded) { setShotAt(Date.now()); setShotFailed(false); }
    setExpanded((v) => !v);
  };

  const waiting = Boolean(view.request) && view.holder === "ai";
  const human = view.holder === "human";
  const state = waiting ? "request" : human ? "human" : live ? "ai" : "done";
  const label = t.userBrowser.task.states[state];
  const where = place(view.url, view.title);

  return (
    <div className={`task-browser task-user-browser ${state}`} role="group" aria-label={t.userBrowser.task.group(label)}>
      <div className="task-browser-head">
        <button type="button" className="task-browser-toggle" aria-expanded={expanded} aria-label={expanded ? t.userBrowser.task.hidePreview(where) : t.userBrowser.task.showPreview(where)} onClick={toggle} disabled={!view.page}>
          <span className={`task-browser-state ${state}`}>{label}</span>
          <span className="task-browser-site" title={view.url}>{where}</span>
          <span className="task-browser-chevron" aria-hidden="true">›</span>
        </button>
        <div className="task-actions">
          {waiting && <>
            <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("take")}>{t.userBrowser.task.takeOver}</button>
            <button type="button" className="ghost tiny" disabled={busy} onClick={() => void control("release")}>{t.userBrowser.task.done}</button>
          </>}
          {human && <>
            <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("release")}>{t.userBrowser.task.handBack}</button>
            {view.page && <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>{t.userBrowser.task.operate}</button>}
          </>}
          {state === "ai" && <button type="button" className="ghost tiny" disabled={busy} onClick={() => void control("take")}>{t.userBrowser.task.takeOver}</button>}
          {state === "done" && view.page && <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>{t.userBrowser.task.view}</button>}
        </div>
      </div>
      {waiting && <p className="task-browser-reason">{view.request}</p>}
      {expanded && view.page && <>
        {waiting && <p className="task-browser-hint">{t.userBrowser.task.requestHint}</p>}
        {human && <p className="task-browser-hint">{t.userBrowser.task.pausedHint}</p>}
        {shotFailed
          ? <p className="task-browser-hint">{t.userBrowser.task.unavailable}</p>
          : (
            <button type="button" className="task-browser-shot" onClick={() => setOpen(true)} aria-label={t.userBrowser.task.openLabel}>
              <img src={api.taskUserBrowserScreenshotUrl(task.id, shotAt)} alt={t.userBrowser.task.shotAlt(where)} onLoad={() => setShotFailed(false)} onError={() => setShotFailed(true)} />
            </button>
          )}
      </>}
      {error && <p className="error tiny">{error}</p>}
      {/* On the body: a card inside the feed sits under transformed ancestors, which would trap a fixed overlay. */}
      <PopupPresence>{open && createPortal(
        <PopupSurface className="task-console-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="task-console task-user-browser-console" role="dialog" aria-modal="true" aria-label={t.userBrowser.task.dialog}>
            <header className="task-console-head">
              <span className="task-console-title">{where}</span>
              {human
                ? <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("release")}>{waiting || view.request ? t.userBrowser.task.done : t.userBrowser.task.handBack}</button>
                : <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("take")}>{t.userBrowser.task.takeOver}</button>}
              <button type="button" className="ghost tiny" onClick={close}>{t.userBrowser.task.close}</button>
            </header>
            <UserBrowserScreen taskKey={task.conversationId} canAct={human} />
          </div>
        </PopupSurface>,
        document.body,
      )}</PopupPresence>
    </div>
  );
}
