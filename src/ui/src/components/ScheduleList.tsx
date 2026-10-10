import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Schedule, ScheduleSpec } from "../types";
import { ScheduleEditor } from "./ScheduleEditor";
import { t } from "../i18n";

const FEED_KIND = t.schedules.feedKind;
const STATUS: Record<Schedule["status"], { label: string; tone: string }> = {
  active: { label: t.schedules.status.active, tone: "working" },
  paused: { label: t.schedules.status.paused, tone: "" },
  done: { label: t.schedules.status.done, tone: "done" },
};
const RUN_LABEL: Record<string, string> = t.schedules.run;

/** Scheduled and recurring tasks: what runs when, and editing, pausing, running or removing them. */
export function ScheduleList({ active, onExpired, onOpenTask }: { active: boolean; onExpired: () => void; onOpenTask: (taskId: string) => void }) {
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setItems((await api.schedules()).schedules); setError(null); }
    catch (err) { if (err instanceof ApiError && err.status === 401) onExpired(); setError(err instanceof Error ? err.message : t.schedules.list.loadFailed); }
  }, [onExpired]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const act = async (s: Schedule, action: "pause" | "resume" | "cancel" | "run") => {
    setBusy(s.id); setConfirm(null); setNotice(null); setError(null);
    try {
      const res = await api.scheduleAction(s.id, action);
      setNotice(action === "run" ? t.schedules.list.started(s.title) : res.message ?? null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired();
      setError(err instanceof Error ? err.message : t.schedules.list.actionFailed);
    } finally { setBusy(null); }
  };
  const save = async (s: Schedule, changes: { title: string; instruction: string; schedule: ScheduleSpec; needsBrowser: boolean }) => {
    setBusy(s.id); setNotice(null); setError(null);
    try {
      const res = await api.scheduleUpdate(s.id, changes);
      setNotice(res.message.split("\n\n")[0] ?? null);
      setEditing(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired();
      setError(err instanceof Error ? err.message : t.schedules.list.saveFailed);
    } finally { setBusy(null); }
  };
  const live = items?.filter((s) => s.status !== "done").length ?? 0;
  return <section className="schedule-page" aria-label={t.schedules.list.title}>
    <header className="chat-head"><div className="chat-title"><h2>{t.schedules.list.title}</h2><span className="task-list-sub muted tiny">{items ? t.schedules.list.liveCount(live) : t.schedules.list.loading}</span></div></header>
    <div className="task-list-scroll">
      <p className="schedule-hint muted tiny">{t.schedules.list.hint}</p>
      {notice && <p className="banner ok" role="status">{notice}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {items && !items.length && <div className="empty"><h3>{t.schedules.list.emptyTitle}</h3><p>{t.schedules.list.emptyBody}</p></div>}
      <ul className="task-list">{(items ?? []).map((s) => <li key={s.id} data-schedule-id={s.id}>
        <div className="task-list-item schedule-item">
          <div className="task-list-top"><strong>{s.title}{s.builtin && <span className="schedule-builtin">{t.schedules.list.builtin}</span>}</strong><span className={`task-status-badge ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span></div>
          {s.builtin === "daily_feed" && <p className="muted tiny">{t.schedules.list.dailyFeedHint}</p>}
          <p className="schedule-rule">{s.rule}{s.nextRunText && s.status === "active" ? <span className="muted">{t.schedules.list.nextRun(s.nextRunText)}</span> : null}</p>
          <p className="task-list-summary">{s.feed?.customized ? <span className="schedule-feed-label">{t.schedules.list.yourRequest}</span> : null}{s.instruction}</p>
          {s.feed && s.feed.memory.length > 0 && <ul className="schedule-feed-memory" aria-label={t.schedules.list.feedMemory}>
            {s.feed.memory.map((m) => <li key={m.id} data-kind={m.kind}><span className="schedule-feed-label">{FEED_KIND[m.kind]}</span>{m.text}{m.source === "feed" && <span className="muted">{t.schedules.list.learnedFromFeedback}</span>}</li>)}
          </ul>}
          <div className="task-list-meta">
            <span className="muted tiny">{t.schedules.list.runCount(s.runCount)}</span>
            {s.lastTask && <button className="link tiny" onClick={() => onOpenTask(s.lastTask!.id)}>{t.schedules.list.lastRun(RUN_LABEL[s.lastTask.status] ?? s.lastTask.status)}</button>}
          </div>
          {editing === s.id && <ScheduleEditor schedule={s} busy={busy === s.id} onSave={(changes) => void save(s, changes)} onCancel={() => setEditing(null)} />}
          {editing === s.id ? null : confirm === s.id
            ? <div className="schedule-actions" role="alert"><span className="tiny">{t.schedules.list.deleteWarning}</span><button className="ghost tiny" onClick={() => setConfirm(null)}>{t.schedules.list.cancel}</button><button className="danger tiny" disabled={busy === s.id} onClick={() => void act(s, "cancel")}>{t.schedules.list.confirmDelete}</button></div>
            : <div className="schedule-actions">
              {s.status === "active" && <button className="ghost tiny" disabled={busy === s.id} onClick={() => void act(s, "pause")}>{t.schedules.list.pause}</button>}
              {s.status === "paused" && <button className="ghost tiny" disabled={busy === s.id} onClick={() => void act(s, "resume")}>{t.schedules.list.resume}</button>}
              {s.status !== "done" && <button className="ghost tiny" disabled={busy === s.id} onClick={() => void act(s, "run")}>{t.schedules.list.runNow}</button>}
              {!s.builtin && s.spec && <button className="ghost tiny" disabled={busy === s.id} onClick={() => { setConfirm(null); setEditing(s.id); }}>{t.schedules.list.edit}</button>}
              {!s.builtin && <button className="ghost tiny" disabled={busy === s.id} onClick={() => setConfirm(s.id)}>{t.schedules.list.delete}</button>}
            </div>}
        </div>
      </li>)}</ul>
    </div>
  </section>;
}
