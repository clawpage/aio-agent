/**
 * Pure derivations for the browser lifecycle status bar.
 *
 * Kept separate from the React component so the wording, the countdown and the
 * "must restore before mounting" decision can be unit-tested without a DOM, and
 * so the same rules are applied in exactly one place.
 */

import type { BrowserLifecycleStateView } from "./api";

export type StatusTone = "off" | "ok" | "busy" | "warn" | "error";

/** Visual tone for the bar; `warn` means the browser is being released soon. */
export function statusTone(status: BrowserLifecycleStateView | null): StatusTone {
  if (!status) return "off";
  if (!status.enabled) return "off";
  switch (status.state) {
    case "awake":
      return "ok";
    case "idle":
      return "warn";
    case "snapshotting":
    case "restoring":
      return "busy";
    case "asleep":
      return "warn";
    case "error":
      return "error";
    default:
      return "ok";
  }
}

/**
 * True when the panel must restore the browser before it mounts an iframe.
 *
 * A released browser (or one whose restore already failed) has no live targets to
 * point the panel at, so mounting early would only show a blank page that looks
 * like a broken browser. An unknown `browserRunning` is deliberately *not* a
 * restore trigger: the panel should try the connection and let the proxy rebuild
 * if needed, rather than block on a probe that could not attribute the process.
 */
export function needsRestore(status: BrowserLifecycleStateView | null): boolean {
  if (!status || !status.enabled) return false;
  if (status.state === "asleep" || status.state === "restoring" || status.state === "snapshotting") return true;
  if (status.state === "error" && status.restorePending) return true;
  return false;
}

/** True while an automatic restore is already running, so retry must wait. */
export function isRestoring(status: BrowserLifecycleStateView | null): boolean {
  return status?.state === "restoring";
}

/** Chinese occupancy summary; never empty, never a raw counter dump. */
export function describeOccupancy(status: BrowserLifecycleStateView | null): string {
  if (!status) return "正在读取浏览器状态…";
  if (!status.enabled) return "浏览器自动释放已关闭，将一直保持运行";
  const parts: string[] = [];
  if (status.leases.turns > 0) parts.push(`任务 ${status.leases.turns}`);
  if (status.leases.viewers > 0) parts.push(`观看 ${status.leases.viewers}`);
  if (status.leases.calls > 0) parts.push(`进行中的浏览器请求 ${status.leases.calls}`);
  const pins = status.leases.pins > 0 ? status.leases.pins : status.holds;
  if (pins > 0) parts.push(`手动保留 ${pins}`);
  if (parts.length === 0) {
    return status.restorePending ? "没有占用，但快照尚未恢复" : "当前没有占用";
  }
  return `占用原因：${parts.join("、")}`;
}

/** Short "m:ss" text for the idle countdown, or null when not counting down. */
export function idleCountdownText(status: BrowserLifecycleStateView | null): string | null {
  if (!status || !status.enabled) return null;
  const remaining = status.idleRemainingMs;
  if (remaining === null || remaining === undefined) return null;
  if (remaining <= 0) return "即将释放";
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** True when the release was refused/cancelled and the user should be told why. */
export function refusalReason(status: BrowserLifecycleStateView | null): string | null {
  if (!status || status.lastErrorCode === null) return null;
  const count = status.unrestoredTabCount ?? 0;
  switch (status.lastErrorCode) {
    case "snapshot_blocked":
    case "snapshot_incomplete":
      return count > 0
        ? `有 ${count} 个页面无法安全保存（可能未提交的输入或下载中），已保留浏览器未释放`
        : "快照不完整，已保留浏览器未释放";
    case "snapshot_failed":
      return "保存浏览器状态失败，已保留浏览器未释放";
    case "stop_failed":
      return "停止浏览器失败，浏览器仍在运行，可稍后重试";
    case "stop_unattributed":
      return "无法确认浏览器进程归属，为避免影响其它进程已放弃释放";
    case "wake_failed":
      return "浏览器恢复失败，快照已保留，可重试";
    default:
      return status.lastError;
  }
}
