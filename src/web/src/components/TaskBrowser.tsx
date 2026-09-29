import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Task, TaskTab } from "../types";
import { TaskConsole } from "./TaskConsole";

const LIVE = new Set(["running", "stopping", "queued"]);
const REFRESH_MS = 4000;

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const live = LIVE.has(task.status);
  // The feed summary changes the moment the agent asks for you or you take over.
  const signal = `${task.browser?.tabs ?? 0}:${task.browser?.request ?? ""}:${task.browser?.human ?? false}:${task.status}`;

  const load = useCallback(async () => {
    try {
      setTabs((await api.taskBrowser(task.id)).tabs);
      setShotAt(Date.now());
      setShotFailed(false);
    } catch {
      // A transient failure keeps the last known state rather than flashing it away.
    }
  }, [task.id]);

  useEffect(() => {
    void load();
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, live, signal]);

  const tab = pickTab(tabs);
  if (!task.browser?.tabs || !tab) return null;

  const control = async (action: "take" | "release") => {
    setBusy(true);
    setError(null);
    try {
      const { tab: updated } = await api.taskBrowserControl(task.id, tab.id, action);
      setTabs((old) => old.map((t) => (t.id === updated.id ? updated : t)));
      setConsoleOpen(action === "take");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const waiting = Boolean(tab.request) && tab.holder === "ai";
  const human = tab.holder === "human";
  const state = waiting ? "request" : human ? "human" : live ? "ai" : "done";
  const label = { request: "需要你操作", human: "你正在操作", ai: "AI 操作中", done: "已结束" }[state];

  return (
    <div className={`task-browser ${state}`} role="group" aria-label={`任务浏览器：${label}`}>
      <div className="task-browser-head">
        <span className={`task-browser-state ${state}`}>{label}</span>
        <span className="task-browser-site" title={tab.url}>
          {tab.title || host(tab.url)}
          <span className="muted"> · {host(tab.url)}</span>
        </span>
        {tabs.length > 1 && <span className="muted tiny">共 {tabs.length} 个标签页</span>}
      </div>
      {waiting && <p className="task-browser-reason">{tab.request!.reason}</p>}
      {human && <p className="task-browser-hint">{live ? "AI 已暂停操作这个页面。完成后点“交还给 AI”，它会从当前页面继续。" : "任务已结束，你可以查看或继续操作这个页面。"}</p>}
      {!shotFailed && (
        <button type="button" className="task-browser-shot" onClick={() => (human ? setConsoleOpen(true) : void control("take"))} disabled={busy} aria-label="操作这个页面">
          <img src={api.taskBrowserScreenshotUrl(task.id, tab.id, shotAt)} alt={`${tab.title || host(tab.url)} 的页面预览`} loading="lazy" onError={() => setShotFailed(true)} />
        </button>
      )}
      {error && <p className="error tiny">{error}</p>}
      <div className="task-actions">
        {waiting && <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("take")}>去浏览器操作</button>}
        {human && <>
          <button type="button" className="primary tiny" disabled={busy} onClick={() => void control("release")}>{live ? "完成，交还给 AI" : "结束查看"}</button>
          <button type="button" className="ghost tiny" onClick={() => setConsoleOpen(true)}>操作页面</button>
        </>}
        {state === "ai" && <button type="button" className="ghost tiny" disabled={busy} onClick={() => void control("take")}>接管</button>}
        {state === "done" && <button type="button" className="ghost tiny" disabled={busy} onClick={() => void control("take")}>在浏览器中查看</button>}
      </div>
      {human && consoleOpen && (
        <TaskConsole
          taskId={task.id}
          tab={tab}
          live={live}
          busy={busy}
          onRelease={() => void control("release")}
          onClose={() => setConsoleOpen(false)}
          onReveal={() => { setConsoleOpen(false); onReveal(); }}
        />
      )}
    </div>
  );
}
