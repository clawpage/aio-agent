import { PopupPresence } from "./PopupMotion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { Task, TaskTab } from "../types";
import { TaskConsole, taskConsoleTarget } from "./TaskConsole";
import { VaultPrompt } from "./VaultPrompt";

const LIVE = new Set(["running", "stopping", "queued"]);
const REFRESH_MS = 4000;
/** The preview costs a sandbox screenshot: retake it only when the page shown changed, or this often. */
const SHOT_MS = 15_000;

/** The tab worth showing: one waiting for you, then one you hold, then the most recently used. */
function pickTab(tabs: TaskTab[]): TaskTab | undefined {
  return tabs.find((t) => t.request && t.holder === "ai") ?? tabs.find((t) => t.holder === "human") ?? [...tabs].sort((a, b) => b.lastUsed - a.lastUsed)[0];
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * A task's browser, inside its card: a live preview of the tab its agent works
 * in, who is driving it, and the hand-over. Taking over shuts the agent out of
 * the task's own tab and opens a panel operating just that tab, until you hand
 * it back; an agent that asked for you continues right where it waited.
 */
export function TaskBrowser({ task, onReveal }: { task: Task; onReveal: () => void }) {
  const [tabs, setTabs] = useState<TaskTab[]>([]);
  const [shotAt, setShotAt] = useState(() => Date.now());
  const [shotFailed, setShotFailed] = useState(false);
  const shot = useRef<{ key: string; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // Watching the agent's page in the big view, before (or without) taking it over.
  const [watching, setWatching] = useState(false);
  const consoleTarget = useMemo(() => taskConsoleTarget(task.id), [task.id]);
  const live = LIVE.has(task.status);
  // The feed summary changes the moment the agent asks for you or you take over.
  const signal = `${task.browser?.tabs ?? 0}:${task.browser?.request ?? ""}:${task.browser?.human ?? false}:${task.status}`;

  const load = useCallback(async (force = false) => {
    try {
      const next = (await api.taskBrowser(task.id)).tabs;
      setTabs(next);
      const shown = pickTab(next), key = shown ? `${shown.id}\n${shown.url}\n${shown.title}` : "", now = Date.now();
      if (force || !shot.current || shot.current.key !== key || now - shot.current.at >= SHOT_MS) {
        shot.current = { key, at: now };
        setShotAt(now);
        setShotFailed(false);
      }
    } catch {
      // A transient failure keeps the last known state rather than flashing it away.
    }
  }, [task.id]);

  useEffect(() => {
    // The feed says which tasks have tabs: the rest never ask the sandbox.
    if (!task.browser?.tabs) return;
    void load(true);
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, live, signal]);

  // The tab was closed (the sandbox clears a finished task's tabs after a while): forget it,
  // unless the person just opened the page again and the feed has not caught up yet.
  const reopenedAt = useRef(0);
  const tabCount = task.browser?.tabs ?? 0;
  useEffect(() => { if (!tabCount && Date.now() - reopenedAt.current > 15_000) setTabs([]); }, [tabCount]);

  const reopen = async () => {
    setBusy(true);
    setError(null);
    try {
      const { tab: opened } = await api.taskBrowserReopen(task.id);
      reopenedAt.current = Date.now();
      setTabs([opened]);
      shot.current = { key: `${opened.id}\n${opened.url}\n${opened.title}`, at: Date.now() };
      setShotAt(Date.now());
      setShotFailed(false);
      setConsoleOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tab = pickTab(tabs);
  const last = task.browser?.last;
  if (!tab && last) {
    const name = last.title || host(last.url);
    return (
      <div className="task-browser closed" role="group" aria-label={t.browser.task.closedGroup}>
        <div className="task-browser-head">
          <span className="task-browser-state closed">{t.browser.task.closed}</span>
          <span className="task-browser-site" title={last.url}>
            {name}
            <span className="muted"> · {host(last.url)}</span>
          </span>
        </div>
        <p className="task-browser-hint">{t.browser.task.closedHint}</p>
        {last.shot && (
          <button type="button" className="task-browser-shot" onClick={() => void reopen()} disabled={busy} aria-label={t.browser.task.reopenLabel}>
            <img src={api.taskBrowserLastShotUrl(task.id, last.at)} alt={t.browser.task.lastShotAlt(name)} loading="lazy" />
            <span className="task-browser-shot-badge">{t.browser.task.lastShot}</span>
          </button>
        )}
        {error && <p className="error tiny">{error}</p>}
        <div className="task-actions">
          <button type="button" className="primary tiny" disabled={busy} onClick={() => void reopen()}>{busy ? t.browser.task.opening : t.browser.task.reopen}</button>
        </div>
      </div>
    );
  }
  if (!tab) return null;

  const control = async (action: "take" | "release") => {
    setBusy(true);
    setError(null);
    try {
      const { tab: updated } = await api.taskBrowserControl(task.id, tab.id, action);
      setTabs((old) => old.map((t) => (t.id === updated.id ? updated : t)));
      setConsoleOpen(action === "take");
      setWatching(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const waiting = Boolean(tab.request) && tab.holder === "ai";
  const human = tab.holder === "human";
  // A sign-in the password vault can answer; everything else is for the person in the browser.
  const signIn = waiting && tab.request!.kind === "login";
  const state = waiting ? "request" : human ? "human" : live ? "ai" : "done";
  const label = signIn ? t.browser.task.signIn : t.browser.task.states[state];

  return (
    <div className={`task-browser ${state}`} role="group" aria-label={t.browser.task.group(label)}>
      <div className="task-browser-head">
        <span className={`task-browser-state ${state}`}>{label}</span>
        <span className="task-browser-site" title={tab.url}>
          {tab.title || host(tab.url)}
          <span className="muted"> · {host(tab.url)}</span>
        </span>
        {tabs.length > 1 && <span className="muted tiny">{t.browser.task.tabCount(tabs.length)}</span>}
      </div>
      {waiting && !signIn && <p className="task-browser-reason">{tab.request!.reason}</p>}
      {signIn && <VaultPrompt taskId={task.id} tab={tab} busy={busy} onDone={() => void load()} onManual={() => void control("take")} />}
      {human && <p className="task-browser-hint">{live ? t.browser.task.pausedHint : t.browser.task.endedHint}</p>}
      {!shotFailed && (
        <button type="button" className="task-browser-shot" onClick={() => (human ? setConsoleOpen(true) : setWatching(true))} disabled={busy} aria-label={human ? t.browser.task.operateLabel : t.browser.task.viewLabel}>
          <img src={api.taskBrowserScreenshotUrl(task.id, tab.id, shotAt)} alt={t.browser.task.shotAlt(tab.title || host(tab.url))} loading="lazy" onError={() => setShotFailed(true)} />
        </button>
      )}
      {error && <p className="error tiny">{error}</p>}
      <div className="task-actions">
        {waiting && !signIn && <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("take")}>{t.browser.task.takeOver}</button>}
        {human && <>
          <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("release")}>{live ? t.browser.task.handBack : t.browser.task.endViewing}</button>
          <button type="button" className="ghost tiny" onClick={() => setConsoleOpen(true)}>{t.browser.task.operate}</button>
        </>}
        {state === "ai" && <button type="button" className="ghost tiny" disabled={busy} onClick={() => void control("take")}>{t.browser.task.take}</button>}
        {state === "done" && <button type="button" className="ghost tiny" disabled={busy} onClick={() => setWatching(true)}>{t.browser.task.viewInBrowser}</button>}
      </div>
      <PopupPresence>{((human && consoleOpen) || (!human && watching)) && (
        <TaskConsole
          target={consoleTarget}
          tab={tab}
          watching={!human}
          label={human ? t.browser.task.consoleOperate : t.browser.task.consoleView}
          primary={human
            ? { label: live ? t.browser.task.handBack : t.browser.task.endViewing, busy, onClick: () => void control("release") }
            : { label: live ? t.browser.task.manualTakeover : t.browser.task.operateThis, busy, onClick: () => void control("take") }}
          onClose={() => { setConsoleOpen(false); setWatching(false); }}
          onReveal={() => { setConsoleOpen(false); setWatching(false); onReveal(); }}
        />
      )}</PopupPresence>
    </div>
  );
}
