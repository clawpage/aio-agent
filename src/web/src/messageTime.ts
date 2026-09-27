import type { Task } from "./types";

const valid = (at: number | null | undefined): at is number => at != null && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime());
const day = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const clock = (date: Date) => date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function messageTime(at: number | null | undefined, now: number): string | null {
  if (!valid(at)) return null;
  const date = new Date(at), today = new Date(now);
  const age = now - at;
  if (day(date) === day(today)) {
    if (age >= 0 && age < 60_000) return "刚刚";
    if (age >= 60_000 && age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前`;
    return `今天 ${clock(date)}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day(date) === day(yesterday)) return `昨天 ${clock(date)}`;
  return `${date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}

export function taskDuration(task: Pick<Task, "status" | "startedAt" | "completedAt">, now: number): string | null {
  if (!valid(task.startedAt) || task.status === "unknown") return null;
  if (["running", "stopping"].includes(task.status)) return `已处理 ${formatDuration(now - task.startedAt)}`;
  if (["completed", "failed", "interrupted"].includes(task.status) && valid(task.completedAt) && task.completedAt >= task.startedAt) {
    return `处理用时 ${formatDuration(task.completedAt - task.startedAt)}`;
  }
  return null;
}
