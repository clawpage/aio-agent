import { useEffect, useState } from "react";
import { browserApi, type BrowserLifecycleStateView } from "../api";
import {
  describeOccupancy,
  idleCountdownText,
  isRestoring,
  needsRestore,
  refusalReason,
  statusTone,
} from "../browserStatusView";

interface Props {
  /** Current lifecycle status, or null before the first poll resolves. */
  status: BrowserLifecycleStateView | null;
  /** True while the panel itself holds a viewer lease. */
  watching: boolean;
  /** Wake/restore, used by the retry action; resolves when finished. */
  onWake: () => Promise<void>;
  onNotify: (message: string, level?: "info" | "error") => void;
  /** Manual keep-alive pin, so the user can leave the browser running. */
  pinned: { id: string; note: string } | null;
  onPinToggle: () => void;
}

/**
 * Browser lifecycle status bar.
 *
 * It reports only what the control plane proved: the current state, who is
 * holding the browser awake, how long until release and any honest failure. It
 * never claims a restore succeeded - `restoring` and `error` stay visible until
 * `/api/browser/status` reports a genuinely awake browser.
 */
export function BrowserStatusBar({ status, watching, onWake, onNotify, pinned, onPinToggle }: Props) {
  const [retrying, setRetrying] = useState(false);
  const tone = statusTone(status);
  const countdown = idleCountdownText(status);
  const refusal = refusalReason(status);
  const restoring = isRestoring(status) || retrying;

  // A countdown reads as broken if it only moves on click, so re-render on a
  // one-second cadence while a deadline is pending. The poll itself is read-only.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (countdown === null) return;
    const timer = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const retry = async () => {
    setRetrying(true);
    try {
      await onWake();
      onNotify("浏览器已恢复");
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`browser-status ${tone}`} role="status" aria-live="polite">
      <span className="bs-state">{status?.stateLabel ?? "浏览器状态"}</span>
      <span className="bs-occupancy">{describeOccupancy(status)}</span>
      {watching && <span className="bs-watching">本窗口观看中</span>}
      {countdown !== null && tone === "warn" && <span className="bs-countdown">剩余 {countdown}</span>}
      {status?.enabled && status.browserRunning === null && (
        <span className="bs-unknown" title="无法确认浏览器进程归属，已按保守策略处理">
          进程归属未知
        </span>
      )}
      {refusal && <span className="bs-refusal">{refusal}</span>}
      {needsRestore(status) && !restoring && (
        <button type="button" className="link" onClick={() => void retry()}>
          重试恢复
        </button>
      )}
      {restoring && <span className="bs-restoring">正在恢复…</span>}
      {/* A resident browser is never released, so there is nothing to keep. */}
      {!status?.resident && (
        <button type="button" className="link bs-pin" onClick={onPinToggle}>
          {pinned ? "取消保留" : "保留浏览器"}
        </button>
      )}
    </div>
  );
}

/** Poll cadence for the read-only status; never renews a lease. */
export const STATUS_POLL_MS = 15_000;

/** One read-only status fetch, safe to call for a panel that is not watching. */
export async function fetchBrowserStatus(): Promise<BrowserLifecycleStateView> {
  return (await browserApi.status()).status;
}
