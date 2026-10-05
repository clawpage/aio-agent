import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Schedule, ScheduleSpec } from "../types";
import { ScheduleEditor } from "./ScheduleEditor";

const FEED_KIND = { care: "关心", avoid: "不再推", note: "记住" } as const;
const STATUS: Record<Schedule["status"], { label: string; tone: string }> = {
  active: { label: "进行中", tone: "working" },
  paused: { label: "已暂停", tone: "" },
  done: { label: "已结束", tone: "done" },
};
const RUN_LABEL: Record<string, string> = { completed: "完成", failed: "失败", interrupted: "已停止", unknown: "结果待核对", running: "进行中", queued: "排队中", waiting: "等待中" };

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
    catch (err) { if (err instanceof ApiError && err.status === 401) onExpired(); setError(err instanceof Error ? err.message : "读取失败"); }
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
      setNotice(action === "run" ? `「${s.title}」已开始运行，结果会出现在主会话。` : res.message ?? null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired();
      setError(err instanceof Error ? err.message : "操作失败");
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
      setError(err instanceof Error ? err.message : "保存失败");
    } finally { setBusy(null); }
  };
  const live = items?.filter((s) => s.status !== "done").length ?? 0;
  return <section className="schedule-page" aria-label="定时任务">
    <header className="chat-head"><div className="chat-title"><h2>定时任务</h2><span className="task-list-sub muted tiny">{items ? `${live} 个进行中或已暂停` : "正在读取…"}</span></div></header>
    <div className="task-list-scroll">
      <p className="schedule-hint muted tiny">在主会话里直接说就能创建，例如「每天早上 8 点查天气提醒我带伞」「每 2 小时看一下这个商品降价没」「10 月 8 日上午 9 点和 15 日下午两点半提醒我交材料」。可以在这里修改，也可以直接告诉我要改什么。每次运行的结果会出现在主会话。</p>
      {notice && <p className="banner ok" role="status">{notice}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {items && !items.length && <div className="empty"><h3>还没有定时任务</h3><p>在主会话里说出时间和要做的事，就会出现在这里。</p></div>}
      <ul className="task-list">{(items ?? []).map((s) => <li key={s.id} data-schedule-id={s.id}>
        <div className="task-list-item schedule-item">
          <div className="task-list-top"><strong>{s.title}{s.builtin && <span className="schedule-builtin">内置</span>}</strong><span className={`task-status-badge ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span></div>
          {s.builtin === "daily_feed" && <p className="muted tiny">前一天发过消息才会推送：根据你过往的任务整理今天值得留意的内容，只读看看你已登录的邮箱和关注的动态；记住你的反馈，不再关注的话题会自动少推。想改要求、时间或关心的内容，在主会话里直接说。</p>}
          <p className="schedule-rule">{s.rule}{s.nextRunText && s.status === "active" ? <span className="muted"> · 下次 {s.nextRunText}</span> : null}</p>
          <p className="task-list-summary">{s.feed?.customized ? <span className="schedule-feed-label">你的要求</span> : null}{s.instruction}</p>
          {s.feed && s.feed.memory.length > 0 && <ul className="schedule-feed-memory" aria-label="推送记住的内容">
            {s.feed.memory.map((m) => <li key={m.id} data-kind={m.kind}><span className="schedule-feed-label">{FEED_KIND[m.kind]}</span>{m.text}{m.source === "feed" && <span className="muted"> · 从你的反馈学到</span>}</li>)}
          </ul>}
          <div className="task-list-meta">
            <span className="muted tiny">已运行 {s.runCount} 次</span>
            {s.lastTask && <button className="link tiny" onClick={() => onOpenTask(s.lastTask!.id)}>上次：{RUN_LABEL[s.lastTask.status] ?? s.lastTask.status}</button>}
          </div>
          {editing === s.id && <ScheduleEditor schedule={s} busy={busy === s.id} onSave={(changes) => void save(s, changes)} onCancel={() => setEditing(null)} />}
          {editing === s.id ? null : confirm === s.id
            ? <div className="schedule-actions" role="alert"><span className="tiny">删除后不会再运行，已有的运行结果保留。</span><button className="ghost tiny" onClick={() => setConfirm(null)}>取消</button><button className="danger tiny" disabled={busy === s.id} onClick={() => void act(s, "cancel")}>确认删除</button></div>
            : <div className="schedule-actions">
              {s.status === "active" && <button className="ghost tiny" disabled={busy === s.id} onClick={() => void act(s, "pause")}>暂停</button>}
              {s.status === "paused" && <button className="ghost tiny" disabled={busy === s.id} onClick={() => void act(s, "resume")}>恢复</button>}
              {s.status !== "done" && <button className="ghost tiny" disabled={busy === s.id} onClick={() => void act(s, "run")}>立即运行一次</button>}
              {!s.builtin && s.spec && <button className="ghost tiny" disabled={busy === s.id} onClick={() => { setConfirm(null); setEditing(s.id); }}>修改</button>}
              {!s.builtin && <button className="ghost tiny" disabled={busy === s.id} onClick={() => setConfirm(s.id)}>删除</button>}
            </div>}
        </div>
      </li>)}</ul>
    </div>
  </section>;
}
