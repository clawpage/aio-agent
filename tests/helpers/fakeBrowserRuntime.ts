import type {
  BrowserRuntimeLike,
  RuntimeStatus,
  SnapshotOutcome,
  StopOutcome,
  WakeOutcome,
} from "../../src/server/browser/lifecycle.js";

/**
 * Scripted container-side browser runtime for tests.
 *
 * Every call is counted so a test can prove behaviour the UI depends on - most
 * importantly that a read-only `status` poll never wakes the browser and never
 * renews a lease. `wakeGate` lets a test hold a wake open, which is how the
 * browser-panel restore is exercised without a real container.
 */
export class FakeBrowserRuntime implements BrowserRuntimeLike {
  calls = { status: 0, snapshot: 0, stop: 0, wake: 0 };
  /** Status the container reports; mutate between calls to script a transition. */
  statusValue: RuntimeStatus = {
    ok: true,
    browserRunning: true,
    browserAttribution: "owned",
    supervisorRunning: true,
    pid: 4242,
    starttime: 1000,
    version: "Chrome/146.0.7680.31",
  };
  snapshotValue: SnapshotOutcome = { ok: true, savedAt: 111, tabs: 1, skipped: 0, warnings: [], orderVerified: true };
  stopValue: StopOutcome = { ok: true };
  wakeValue: WakeOutcome = { ok: true, restoredTabs: 1 };
  /** When set, `stop` rejects with this message (a runtime failure). */
  stopError: string | null = null;
  /** When set, `wake` rejects with this message (may contain a secret for redaction tests). */
  wakeError: string | null = null;
  /** When set, `wake` waits for it, so a test can observe the in-flight state. */
  wakeGate: Promise<void> | null = null;
  /** When set, `status` waits for it, so a test can race a poll against a transition. */
  statusGate: Promise<void> | null = null;
  /** Last stop identity the control plane handed over. */
  lastStopSource: { pid: number | null; starttime: number | null } | null = null;

  async status(): Promise<RuntimeStatus> {
    this.calls.status += 1;
    if (this.statusGate) await this.statusGate;
    return this.statusValue;
  }

  async snapshot(): Promise<SnapshotOutcome> {
    this.calls.snapshot += 1;
    return this.snapshotValue;
  }

  async stop(opts: { sourcePid?: number | null; sourceStarttime?: number | null } = {}): Promise<StopOutcome> {
    this.calls.stop += 1;
    this.lastStopSource = { pid: opts.sourcePid ?? null, starttime: opts.sourceStarttime ?? null };
    if (this.stopError) throw new Error(this.stopError);
    return this.stopValue;
  }

  async wake(): Promise<WakeOutcome> {
    this.calls.wake += 1;
    if (this.wakeGate) await this.wakeGate;
    if (this.wakeError) throw new Error(this.wakeError);
    return this.wakeValue;
  }
}
