/**
 * Pure derivations for the browser lifecycle status bar.
 *
 * Kept separate from the React component so the wording, the countdown and the
 * "must restore before mounting" decision can be unit-tested without a DOM, and
 * so the same rules are applied in exactly one place.
 */

import type { BrowserLifecycleStateView } from "./api";
import { t } from "./i18n";

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
  if (status.restorePending || status.browserRunning === false) return true;
  return false;
}

/** True while an automatic restore is already running, so retry must wait. */
export function isRestoring(status: BrowserLifecycleStateView | null): boolean {
  return status?.state === "restoring";
}

/** Chinese occupancy summary; never empty, never a raw counter dump. */
export function describeOccupancy(status: BrowserLifecycleStateView | null): string {
  if (!status) return t.browser.occupancy.loading;
  if (!status.enabled) return t.browser.occupancy.disabled;
  const parts: string[] = [];
  if (status.leases.turns > 0) parts.push(t.browser.occupancy.turns(status.leases.turns));
  if (status.leases.viewers > 0) parts.push(t.browser.occupancy.viewers(status.leases.viewers));
  if (status.leases.calls > 0) parts.push(t.browser.occupancy.calls(status.leases.calls));
  const pins = status.leases.pins > 0 ? status.leases.pins : status.holds;
  if (pins > 0) parts.push(t.browser.occupancy.pins(pins));
  if (parts.length === 0) {
    if (status.restorePending) return t.browser.occupancy.restorePending;
    return status.resident ? t.browser.occupancy.resident : t.browser.occupancy.idle;
  }
  return t.browser.occupancy.reasons(parts);
}

/** Short "m:ss" text for the idle countdown, or null when not counting down. */
export function idleCountdownText(status: BrowserLifecycleStateView | null): string | null {
  if (!status || !status.enabled) return null;
  const remaining = status.idleRemainingMs;
  if (remaining === null || remaining === undefined) return null;
  if (remaining <= 0) return t.browser.occupancy.releasing;
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
      if (status.lastError) return status.lastError;
      return count > 0
        ? t.browser.refusal.blockedPages(count)
        : t.browser.refusal.incomplete;
    case "snapshot_failed":
      return t.browser.refusal.snapshotFailed;
    case "stop_failed":
      return t.browser.refusal.stopFailed;
    case "stop_unattributed":
      return t.browser.refusal.unattributed;
    case "wake_failed":
      return t.browser.refusal.wakeFailed;
    default:
      return status.lastError;
  }
}
