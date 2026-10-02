import { useEffect, useState } from "react";
import type { Task } from "../types";
import { messageTime, taskDuration } from "../messageTime";

/** One clock per feed, shared by every message. No per-message timers. */
export function useDisplayClock(live = false) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, live ? 1000 : 30_000);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [live]);
  return now;
}

export function MessageTime({ at, now }: { at?: number | null; now: number }) {
  const label = messageTime(at, now);
  if (!label || at == null) return null;
  const date = new Date(at);
  const full = date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" });
  return <time className="message-time" dateTime={date.toISOString()} title={full} aria-label={full}>{label}</time>;
}

export function TaskDuration({ task, now }: { task: Task; now: number }) {
  const label = taskDuration(task, now);
  return label ? <span className="task-duration" title="从开始执行到结束的经过时间，不含分配、排队及执行前等待补充的时间；包含执行中等待确认的时间。">{label}</span> : null;
}
