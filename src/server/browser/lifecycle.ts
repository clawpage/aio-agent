/**
 * Sandbox browser lifecycle: one state machine that decides when the sandbox's
 * Chromium must stay awake and when its memory may be released.
 *
 * Scope is deliberately narrow. Only Chromium is released: the container, Codex,
 * the terminal, code-server and Jupyter are never stopped here, and this module
 * never talks to Docker itself. It aggregates four reasons a browser must stay up
 * (agent turns, human viewers, in-flight proxied browser traffic, operator pins)
 * and, once all of them are gone for `idleMs`, snapshots the browser and releases
 * it through an injected runtime. The next caller that reserves a lease and
 * awaits `ready()` gets the browser rebuilt from that snapshot.
 *
 * Two invariants keep this safe under concurrency:
 *  - A snapshot failure never stops the browser; a stop failure is reported, not
 *    retried blindly against a browser we cannot account for.
 *  - Leases are re-checked after the snapshot and before the stop, so a lease that
 *    arrives mid-snapshot cancels the stop instead of losing the user's session.
 *
 * `status()` is a pure in-memory read: it never wakes the browser and never
 * extends the idle deadline, so a status poll cannot keep the browser alive.
 */

import { STORAGE_SNAPSHOT_SCHEMAS } from "./types.js";
import type {
  BrowserLifecycleState,
  BrowserLifecycleStatus,
  LeaseSummary,
  LifecycleErrorCode,
  PinLease,
  SnapshotWarning,
  ViewerLease,
} from "./types.js";

// ------------------------------------------------------------------ runtime

export interface RuntimeStatus {
  ok: boolean;
  /**
   * `true` when a browser is proven to be running, `false` when the runtime
   * proved nothing is there, and `null` when ownership could not be established.
   * `null` is never treated as `false`: "cannot tell" must not make the next
   * caller start a second browser.
   */
  browserRunning: boolean | null;
  /** `owned` / `absent` / `unknown`; the runtime's own attribution verdict. */
  browserAttribution?: "owned" | "absent" | "unknown" | null;
  supervisorRunning: boolean;
  pid?: number | null;
  /** Start time of the running browser, so a recycled PID is never mistaken. */
  starttime?: number | null;
  version?: string | null;
  message?: string | null;
  /** savedAt of the snapshot the runtime holds for the *asleep* browser. */
  snapshotAt?: number | null;
  /** savedAt of the snapshot already applied to the running browser, if any. */
  restoredSnapshotAt?: number | null;
  /**
   * The runtime's own verdict that a restore is still owed. It is authoritative:
   * a snapshot merely existing on disk does not mean the running browser was
   * released, so this core never infers a pending restore from a file.
   */
  restorePending?: boolean;
  /**
   * Identity of the browser the pending restore belongs to, taken from the
   * snapshot. A restore is only owed for this exact process; a different
   * (newly started) browser is a fresh session, not a lost one.
   */
  pendingBrowserPid?: number | null;
  pendingBrowserStarttime?: number | null;
  /**
   * Schema of the snapshot on disk (null when there is none). A snapshot written
   * before the storage capture existed can never authorise a release.
   */
  snapshotSchema?: number | null;
  /**
   * True only when the snapshot carries a complete cookies/localStorage/IndexedDB
   * capture. A snapshot without it is a lossy snapshot: releasing on it would
   * log the user out, so the core refuses to sleep until a fresh one is taken.
   */
  snapshotHasStorage?: boolean;
  /** Content-free storage counts, for the UI (never cookies/localStorage values). */
  storageCounts?: {
    cookies: number;
    origins: number;
    localStorageEntries: number;
    indexedDbDatabases: number;
  } | null;
  /**
   * True while *another* process holds the cross-process transition lock (a
   * previous control plane that is still stopping/restoring). A read-only probe:
   * it never waits and never takes the lock.
   */
  transitionBusy?: boolean;
}

export interface SnapshotOutcome {
  ok: boolean;
  savedAt?: number | null;
  tabs?: number;
  skipped?: number;
  warnings?: SnapshotWarning[];
  /** True when the runtime refused the snapshot for a conservative reason. */
  blocked?: boolean;
  message?: string | null;
  /** False when the runtime could not confirm the real tab order. */
  orderVerified?: boolean;
  /**
   * Content-free storage counts of the snapshot that was just written. A capture
   * that could not export cookies/localStorage/IndexedDB fails outright instead
   * of reporting zero counts, so a successful snapshot always has these.
   */
  storageCounts?: {
    cookies: number;
    origins: number;
    localStorageEntries: number;
    indexedDbDatabases: number;
  } | null;
  /** Stable machine-readable refusal code (e.g. `snapshot_storage_missing`). */
  reason?: string | null;
}

export interface StopOutcome {
  ok: boolean;
  message?: string | null;
  /**
   * Stable refusal code from the runtime (e.g. `snapshot_storage_missing`). A
   * refusal is not a failure: the browser is still running and untouched, so the
   * core reports it as blocked rather than as an error.
   */
  reason?: string | null;
}

export interface WakeOutcome {
  ok: boolean;
  restoredTabs?: number | null;
  message?: string | null;
}

/**
 * The container-side capabilities this state machine drives. Implementations must
 * be side-effect-free for `status()`, must never stop the container, and must not
 * force-kill the browser process.
 */
export interface BrowserRuntimeLike {
  /** Read-only probe. Must not start, wake or extend anything. */
  status(opts?: { timeoutMs?: number }): Promise<RuntimeStatus>;
  /** Capture tabs/scroll/sessionStorage. Must never stop the browser. */
  snapshot(opts?: { timeoutMs?: number }): Promise<SnapshotOutcome>;
  /**
   * Release the browser. Refuses when no usable snapshot exists. The control
   * plane passes the identity it verified before the stop so the runtime can
   * re-check ownership immediately before signalling.
   */
  stop(opts?: {
    timeoutMs?: number;
    sourcePid?: number | null;
    sourceStarttime?: number | null;
  }): Promise<StopOutcome>;
  /** Start the browser and rebuild tabs from the snapshot when one exists. */
  wake(opts?: { timeoutMs?: number }): Promise<WakeOutcome>;
}

// -------------------------------------------------------------------- clock

export interface LifecycleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: LifecycleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface LifecycleLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export type LifecycleEventType =
  | "lease.reserved"
  | "lease.released"
  | "viewer.touched"
  | "viewer.expired"
  | "pin.added"
  | "pin.removed"
  | "idle.scheduled"
  | "sleep.started"
  | "sleep.cancelled"
  | "sleep.done"
  | "sleep.failed"
  | "sleep.blocked"
  | "wake.started"
  | "wake.done"
  | "wake.failed"
  | "reconciled"
  | "shutdown";

export interface LifecycleEvent {
  type: LifecycleEventType;
  state: BrowserLifecycleState;
  message?: string;
}

// ------------------------------------------------------------------- leases

export type LeaseKind = "turn" | "call" | "hold";

export interface Lease {
  readonly id: string;
  readonly kind: LeaseKind;
  /** Idempotent; a second call is a no-op. */
  release(): void;
}

export type SleepVerdict = "asleep" | "cancelled" | "blocked" | "error";

export interface SleepOutcome {
  verdict: SleepVerdict;
  message: string | null;
  warnings: SnapshotWarning[];
  savedAt: number | null;
}

export interface BrowserLifecycleOptions {
  runtime: BrowserRuntimeLike;
  /** `false` makes every operation a no-op that reports `enabled: false`. */
  enabled?: boolean;
  /** Quiet period with no holders before the browser is released. */
  idleMs?: number;
  /** A viewer lease that is not refreshed within this window stops counting. */
  viewerTtlMs?: number;
  /** Delay before an automatic retry after a failed sleep/wake. */
  retryDelayMs?: number;
  clock?: LifecycleClock;
  log?: LifecycleLogger;
  onEvent?: (event: LifecycleEvent) => void;
  snapshotTimeoutMs?: number;
  stopTimeoutMs?: number;
  wakeTimeoutMs?: number;
  /** Stable id generator, injectable so tests get deterministic lease ids. */
  newId?: () => string;
  /**
   * Budget for the one-shot read-only reconcile barrier that runs before the
   * first real browser use. It retries only while another process is finishing a
   * transition; it never wakes the browser and never blocks `status()`.
   */
  reconcileTimeoutMs?: number;
  /** Delay between reconcile retries while a transition is still in flight. */
  reconcileRetryMs?: number;
}

const DEFAULTS = {
  enabled: true,
  idleMs: 5 * 60_000,
  viewerTtlMs: 60_000,
  retryDelayMs: 60_000,
  snapshotTimeoutMs: 45_000,
  stopTimeoutMs: 30_000,
  wakeTimeoutMs: 90_000,
  reconcileTimeoutMs: 15_000,
  reconcileRetryMs: 500,
};

interface LeaseRecord {
  kind: LeaseKind;
  createdAt: number;
}

// ------------------------------------------------------------------ manager

/**
 * Owns the awake/idle/snapshotting/asleep/restoring/error state for one sandbox
 * browser. All methods are safe to call concurrently; sleep and wake are
 * single-flight, and `ready()` is the only call that can bring the browser back.
 */
export class BrowserLifecycle {
  #runtime: BrowserRuntimeLike;
  #clock: LifecycleClock;
  #log: LifecycleLogger;
  #onEvent: ((event: LifecycleEvent) => void) | undefined;
  #enabled: boolean;
  #idleMs: number;
  #viewerTtlMs: number;
  #retryDelayMs: number;
  #snapshotTimeoutMs: number;
  #stopTimeoutMs: number;
  #wakeTimeoutMs: number;
  #reconcileTimeoutMs: number;
  #reconcileRetryMs: number;

  #state: BrowserLifecycleState;
  #epoch = 0;
  #since: number;
  #lastError: string | null = null;
  #lastErrorCode: LifecycleErrorCode | null = null;

  /** Physical truth: true only after a stop confirmed the browser is gone. */
  #asleep = false;

  #leases = new Map<string, LeaseRecord>();
  #viewers = new Map<string, ViewerLease>();
  #pins = new Map<string, PinLease>();
  /**
   * Recently released viewer ids. A heartbeat that was already on the wire when
   * the panel was hidden must not rebuild the lease it just gave up; the
   * tombstone expires so a genuinely new panel can still register.
   */
  #viewerTombstones = new Map<string, { generation: number; at: number }>();

  #idleTimer: unknown = null;
  #idleDeadline: number | null = null;
  #retryTimer: unknown = null;
  /** Re-evaluates holders when the earliest viewer/pin lease expires. */
  #expiryTimer: unknown = null;

  #sleepPromise: Promise<SleepOutcome> | null = null;
  #wakePromise: Promise<void> | null = null;
  /**
   * One-shot read-only reconcile that every real browser use awaits first. It
   * exists because a freshly constructed lifecycle starts out trusting its own
   * optimistic `awake`/`idle` state, while the container may actually hold a
   * *sleeping* browser or a browser a previous control plane still owes a restore
   * for. Without it the first `ready()` after a restart would hand out a browser
   * that has to be rebuilt. Coalesced: concurrent callers share one probe.
   */
  #reconciled: Promise<void> | null = null;

  #snapshotAt: number | null = null;
  #snapshotSchema: number | null = null;
  #snapshotHasStorage = false;
  #storageCounts: NonNullable<RuntimeStatus["storageCounts"]> | null = null;
  #transitionBusy = false;
  #warnings: SnapshotWarning[] = [];
  #unrestoredTabCount: number | null = null;

  #browserRunning: boolean | null = null;
  #probedAt: number | null = null;
  /**
   * Set when the container reports a running browser whose snapshot has not been
   * rebuilt into it yet (the usual state right after a control-plane restart).
   * The browser is not handed to a caller until the restore ran, and the idle
   * path refuses to snapshot-and-stop it so the pre-sleep tabs cannot be lost.
   */
  #pendingRestore = false;
  /** savedAt of the snapshot the running browser was built from. */
  #restoredSnapshotAt: number | null = null;
  /** Browser process identity the pending restore belongs to (from the snapshot). */
  #pendingRestorePid: number | null = null;
  #pendingRestoreStarttime: number | null = null;
  /**
   * Identity of the browser a stop is being attempted against, captured from a
   * fresh read-only probe immediately before the stop. A post-failure probe is
   * only allowed to declare the browser "still usable" when it reports this exact
   * process, so a recycled PID or a replacement browser is never adopted.
   */
  #stopSourcePid: number | null = null;
  #stopSourceStarttime: number | null = null;

  #disposed = false;
  #nextId: () => string;
  #seq = 0;

  constructor(opts: BrowserLifecycleOptions) {
    this.#runtime = opts.runtime;
    this.#clock = opts.clock ?? systemClock;
    this.#log = opts.log ?? {};
    this.#onEvent = opts.onEvent;
    this.#enabled = opts.enabled ?? DEFAULTS.enabled;
    this.#idleMs = Math.max(0, opts.idleMs ?? DEFAULTS.idleMs);
    this.#viewerTtlMs = Math.max(0, opts.viewerTtlMs ?? DEFAULTS.viewerTtlMs);
    this.#retryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULTS.retryDelayMs);
    this.#snapshotTimeoutMs = opts.snapshotTimeoutMs ?? DEFAULTS.snapshotTimeoutMs;
    this.#stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
    this.#wakeTimeoutMs = opts.wakeTimeoutMs ?? DEFAULTS.wakeTimeoutMs;
    this.#reconcileTimeoutMs = Math.max(0, opts.reconcileTimeoutMs ?? DEFAULTS.reconcileTimeoutMs);
    this.#reconcileRetryMs = Math.max(1, opts.reconcileRetryMs ?? DEFAULTS.reconcileRetryMs);
    this.#nextId = opts.newId ?? (() => `lease-${++this.#seq}`);
    // An idle browser with nothing holding it: arm the countdown immediately so a
    // freshly started control plane releases a browser nobody is using.
    this.#state = this.#enabled ? "idle" : "awake";
    this.#since = this.#clock.now();
    if (this.#enabled) this.#scheduleIdle();
  }

  // ------------------------------------------------------------- status API

  /**
   * Pure in-memory read. Never contacts the runtime, never wakes the browser and
   * never moves the idle deadline, so polling this is free and cannot keep the
   * browser alive.
   */
status(): BrowserLifecycleStatus {
    const now = this.#clock.now();
    return {
      enabled: this.#enabled,
      state: this.#state,
      idleDeadline: this.#idleDeadline,
      since: this.#since,
      epoch: this.#epoch,
      leases: this.#leaseSummary(now),
      pins: [...this.#pins.values()].filter((p) => p.expiresAt > now),
      lastError: this.#lastError,
      lastErrorCode: this.#lastErrorCode,
      snapshotAt: this.#snapshotAt,
      restoredSnapshotAt: this.#restoredSnapshotAt,
      restorePending: this.#pendingRestore,
      lastSnapshotWarnings: this.#warnings,
      unrestoredTabCount: this.#unrestoredTabCount,
      browserRunning: this.#browserRunning,
      probedAt: this.#probedAt,
      snapshotSchema: this.#snapshotSchema,
      snapshotHasStorage: this.#snapshotHasStorage,
      storageCounts: this.#storageCounts,
      transitionBusy: this.#transitionBusy,
    };
  }

  /**
   * Refresh the physical view of the browser without waking it, and reconcile the
   * displayed state when it disagrees with reality (the usual case after a control
   * plane restart, or after an out-of-band stop). Read-only by construction.
   */
  async observeRuntime(): Promise<BrowserLifecycleStatus> {
    // Capture the epoch before awaiting: if a sleep/wake completes while the probe
    // is in flight, its result describes an older physical world and must be
    // discarded rather than allowed to overwrite the newer state.
    const epochAtStart = this.#epoch;
    let res: RuntimeStatus;
    try {
      res = await this.#runtime.status({ timeoutMs: this.#stopTimeoutMs });
    } catch (err) {
      this.#log.warn?.("browser status probe failed", { detail: sanitizeDetail(err) });
      if (this.#epoch !== epochAtStart) {
        // A transition landed while we were probing; its verdict is newer than
        // this failed probe, so do not let the failure blank it out.
        this.#log.debug?.("discarding stale browser status probe");
        return this.status();
      }
      this.#probedAt = this.#clock.now();
      this.#browserRunning = null;
      this.#reconciled = null;
      return this.status();
    }
    if (this.#epoch !== epochAtStart) {
      // A transition landed while we were probing; keep its verdict.
      this.#log.debug?.("discarding stale browser status probe");
      return this.status();
    }
    this.#probedAt = this.#clock.now();
    this.#browserRunning = res.ok ? res.browserRunning : null;
    if (!res.ok) {
      this.#reconciled = null;
      return this.status();
    }
    // Never reconcile underneath an in-flight transition: the cycle itself owns
    // the state until it settles.
    if (this.#sleepPromise || this.#wakePromise || this.#disposed) return this.status();

    // The runtime is the only authority on whether a restore is owed: a snapshot
    // existing on disk does not mean this browser was ever released, so it must
    // never be converted into a pending restore here.
    const pending = res.restorePending === true;
    this.#transitionBusy = res.transitionBusy === true;
    if (this.#transitionBusy) this.#reconciled = null;
    if (typeof res.snapshotAt === "number") this.#snapshotAt = res.snapshotAt;
    this.#snapshotSchema = typeof res.snapshotSchema === "number" ? res.snapshotSchema : null;
    this.#snapshotHasStorage = res.snapshotHasStorage === true;
    this.#storageCounts = res.storageCounts ?? null;
    if (res.browserRunning && pending) {
      if (!this.#pendingRestore) {
        this.#pendingRestore = true;
        this.#epoch += 1;
        this.#cancelIdle();
        this.#cancelRetry();
        this.#setState("awake");
        this.#fail("restore_pending");
        this.#emit("reconciled", "浏览器在运行，但快照尚未恢复；下次打开时会先恢复标签");
      } else {
        // Still owed: keep the countdown off and remember the identity it belongs to.
        this.#cancelIdle();
      }
      this.#asleep = false;
      this.#rememberPendingIdentity(res);
      return this.status();
    }
    if (res.browserRunning === null || res.browserAttribution === "unknown") {
      // Ownership unknown: leave the physical flags exactly as they are. Adopting
      // `asleep` here would let the next ready() start a second Chromium, and
      // adopting "usable" would hand out a browser we cannot account for.
      this.#browserRunning = null;
      this.#reconciled = null;
      // A pending restore we could not rule out stays owed: the next ready() must
      // still reconcile and restore rather than treat the browser as usable.
      if (this.#asleep) this.#pendingRestore = true;
      return this.status();
    }
    if (!res.browserRunning && !this.#asleep) {
      // The browser is really gone while we believed it was awake: adopt reality
      // instead of claiming it is usable.
      this.#asleep = true;
      this.#pendingRestore = false;
      this.#forgetPendingIdentity();
      this.#epoch += 1;
      this.#cancelIdle();
      this.#setState("asleep");
      this.#emit("reconciled", "检测到浏览器已停止，已同步为休眠状态");
    } else if (res.browserRunning && this.#asleep) {
      // The runtime is the only authority on whether a restore is owed. A
      // snapshot file merely existing - e.g. a capture that was followed by a
      // lease cancelling the stop - must never be turned into a pending restore
      // here, or the next caller would rebuild over live pages.
      if (pending) {
        // Chromium is up and the runtime confirms it still owes the restore of the
        // snapshot we released it for: the next caller must restore before use.
        this.#pendingRestore = true;
        this.#epoch += 1;
        this.#cancelRetry();
        this.#cancelIdle();
        this.#fail("restore_pending");
        this.#emit("reconciled", "浏览器在运行，但快照尚未恢复；下次打开时会先恢复标签");
        this.#rememberPendingIdentity(res);
      } else {
        // A browser that came back without being released for a snapshot we still
        // hold is simply running: it is a normal, usable browser, not a lost one.
        this.#epoch += 1;
        this.#cancelRetry();
        this.#clearError();
        this.#resumeUsable();
        this.#emit("reconciled", "检测到浏览器正在运行，已同步为可用状态");
      }
      this.#asleep = false;
    } else if (this.#pendingRestore) {
      // A pending restore that the runtime no longer reports is done: the tabs are
      // back and the browser is usable again.
      this.#pendingRestore = false;
      this.#forgetPendingIdentity();
      this.#restoredSnapshotAt = res.restoredSnapshotAt ?? this.#snapshotAt;
      this.#clearError();
      this.#resumeUsable();
      this.#emit("reconciled", "快照已恢复到运行中的浏览器");
    }
    if (typeof res.snapshotAt === "number" && this.#snapshotAt === null) this.#snapshotAt = res.snapshotAt;
    return this.status();
  }

  /**
   * One-shot read-only reconcile, awaited by every real browser use.
   *
   * A delivered browser is only handed over once a probe has *confirmed* three
   * things: a running Chromium, exact ownership attribution, and no restore still
   * owed by another process (including a previous control plane that is still in
   * the middle of a stop/restore - the cross-process lock reports that as
   * `transitionBusy`, and this waits for it to clear within a bounded budget).
   *
   * Coalesced: concurrent callers share one probe. A failure is remembered and
   * re-thrown on every later `ready()` until a probe succeeds, so an inconclusive
   * first look can never be mistaken for "the browser is fine". `status()` never
   * calls this, so a read-only poll neither reconciles nor wakes anything.
   */
  #reconcile(): Promise<void> {
    if (this.#reconciled) return this.#reconciled;
    const promise = this.#runReconcile().catch((err) => {
      // A failed barrier must not be cached as done: drop the memo so the next
      // ready() tries again, and keep a stable, secret-free code surfaced.
      if (this.#reconciled === promise) this.#reconciled = null;
      throw err;
    });
    this.#reconciled = promise;
    return promise;
  }

  async #runReconcile(): Promise<void> {
    const deadline = this.#clock.now() + this.#reconcileTimeoutMs;
    for (;;) {
      // Never probe underneath an in-flight transition this process owns: the
      // cycle re-checks ownership itself and will settle the state.
      if (this.#sleepPromise || this.#wakePromise) {
        await (this.#sleepPromise ?? this.#wakePromise)?.catch(() => undefined);
        continue;
      }
      const epochAtStart = this.#epoch;
      let res: RuntimeStatus;
      try {
        res = await this.#runtime.status({ timeoutMs: this.#stopTimeoutMs });
      } catch (err) {
        this.#log.warn?.("browser reconcile probe failed", { detail: sanitizeDetail(err) });
        throw this.#reconcileError("reconcile_failed", err);
      }
      if (this.#epoch !== epochAtStart) {
        // A transition landed while we were probing; re-probe against the newer
        // physical world instead of trusting a stale answer.
        continue;
      }
      this.#probedAt = this.#clock.now();
      if (!res.ok) {
        this.#browserRunning = null;
        throw this.#reconcileError("reconcile_failed", res.message);
      }
      this.#adoptRuntimeStatus(res);
      // Another process is still stopping/restoring. Wait for it to clear, but
      // only within the bounded budget - a lock we cannot outlast fails closed.
      if (res.transitionBusy === true) {
        if (this.#clock.now() >= deadline) {
          throw this.#reconcileError(
            "reconcile_failed",
            "另一个进程仍在停止/恢复浏览器，等待超时",
          );
        }
        await this.#sleep(this.#reconcileRetryMs);
        continue;
      }
      // Ownership must be confirmed. `null`/`unknown` is never "absent": passing
      // it would let the next caller start a second Chromium.
      if (res.browserRunning === null || res.browserAttribution === "unknown") {
        this.#browserRunning = null;
        throw this.#reconcileError("reconcile_failed", "无法确认浏览器归属");
      }
      // A successful probe means the transient reconcile failure is over: clear it
      // so the status stops reporting a stale error.
      if (this.#lastErrorCode === "reconcile_failed") this.#clearError();
      if (res.browserRunning === false) {
        // Proven gone. The next step (ensureAwake) rebuilds it from the snapshot.
        this.#asleep = true;
        this.#pendingRestore = false;
        this.#forgetPendingIdentity();
        return;
      }
      // Running and owned. A restore the runtime still owes makes the browser
      // unusable until ready() runs (or joins) it.
      if (res.restorePending === true) {
        this.#pendingRestore = true;
        this.#asleep = false;
        this.#rememberPendingIdentity(res);
        return;
      }
      // The barrier may only *raise* the asleep/pending flags, never lower them:
      //  - a locally-recorded `asleep` reflects a release this incarnation really
      //    performed, and a runtime that still claims a running browser is either
      //    stale or looking at a process we never accounted for - the next step
      //    (a real wake/restore) settles it;
      //  - a locally-recorded `pendingRestore` reflects work this incarnation owes;
      //    a probe cannot prove the tabs were rebuilt, so only a completed restore
      //    (`#ensureAwake`) may clear it.
      // Adopting the browser here would hand out a process we refused to trust.
      if (this.#asleep || this.#pendingRestore) return;
      // A failed sleep left the same browser running: the browser is genuinely
      // usable, so leave a failed-transition state and re-arm the countdown.
      if (this.#state === "error" || this.#state === "idle") {
        if (this.#state === "error") this.#clearError();
        this.#resumeUsable();
      }
      return;
    }
  }

  /**
   * Adopt the read-only facts a probe returned. It never *derives* a pending
   * restore from a snapshot file: the runtime is the only authority on whether a
   * restore is still owed, so a snapshot merely existing never triggers a rebuild.
   */
  #adoptRuntimeStatus(res: RuntimeStatus): void {
    this.#browserRunning = res.browserRunning;
    this.#transitionBusy = res.transitionBusy === true;
    if (typeof res.snapshotAt === "number") this.#snapshotAt = res.snapshotAt;
    this.#snapshotSchema = typeof res.snapshotSchema === "number" ? res.snapshotSchema : null;
    this.#snapshotHasStorage = res.snapshotHasStorage === true;
    this.#storageCounts = res.storageCounts ?? null;
    if (typeof res.restoredSnapshotAt === "number") this.#restoredSnapshotAt = res.restoredSnapshotAt;

  }

  #reconcileError(code: LifecycleErrorCode, raw?: unknown): Error {
    const { message } = this.#fail(code, raw);
    this.#lastErrorCode = code;
    return new Error(message);
  }

  /** Clock-based sleep so a fake clock keeps tests deterministic. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#clock.setTimeout(resolve, ms);
    });
  }

  /** Remember which browser process the owed restore belongs to. */
  #rememberPendingIdentity(res: RuntimeStatus): void {
    if (typeof res.pendingBrowserPid === "number") this.#pendingRestorePid = res.pendingBrowserPid;
    if (typeof res.pendingBrowserStarttime === "number") {
      this.#pendingRestoreStarttime = res.pendingBrowserStarttime;
    }
  }

  #forgetPendingIdentity(): void {
    this.#pendingRestorePid = null;
    this.#pendingRestoreStarttime = null;
  }

  // ---------------------------------------------------------------- leasing

  /**
   * Synchronously register a hold. Returns immediately so a caller can claim
   * before any `await` (this is what keeps two concurrent submissions from both
   * seeing an unheld browser). Use `ready()` before actually using the browser.
   */
  reserve(kind: LeaseKind): Lease {
    this.#assertUsable();
    const id = this.#nextId();
    this.#leases.set(id, { kind, createdAt: this.#clock.now() });
    this.#onHolderAdded();
    this.#emit("lease.reserved", `${kind} lease reserved`);
    let released = false;
    return {
      id,
      kind,
      release: () => {
        if (released) return;
        released = true;
        this.release(id);
      },
    };
  }

  /** Release a lease by id. Unknown or already-released ids are ignored. */
  release(id: string): void {
    if (!this.#leases.delete(id)) return;
    this.#emit("lease.released", "lease released");
    this.#onHolderRemoved();
  }

  /**
   * Register or refresh a viewer hold. The caller is a visible browser panel in
   * a specific window; a viewer that stops heartbeating expires on its own.
   *
   * `generation` is the incarnation the caller believes it holds. A heartbeat
   * from an incarnation that was already released is ignored, so a late message
   * cannot resurrect a cancelled lease; a panel that remounts passes a higher
   * generation and is accepted immediately (fast tab switches stay cheap).
   * Returns the accepted lease, or null when the heartbeat was stale.
   */
  touchViewer(id: string, sessionId: string, generation = 0): ViewerLease | null {
    this.#assertUsable();
    const now = this.#clock.now();
    const key = JSON.stringify([sessionId, id]);
    const live = this.#viewers.get(key);
    if (live) {
      if (generation < live.generation) {
        this.#emit("viewer.touched", "stale viewer heartbeat ignored");
        return null;
      }
      const next: ViewerLease = { id, sessionId, seenAt: now, generation };
      this.#viewers.set(key, next);
      this.#emit("viewer.touched", generation > live.generation ? "viewer rejoined" : "viewer heartbeat");
      this.#armExpiry();
      return next;
    }
    const tombstone = this.#viewerTombstones.get(key);
    if (tombstone && generation <= tombstone.generation) {
      this.#emit("viewer.touched", "heartbeat after release ignored");
      return null;
    }
    this.#viewerTombstones.delete(key);
    const created: ViewerLease = { id, sessionId, seenAt: now, generation };
    this.#viewers.set(key, created);
    this.#onHolderAdded();
    this.#emit("viewer.touched", "viewer joined");
    this.#armExpiry();
    return created;
  }

  /**
   * Drop a viewer lease. When `generation` is supplied it is the incarnation the
   * caller believes it held: a release that arrives late (after the panel
   * remounted and claimed a newer generation) must not drop the newer lease, and
   * a release for an incarnation the server no longer tracks is still recorded as
   * a tombstone so a late heartbeat cannot resurrect it.
   */
  releaseViewer(id: string, generation?: number, sessionId?: string): void {
    // Omitted session is reserved for trusted in-process cleanup. HTTP always supplies it.
    const owner = sessionId ?? [...this.#viewers.values()].find(v => v.id === id)?.sessionId;
    if (!owner) return;
    const key = JSON.stringify([owner, id]);
    const viewer = this.#viewers.get(key);
    if (!viewer) {
      // Nothing is held. Record a tombstone for the released generation (when
      // known) so a heartbeat that was already on the wire is rejected instead of
      // rebuilding the lease the panel just gave up.
      if (typeof generation === "number" && generation > 0) {
        const existing = this.#viewerTombstones.get(key);
        if (!existing || generation > existing.generation) {
          this.#viewerTombstones.set(key, { generation, at: this.#clock.now() });
        }
      }
      return;
    }
    if (typeof generation === "number" && generation < viewer.generation) {
      // A late release from an already-superseded incarnation: ignore it and keep
      // the newer panel's lease intact.
      this.#emit("lease.released", "stale viewer release ignored");
      return;
    }
    this.#viewers.delete(key);
    this.#viewerTombstones.set(key, { generation: Math.max(viewer.generation, generation ?? 0), at: this.#clock.now() });
    this.#emit("lease.released", "viewer released");
    this.#onHolderRemoved();
    this.#armExpiry();
  }

  /** Drop every viewer hold belonging to a session, e.g. on logout. */
  releaseViewersForSession(sessionId: string): number {
    let dropped = 0;
    const now = this.#clock.now();
    for (const [id, viewer] of [...this.#viewers]) {
      if (viewer.sessionId !== sessionId) continue;
      this.#viewers.delete(id);
      this.#viewerTombstones.set(id, { generation: viewer.generation, at: now });
      dropped += 1;
    }
    if (dropped > 0) {
      this.#emit("lease.released", `${dropped} viewer lease(s) released for session`);
      this.#onHolderRemoved();
      this.#armExpiry();
    }
    return dropped;
  }

  /**
   * Add an explicit hold for work the control plane cannot observe (a terminal
   * driving CDP, a background script). Pass no `ttlMs` for a pin that lasts until
   * it is explicitly released.
   */
  pin(note: string, ttlMs?: number): PinLease {
    this.#assertUsable();
    const now = this.#clock.now();
    const id = this.#nextId();
    const created: PinLease = {
      id,
      note,
      createdAt: now,
      expiresAt: ttlMs && ttlMs > 0 ? now + ttlMs : Number.POSITIVE_INFINITY,
    };
    this.#pins.set(id, created);
    this.#onHolderAdded();
    this.#armExpiry();
    this.#emit("pin.added", "browser pin added");
    return created;
  }

  unpin(id: string): void {
    if (!this.#pins.delete(id)) return;
    this.#emit("pin.removed", "browser pin removed");
    this.#onHolderRemoved();
    this.#armExpiry();
  }

  /**
   * Add a hold that is *identified* by its note instead of by a caller-held id.
   *
   * A browser tab or a page reload destroys whatever React state remembered the
   * pin id, which used to leave a permanent pin the UI could no longer release.
   * Reusing the existing pin with the same note makes the call idempotent, so a
   * reloaded or second window can re-derive the same pin from the status payload
   * and release exactly that one.
   */
  pinIdentified(note: string, ttlMs?: number): PinLease {
    this.#assertUsable();
    const now = this.#clock.now();
    for (const existing of this.#pins.values()) {
      if (existing.note === note && existing.expiresAt > now) {
        if (ttlMs && ttlMs > 0) existing.expiresAt = now + ttlMs;
        this.#armExpiry();
        return existing;
      }
    }
    return this.pin(note, ttlMs);
  }

  /** Release the pins with exactly this note. Never touches a differently-noted pin. */
  unpinNote(note: string): number {
    let removed = 0;
    for (const [id, pin] of [...this.#pins]) {
      if (pin.note !== note) continue;
      this.#pins.delete(id);
      removed += 1;
    }
    if (removed > 0) {
      this.#emit("pin.removed", "browser pin removed");
      this.#onHolderRemoved();
      this.#armExpiry();
    }
    return removed;
  }

  /** Currently held pins, expired ones excluded. */
  pins(): PinLease[] {
    const now = this.#clock.now();
    return [...this.#pins.values()].filter((p) => p.expiresAt > now);
  }

  // ------------------------------------------------------------- awake path

  /**
   * Resolve once the browser is usable. Returns immediately while it is already
   * awake; otherwise runs (or joins) a single wake. If a stop is in flight the
   * caller waits for that stop to finish and then waits for the wake, so a lease
   * taken during a stop is never allowed to use a browser that is going away.
   */
  async ready(): Promise<void> {
    this.#assertUsable();
    // A stop in flight owns the browser until it settles: the caller waits for
    // that stop and then for the restore, so it never receives a browser that is
    // being torn down (and never races a half-finished stop).
    const sleepInFlight = this.#sleepPromise;
    if (sleepInFlight) await sleepInFlight.catch(() => undefined);
    // Read-only reconcile barrier. A freshly constructed lifecycle starts out
    // trusting its own optimistic state, but the container may already hold a
    // sleeping browser - or a browser a previous control plane still owes a
    // restore for. Until one probe confirms the real ownership, no caller is
    // handed a browser. An inconclusive probe fails closed instead of passing.
    await this.#reconcile();
    if (this.#asleep || this.#pendingRestore) {
      await this.#ensureAwake();
      return;
    }
    // The reconcile above is the only thing allowed to restore a usable state:
    // an unconfirmed browser never becomes usable here.
    if (this.#state === "error" && this.#browserRunning === true && !this.#pendingRestore) {
      this.#resumeUsable();
    }
  }

  /**
   * Explicit wake (single-flight). A no-op when the browser is already awake, but
   * never races a stop: if one is in flight the caller waits for it and then
   * restores, so a wake can never hand out a browser that is being torn down.
   */
  async wake(): Promise<void> {
    this.#assertUsable();
    const sleepInFlight = this.#sleepPromise;
    if (sleepInFlight) await sleepInFlight.catch(() => undefined);
    await this.#reconcile();
    if (!this.#asleep && !this.#pendingRestore) {
      if (this.#state === "error" && this.#browserRunning === true && !this.#pendingRestore) {
        this.#resumeUsable();
      }
      return;
    }
    await this.#ensureAwake();
  }

  // ------------------------------------------------------------- sleep path

  /**
   * Run one sleep cycle now instead of waiting for the idle countdown. There is
   * deliberately no `force` option: a live task, viewer or pin always wins, and a
   * lease that arrives mid-snapshot still cancels the stop. Releasing a browser
   * underneath a running task is never a supported operation.
   */
  async sleepNow(): Promise<SleepOutcome> {
    this.#assertUsable();
    if (!this.#enabled) {
      const { message } = this.#fail("disabled");
      return { verdict: "blocked", message, warnings: [], savedAt: this.#snapshotAt };
    }
    this.#cancelIdle();
    if (this.#hasHolders()) {
      const { message } = this.#fail("holders");
      this.#emit("sleep.blocked", message);
      this.#scheduleIdle();
      return { verdict: "blocked", message, warnings: [], savedAt: this.#snapshotAt };
    }
    return this.#runSleepCycle();
  }

  /** Stop the idle countdown and refuse further operations. Never stops a browser. */
  shutdown(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelIdle();
    this.#cancelRetry();
    this.#cancelExpiry();
    this.#emit("shutdown", "lifecycle disposed");
  }

  // ------------------------------------------------------------- internals

  /**
   * Errors from the container runtime can embed page URLs, cookies, tokens or
   * serialized storage. Nothing that reaches the API or the UI may carry those,
   * so the caller-visible text is a fixed Chinese sentence chosen by a stable
   * code; the raw text is only ever reduced to a short redacted breadcrumb for
   * the server log, where it stays inside this process.
   */
  #fail(code: LifecycleErrorCode, raw?: unknown): { code: LifecycleErrorCode; message: string } {
    const message = ERROR_MESSAGES[code];
    this.#lastError = message;
    this.#lastErrorCode = code;
    if (raw !== undefined) {
      this.#log.warn?.("browser lifecycle failure", { code, detail: sanitizeDetail(raw) });
    }
    return { code, message };
  }

  #clearError(): void {
    this.#lastError = null;
    this.#lastErrorCode = null;
  }

  /**
   * Read-only probe used after a failed stop. It returns the whole picture, not
   * just "something is running": a running process is only usable when the
   * runtime also says there is no owed restore and its identity matches what we
   * were dealing with. Anything else stays fail-closed.
   */
  async #probeAfterFailedStop(): Promise<{
    running: boolean | null;
    usable: boolean;
    identityMatches: boolean;
  }> {
    try {
      const res = await this.#runtime.status({ timeoutMs: this.#stopTimeoutMs });
      if (!res.ok) {
        this.#browserRunning = null;
        this.#probedAt = this.#clock.now();
        return { running: null, usable: false, identityMatches: false };
      }
      this.#probedAt = this.#clock.now();
      this.#browserRunning = res.browserRunning;
      if (typeof res.snapshotAt === "number" && this.#snapshotAt === null) this.#snapshotAt = res.snapshotAt;
      if (res.browserRunning !== true) {
        // `false` means it is gone; `null` means we cannot tell. Neither is usable,
        // and the caller keeps them distinct in the status it reports.
        return { running: res.browserRunning === false ? false : null, usable: false, identityMatches: false };
      }
      // Identity: the browser we were about to stop must still be the same one,
      // otherwise we are looking at a process we never accounted for.
      const identityMatches = this.#matchesKnownIdentity(res);
      const owed = res.restorePending === true;
      return { running: true, usable: identityMatches && !owed, identityMatches };
    } catch (err) {
      this.#log.warn?.("browser status probe failed", { detail: sanitizeDetail(err) });
      return { running: null, usable: false, identityMatches: false };
    }
  }

  /**
   * True when the probed browser is the exact process this lifecycle was dealing
   * with. The reference identity is the stop source recorded before the stop; a
   * process the runtime cannot name (no PID) is never vouched for.
   */
  #matchesKnownIdentity(res: RuntimeStatus): boolean {
    if (typeof res.pid !== "number") {
      // The runtime cannot name the process, so it cannot vouch for it either.
      return false;
    }
    if (this.#asleep) return false;
    if (this.#stopSourcePid === null) {
      // Nothing was ever recorded: we have no identity to match against, so we
      // cannot claim this is the same process.
      return false;
    }
    if (this.#stopSourcePid !== res.pid) return false;
    if (this.#stopSourceStarttime !== null) {
      if (typeof res.starttime !== "number" || res.starttime !== this.#stopSourceStarttime) return false;
    }
    if (this.#pendingRestorePid !== null && this.#pendingRestorePid !== res.pid) return false;
    if (
      this.#pendingRestoreStarttime !== null &&
      typeof res.starttime === "number" &&
      this.#pendingRestoreStarttime !== res.starttime
    ) {
      return false;
    }
    return true;
  }

  /**
   * Read-only probe taken immediately before a stop. It answers a four-way
   * question rather than a boolean, because "nothing is listening" and "I cannot
   * tell what is listening" mean opposite things: the first means the release
   * already happened, the second must block.
   */
  async #captureStopSource(): Promise<
    | { kind: "ready"; pid: number; starttime: number | null }
    | { kind: "already-gone" }
    | { kind: "restore-owed" }
    | { kind: "transition-busy" }
    | { kind: "storage-missing" }
    | { kind: "unknown" }
  > {
    let res: RuntimeStatus;
    try {
      res = await this.#runtime.status({ timeoutMs: this.#stopTimeoutMs });
    } catch (err) {
      this.#log.warn?.("pre-stop browser probe failed", { detail: sanitizeDetail(err) });
      return { kind: "unknown" };
    }
    if (!res.ok) return { kind: "unknown" };
    this.#probedAt = this.#clock.now();
    this.#adoptRuntimeStatus(res);
    // Another process (typically a previous control plane) owns a stop/restore
    // right now. Signalling underneath it would fight over the same browser, so
    // this cycle stands down; the idle countdown re-arms and retries later.
    if (res.transitionBusy === true) return { kind: "transition-busy" };
    if (res.browserRunning === null || res.browserAttribution === "unknown") {
      // Ownership could not be proven. That is not "no browser": signalling now
      // could hit a process we never attributed, so refuse.
      return { kind: "unknown" };
    }
    if (!res.browserRunning) {
      // Nothing to release: the browser already went away (out-of-band stop, or a
      // previous partially-applied stop). Adopt it instead of signalling blind.
      return { kind: "already-gone" };
    }
    if (res.restorePending === true) return { kind: "restore-owed" };
    if (typeof res.pid !== "number") return { kind: "unknown" };
    // Dual gate: the core refuses to release on a snapshot the runtime itself
    // reports as lossy. The helper enforces the same rule immediately before the
    // signal, so a snapshot that lost its storage can never authorise a stop.
    if (res.snapshotHasStorage !== true) return { kind: "storage-missing" };
    if (typeof res.snapshotSchema === "number" && !STORAGE_SNAPSHOT_SCHEMAS.includes(res.snapshotSchema)) {
      return { kind: "storage-missing" };
    }
    return { pid: res.pid, starttime: typeof res.starttime === "number" ? res.starttime : null, kind: "ready" };
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("浏览器生命周期已关闭");
  }

  #leaseSummary(now: number): LeaseSummary {
    let turns = 0;
    let calls = 0;
    let holds = 0;
    for (const lease of this.#leases.values()) {
      if (lease.kind === "turn") turns += 1;
      else if (lease.kind === "call") calls += 1;
      else holds += 1;
    }
    return {
      turns,
      viewers: this.#liveViewers(now).length,
      calls,
      holds,
      pins: [...this.#pins.values()].filter((p) => p.expiresAt > now).length,
    };
  }

  #liveViewers(now: number): ViewerLease[] {
    return [...this.#viewers.values()].filter((v) => now - v.seenAt < this.#viewerTtlMs);
  }

  /** Drop expired viewers/pins so the holder count reflects reality. */
  #prune(): void {
    const now = this.#clock.now();
    for (const [id, tomb] of [...this.#viewerTombstones]) {
      if (now - tomb.at >= this.#viewerTtlMs) this.#viewerTombstones.delete(id);
    }
    for (const [id, viewer] of [...this.#viewers]) {
      // >= not >: the expiry timer fires exactly at `seenAt + ttl`, so a strict
      // comparison would leave the lease in place and re-arm a 0ms timer forever.
      if (now - viewer.seenAt >= this.#viewerTtlMs) {
        this.#viewers.delete(id);
        this.#emit("viewer.expired", "viewer lease expired");
      }
    }
    for (const [id, pin] of [...this.#pins]) {
      if (pin.expiresAt <= now) {
        this.#pins.delete(id);
        this.#emit("pin.removed", "browser pin expired");
      }
    }
  }

  #hasHolders(): boolean {
    this.#prune();
    return this.#leases.size > 0 || this.#viewers.size > 0 || this.#pins.size > 0;
  }

  #onHolderAdded(): void {
    this.#cancelRetry();
    this.#cancelIdle();
    if (this.#state === "idle" || this.#state === "error") {
      // A holder appeared while the browser was only idling or after a failed
      // transition; the browser itself was never released in either case.
      this.#setState("awake");
    }
  }

  #onHolderRemoved(): void {
    if (this.#disposed || !this.#enabled) return;
    if (this.#hasHolders()) return;
    if (this.#asleep || this.#pendingRestore) return;
    this.#scheduleIdle();
  }

  #scheduleIdle(): void {
    if (this.#disposed || !this.#enabled) return;
    // A countdown must not run for a browser that still owes a restore: stopping
    // it would discard the tabs the user is waiting for.
    if (this.#pendingRestore) return;
    this.#cancelIdle();
    const delay = this.#idleMs;
    this.#idleDeadline = this.#clock.now() + delay;
    this.#setState("idle");
    this.#idleTimer = this.#clock.setTimeout(() => {
      this.#idleTimer = null;
      this.#idleDeadline = null;
      void this.#runSleepCycle().catch(() => undefined);
    }, delay);
    this.#emit("idle.scheduled", `将在 ${Math.round(delay / 1000)} 秒后释放浏览器`);
  }

  #cancelIdle(): void {
    if (this.#idleTimer !== null) {
      this.#clock.clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    this.#idleDeadline = null;
  }

  #cancelExpiry(): void {
    if (this.#expiryTimer !== null) {
      this.#clock.clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
  }

  /**
   * Viewers and TTL pins expire on their own, but nothing would notice: without a
   * timer armed at the earliest expiry, a browser held only by an expired viewer
   * would never be released. Re-arms whenever holders change.
   */
  #armExpiry(): void {
    this.#cancelExpiry();
    if (this.#disposed || !this.#enabled) return;
    // Expiry only matters for holders; a pending restore is handled by ready().
    if (this.#pendingRestore) return;
    const now = this.#clock.now();
    let earliest: number | null = null;
    for (const viewer of this.#viewers.values()) {
      const at = viewer.seenAt + this.#viewerTtlMs;
      if (earliest === null || at < earliest) earliest = at;
    }
    for (const pin of this.#pins.values()) {
      if (!Number.isFinite(pin.expiresAt)) continue;
      if (earliest === null || pin.expiresAt < earliest) earliest = pin.expiresAt;
    }
    if (earliest === null) return;
    // `#prune` treats `now >= expiry` as expired, so firing exactly at `earliest`
    // is enough; no +1 and no zero-delay spin.
    const delay = Math.max(0, earliest - now);
    this.#expiryTimer = this.#clock.setTimeout(() => {
      this.#expiryTimer = null;
      if (this.#disposed) return;
      this.#onHolderRemoved();
      this.#armExpiry();
    }, delay);
  }

  #scheduleRetry(): void {
    if (this.#disposed || !this.#enabled || this.#retryTimer !== null) return;
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = null;
      if (this.#disposed || !this.#enabled) return;
      if (this.#asleep || this.#hasHolders() || this.#pendingRestore) return;
      void this.#runSleepCycle().catch(() => undefined);
    }, this.#retryDelayMs);
  }

  #cancelRetry(): void {
    if (this.#retryTimer !== null) {
      this.#clock.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  async #ensureAwake(): Promise<void> {
    if (!this.#asleep && !this.#pendingRestore) return;
    if (this.#wakePromise) return this.#wakePromise;
    const promise = (async () => {
      this.#cancelRetry();
      // `restoring into a running browser` is the post-restart reconciliation
      // case: Chromium is up but its tabs still have to be rebuilt.
      const intoRunning = !this.#asleep;
      this.#setState("restoring");
      this.#emit("wake.started", intoRunning ? "正在把快照恢复进正在运行的浏览器" : "正在启动并恢复浏览器");
      try {
        const res = await this.#runtime.wake({ timeoutMs: this.#wakeTimeoutMs });
        const { message } = this.#fail("wake_failed", res.message);
        if (!res.ok) {
          // Reject with the fixed, secret-free text: the caller (and its logs)
          // must never receive a container message that can embed a page URL.
          throw new Error(message);
        }
        this.#asleep = false;
        this.#pendingRestore = false;
        this.#restoredSnapshotAt = this.#snapshotAt;
        // A completed wake proves the browser is up; recording it keeps the
        // status honest without another probe.
        this.#browserRunning = true;
        this.#probedAt = this.#clock.now();
        this.#forgetPendingIdentity();
        this.#epoch += 1;
        this.#clearError();
        this.#setState("awake");
        this.#emit("wake.done", "浏览器已恢复");
        if (this.#hasHolders()) this.#cancelIdle();
        else this.#scheduleIdle();
      } catch (err) {
        // Keep the snapshot and the asleep flag: the next ready() retries the
        // restore instead of pretending the browser is usable.
        const known = err instanceof Error && err.message === ERROR_MESSAGES.wake_failed;
        const { message } = known ? this.#fail("wake_failed") : this.#fail("wake_failed", err);
        this.#pendingRestore = true;
        this.#setState("error");
        this.#log.error?.("browser restore failed", { error: message });
        this.#emit("wake.failed", message);
        // Always throw the fixed, secret-free sentence. A runtime that rejects
        // with a raw Error must never hand a page URL or token to the caller.
        throw new Error(message);
      }
    })().finally(() => {
      if (this.#wakePromise === promise) this.#wakePromise = null;
    });
    this.#wakePromise = promise;
    return promise;
  }

  #runSleepCycle(): Promise<SleepOutcome> {
    if (this.#sleepPromise) return this.#sleepPromise;
    const promise = this.#sleepCycle()
      .catch((err) => {
        const { message } = this.#fail("runtime_error", err);
        this.#setState("error");
        this.#log.error?.("browser sleep cycle failed", { error: message });
        this.#emit("sleep.failed", message);
        this.#scheduleRetry();
        return { verdict: "error" as SleepVerdict, message, warnings: this.#warnings, savedAt: this.#snapshotAt };
      })
      .finally(() => {
        if (this.#sleepPromise === promise) this.#sleepPromise = null;
      });
    this.#sleepPromise = promise;
    return promise;
  }

  async #sleepCycle(): Promise<SleepOutcome> {
    if (this.#asleep) {
      return { verdict: "asleep", message: null, warnings: this.#warnings, savedAt: this.#snapshotAt };
    }
    if (this.#pendingRestore) {
      // Snapshotting now would overwrite the snapshot the user's tabs live in
      // with whatever this stale browser happens to show. Refuse, surface it and
      // retry later; the next ready() rebuilds the tabs first.
      const { message } = this.#fail("restore_pending");
      this.#emit("sleep.blocked", message);
      this.#scheduleRetry();
      return { verdict: "blocked", message, warnings: this.#warnings, savedAt: this.#snapshotAt };
    }
    this.#cancelIdle();
    this.#setState("snapshotting");
    this.#emit("sleep.started", "正在保存浏览器快照");

    const snap = await this.#runtime.snapshot({ timeoutMs: this.#snapshotTimeoutMs });
    // `skipped > 0` matters as much as `ok`: the runtime refuses to write a
    // partial snapshot, but a runtime that reported success while dropping pages
    // would silently lose them, so this is checked independently.
    const incomplete = (snap.skipped ?? 0) > 0;
    // A successful snapshot must also carry the storage capture: the runtime fails
    // outright without it, so a `ok` result that reports a lossy schema is treated
    // as a refusal here too, before any stop is even considered.
    const lossyStorage = snap.ok && !snap.blocked && snap.storageCounts == null;
    if (!snap.ok || snap.blocked || incomplete || lossyStorage) {
      // A snapshot we cannot trust must never be followed by a stop. The most
      // specific reason wins so the UI can name the real problem.
      const code: LifecycleErrorCode = incomplete
        ? "snapshot_incomplete"
        : snap.blocked
          ? "snapshot_blocked"
          : lossyStorage
            ? "snapshot_storage_missing"
            : "snapshot_failed";
      const { message } = this.#fail(code, snap.message);
      this.#setState("error");
      this.#log.warn?.("browser snapshot failed; keeping the browser running", { error: message });
      this.#emit("sleep.failed", message);
      this.#scheduleRetry();
      this.#armExpiry();
      return { verdict: "error", message, warnings: snap.warnings ?? this.#warnings, savedAt: this.#snapshotAt };
    }
    this.#snapshotAt = snap.savedAt ?? this.#clock.now();
    this.#warnings = snap.warnings ?? [];
    this.#unrestoredTabCount = snap.skipped ?? 0;
    this.#snapshotHasStorage = snap.storageCounts != null;
    this.#storageCounts = snap.storageCounts ?? null;
    this.#clearError();

    // A shutdown mid-snapshot must not start a stop: the cycle no longer owns
    // the browser's fate and shutting the control plane down is not a reason to
    // release a browser the operator may still be using.
    if (this.#disposed) {
      this.#emit("sleep.cancelled", "生命周期已关闭，取消释放");
      return { verdict: "cancelled", message: "生命周期已关闭，取消释放", warnings: this.#warnings, savedAt: this.#snapshotAt };
    }

    // Re-check holders *after* the snapshot: a lease that arrived while we were
    // snapshotting means the user is back, so the stop is cancelled. Nothing can
    // override this - there is no force path.
    if (this.#hasHolders() || !this.#enabled) {
      this.#clearError();
      this.#setState("awake");
      this.#emit("sleep.cancelled", "快照期间出现新的占用，已取消释放");
      return { verdict: "cancelled", message: "快照期间出现新的占用，已取消释放", warnings: this.#warnings, savedAt: this.#snapshotAt };
    }

    // Prove *which* browser is about to be released before asking for the stop.
    // Without a fully attributed source the runtime could release a process the
    // user is still typing in, so an inconclusive probe refuses instead.
    const source = await this.#captureStopSource();
    if (source.kind === "already-gone") {
      // The release already happened; nothing is left to signal. Record it and let
      // the next caller rebuild from the snapshot we just wrote.
      this.#asleep = true;
      this.#restoredSnapshotAt = null;
      this.#epoch += 1;
      this.#browserRunning = false;
      this.#clearError();
      this.#setState("asleep");
      this.#emit("sleep.done", "浏览器本已停止，已按休眠处理");
      return { verdict: "asleep", message: null, warnings: this.#warnings, savedAt: this.#snapshotAt };
    }
    if (source.kind !== "ready") {
      // Map the verdict to an honest, secret-free code. `transition-busy` and
      // `storage-missing` are refusals, not failures: the browser is untouched.
      const code: LifecycleErrorCode =
        source.kind === "restore-owed"
          ? "restore_pending"
          : source.kind === "storage-missing"
            ? "snapshot_storage_missing"
            : source.kind === "transition-busy"
              ? "restore_pending"
              : "stop_unattributed";
      const { message } = this.#fail(code);
      this.#log.warn?.("browser stop blocked", { reason: source.kind });
      // Never keep a stale `snapshotting` label: the browser is still up and needs
      // to look usable-with-a-caveat, not mid-transition.
      if (source.kind === "restore-owed") {
        this.#pendingRestore = true;
        this.#cancelIdle();
        this.#setState("awake");
      } else {
        // A refusal leaves the browser running and usable; only an unattributable
        // browser is a real error. Everything retries on the idle countdown.
        this.#setState(source.kind === "unknown" ? "error" : "awake");
        this.#scheduleRetry();
        this.#armExpiry();
      }
      this.#emit("sleep.blocked", message);
      return {
        verdict: source.kind === "unknown" ? "error" : "blocked",
        message,
        warnings: this.#warnings,
        savedAt: this.#snapshotAt,
      };
    }
    this.#stopSourcePid = source.pid;
    this.#stopSourceStarttime = source.starttime;

    const stopped = await this.#runtime.stop({
      timeoutMs: this.#stopTimeoutMs,
      sourcePid: source.pid,
      sourceStarttime: source.starttime,
    });
    if (!stopped.ok && stopped.reason === "snapshot_storage_missing") {
      // The helper refuses to release on a snapshot it cannot vouch for. The
      // browser was never signalled, so this is a refusal, not a failure: report
      // it as blocked and leave the browser running.
      const { message } = this.#fail("snapshot_storage_missing", stopped.message);
      this.#setState("awake");
      this.#scheduleRetry();
      this.#armExpiry();
      this.#emit("sleep.blocked", message);
      return { verdict: "blocked", message, warnings: this.#warnings, savedAt: this.#snapshotAt };
    }
    if (!stopped.ok) {
      // A failed stop does NOT prove the browser is still running: it may have
      // exited half-way. Re-probe before claiming anything, and when the probe is
      // inconclusive stay fail-closed (asleep) so callers wake instead of writing
      // into a browser that may be gone.
      const { message } = this.#fail("stop_failed", stopped.message);
      const probe = await this.#probeAfterFailedStop();
      if (probe.usable) {
        // The probe says the browser is the exact process we were dealing with
        // and the runtime owes no restore: it never went away, so the next caller
        // may use it. The failure stays visible but the browser is not "asleep".
        this.#browserRunning = true;
        this.#setState("error");
        this.#log.warn?.("browser stop failed; the same browser is still running", { error: message });
        this.#emit("sleep.failed", message);
        this.#scheduleRetry();
        this.#armExpiry();
        return { verdict: "error", message, warnings: this.#warnings, savedAt: this.#snapshotAt };
      }
      // Half-stopped, a process we cannot vouch for (different PID/starttime), or
      // unknown: stay fail-closed. `asleep` makes the next ready() run a restore
      // instead of handing out a browser whose state we cannot account for.
      this.#asleep = true;
      this.#browserRunning = probe.running;
      if (probe.running === true && !probe.identityMatches) {
        // Something is listening, but it is not the browser this lifecycle was
        // tracking. Do not adopt it as usable; require a restore first.
        this.#pendingRestore = true;
        this.#forgetPendingIdentity();
      }
      this.#epoch += 1;
      this.#setState("error");
      this.#log.warn?.("browser stop unconfirmed; will restore before next use", { error: message });
      this.#emit("sleep.failed", message);
      return { verdict: "error", message, warnings: this.#warnings, savedAt: this.#snapshotAt };
    }

    this.#asleep = true;
    this.#restoredSnapshotAt = null;
    this.#epoch += 1;
    this.#browserRunning = false;
    this.#stopSourcePid = null;
    this.#stopSourceStarttime = null;
    this.#setState("asleep");
    this.#emit("sleep.done", "浏览器已释放");
    return { verdict: "asleep", message: null, warnings: this.#warnings, savedAt: this.#snapshotAt };
  }

  /**
   * Return to a truthful usable state after a transition that left the browser
   * running. This is deliberately narrow: it is only called once a probe has
   * *confirmed* the browser is running and owned and owes no restore, so it can
   * never promote an unattributed or restore-owed browser to "usable".
   */
  #resumeUsable(): void {
    if (this.#pendingRestore) {
      this.#setState("awake");
      return;
    }
    if (this.#hasHolders()) this.#setState("awake");
    else this.#scheduleIdle();
  }

  #setState(next: BrowserLifecycleState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#since = this.#clock.now();
  }

  #emit(type: LifecycleEventType, message?: string): void {
    this.#onEvent?.({ type, state: this.#state, message });
  }
}

/**
 * Fixed, secret-free text per failure code. The UI shows this verbatim (or maps
 * the code to its own copy); nothing derived from a runtime error ever lands
 * here, so a URL, cookie or token cannot leak through the status API.
 */
const ERROR_MESSAGES: Record<LifecycleErrorCode, string> = {
  disabled: "浏览器生命周期未启用",
  holders: "存在占用（任务/观看/保留），未释放浏览器",
  shutdown: "生命周期已关闭，取消释放浏览器",
  snapshot_failed: "浏览器快照失败，已保留浏览器运行",
  snapshot_blocked: "页面状态无法安全保存，已放弃释放浏览器",
  snapshot_incomplete: "快照未覆盖全部标签，已放弃释放浏览器",
  snapshot_storage_missing: "快照缺少 cookies/本地存储/IndexedDB，已放弃释放浏览器以免丢失登录状态",
  reconcile_failed: "无法确认浏览器真实状态，已阻止使用浏览器",
  restore_pending: "存在尚未恢复到运行中浏览器的快照，暂不释放浏览器",
  stop_failed: "停止浏览器失败，正在核对真实状态",
  stop_unattributed: "无法确认正在运行的浏览器归属，已放弃释放浏览器",
  wake_failed: "恢复浏览器失败，快照仍然保留",
  runtime_error: "浏览器生命周期运行时错误",
};

/**
 * Reduce an arbitrary error to a short, URL-free, token-free breadcrumb. This is
 * for server-side logs only - never for the API response or the UI.
 */
export function sanitizeDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return raw
    .replace(/[a-z][a-z0-9+.\-]*:\/\/[^\s"'`]+/gi, "<url>")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
