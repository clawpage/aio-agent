import type { Task } from "./types";
import { locale, t } from "./i18n";

const valid = (at: number | null | undefined): at is number => at != null && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime());
const day = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const clock = (date: Date) => date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

export function messageTime(at: number | null | undefined, now: number): string | null {
  if (!valid(at)) return null;
  const date = new Date(at), today = new Date(now);
  const age = now - at;
  if (day(date) === day(today)) {
    if (age >= 0 && age < 60_000) return t.time.justNow;
    if (age >= 60_000 && age < 3_600_000) return t.time.minutesAgo(Math.floor(age / 60_000));
    return t.time.today(clock(date));
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day(date) === day(yesterday)) return t.time.yesterday(clock(date));
  return t.time.date(date.getFullYear() === today.getFullYear() ? null : date.getFullYear(), date.getMonth() + 1, date.getDate(), clock(date));
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t.time.seconds(seconds);
  if (seconds < 3600) return t.time.minutesSeconds(Math.floor(seconds / 60), seconds % 60);
  return t.time.hoursMinutes(Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60));
}

export function taskDuration(task: Pick<Task, "status" | "startedAt" | "completedAt">, now: number): string | null {
  if (!valid(task.startedAt) || task.status === "unknown") return null;
  if (["running", "stopping"].includes(task.status)) return t.time.running(formatDuration(now - task.startedAt));
  if (["completed", "failed", "interrupted"].includes(task.status) && valid(task.completedAt) && task.completedAt >= task.startedAt) {
    return t.time.took(formatDuration(task.completedAt - task.startedAt));
  }
  return null;
}
