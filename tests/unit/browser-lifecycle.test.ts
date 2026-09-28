import { describe, expect, it } from "vitest";
import {
  BrowserLifecycle,
  type BrowserRuntimeLike,
  type LifecycleClock,
  type RuntimeStatus,
} from "../../src/server/browser/lifecycle.js";
import type { SnapshotOutcome, StopOutcome, WakeOutcome } from "../../src/server/browser/lifecycle.js";
import type { SnapshotWarning } from "../../src/server/browser/types.js";

/**
 * Controllable clock so idle countdowns, viewer TTLs and expiry timers are
 * deterministic.
 *
 * A real timer keep-alive bug (a 0ms timer re-armed on every fire) used to spin
 * this loop forever and burn a core. The iteration cap turns any recurrence into
 * a loud failure instead of a hung worker.
 */
class FakeClock implements LifecycleClock {
  #now = 1_700_000_000_000;
  #timers = new Map<number, { at: number; fn: () => void }>();
  #next = 1;
  fired = 0;

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid timer delay ${ms}`);
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Advance the clock, firing due timers in time order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    let iterations = 0;
    for (;;) {
      if (iterations++ > 5_000) {
        throw new Error("timer storm: a callback kept re-arming a timer at the same instant");
      }
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, timer] = due[0];
      this.#timers.delete(id);
      this.#now = timer.at;
      this.fired += 1;
      timer.fn();
    }
    this.#now = target;
  }

  /** Timers that already fired can never be pending again. */
  get pendingTimers(): number {
    return this.#timers.size;
  }
}

/**
 * A sequenced value: a plain value, or a list consumed one entry per call where
 * the final entry repeats. This is how a test says "the browser is up when the
 * stop is attempted, then gone when the failure is re-probed".
 */
type Seq<T> = T | T[];

function at<T>(seq: Seq<T>, call: number): T {
  if (Array.isArray(seq)) return seq[Math.min(call, seq.length - 1)] as T;
  return seq as T;
}

interface RuntimeScript {
  statusOk?: Seq<boolean>;
  /** `null` means the runtime could not establish ownership (never "absent"). */
  browserRunning?: Seq<boolean | null>;
  snapshot?: SnapshotOutcome;
  stop?: StopOutcome;
  wake?: WakeOutcome | Error;
  snapshotAt?: Seq<number | null>;
  restoredSnapshotAt?: number | null;
  /** PID/starttime the runtime reports for the running browser. */
  pid?: Seq<number | null>;
  starttime?: Seq<number | null>;
  /** The runtime's own verdict that a restore is still owed. */
  restorePending?: Seq<boolean>;
  pendingBrowserPid?: number | null;
  pendingBrowserStarttime?: number | null;
  /** Snapshot schema the runtime holds (2 = storage-bearing). */
  snapshotSchema?: Seq<number | null>;
  /** True only when the held snapshot carries cookies/localStorage/IndexedDB. */
  snapshotHasStorage?: Seq<boolean>;
  /** Another process holds the cross-process transition lock. */
  transitionBusy?: Seq<boolean>;
  storageCounts?: Seq<{ cookies: number; origins: number; localStorageEntries: number; indexedDbDatabases: number } | null>;
}

function makeRuntime(script: RuntimeScript = {}) {
  const calls = { status: 0, snapshot: 0, stop: 0, wake: 0 };
  const stopOpts: { sourcePid?: number | null; sourceStarttime?: number | null }[] = [];
  const gates: {
    status?: Promise<void> | ((call: number) => Promise<void> | undefined);
    snapshot?: Promise<void>;
    stop?: Promise<void>;
  } = {};
  const runtime: BrowserRuntimeLike & { calls: typeof calls; gates: typeof gates; stopOpts: typeof stopOpts; script: RuntimeScript } = {
    calls,
    gates,
    stopOpts,
    script,
    async status(): Promise<RuntimeStatus> {
      const call = calls.status;
      calls.status += 1;
      if (typeof gates.status === "function") {
        const pending = gates.status(call);
        if (pending) await pending;
      } else if (gates.status) {
        await gates.status;
      }
      return {
        ok: at(script.statusOk ?? true, call),
        browserRunning: at(script.browserRunning === undefined ? true : script.browserRunning, call),
        browserAttribution:
          at(script.browserRunning === undefined ? true : script.browserRunning, call) === null
            ? ("unknown" as const)
            : ("owned" as const),
        supervisorRunning: true,
        pid: at(script.pid === undefined ? 294 : script.pid, call),
        starttime: at(script.starttime === undefined ? 1000 : script.starttime, call),
        snapshotAt: at(script.snapshotAt ?? null, call),
        restoredSnapshotAt: script.restoredSnapshotAt ?? null,
        restorePending: at(script.restorePending ?? false, call),
        pendingBrowserPid: script.pendingBrowserPid ?? null,
        pendingBrowserStarttime: script.pendingBrowserStarttime ?? null,
        // A storage-bearing snapshot by default: the core refuses to release on
        // anything less, so tests that expect a real stop must model one.
        snapshotSchema: at(script.snapshotSchema ?? 2, call),
        snapshotHasStorage: at(script.snapshotHasStorage ?? true, call),
        transitionBusy: at(script.transitionBusy ?? false, call),
        storageCounts: at(
          script.storageCounts ?? { cookies: 2, origins: 1, localStorageEntries: 3, indexedDbDatabases: 1 },
          call,
        ),
      };
    },
    async snapshot() {
      calls.snapshot += 1;
      if (gates.snapshot) await gates.snapshot;
      return (
        script.snapshot ?? {
          ok: true,
          savedAt: 1_700_000_000_123,
          tabs: 2,
          skipped: 0,
          warnings: [],
          storageCounts: { cookies: 2, origins: 1, localStorageEntries: 3, indexedDbDatabases: 1 },
        }
      );
    },
    async stop(opts) {
      calls.stop += 1;
      stopOpts.push({ sourcePid: opts?.sourcePid, sourceStarttime: opts?.sourceStarttime });
      if (gates.stop) await gates.stop;
      return script.stop ?? { ok: true };
    },
    async wake() {
      calls.wake += 1;
      if (script.wake instanceof Error) throw script.wake;
      return script.wake ?? { ok: true, restoredTabs: 2 };
    },
  };
  return runtime;
}

function makeLifecycle(runtime: BrowserRuntimeLike, opts: Partial<ConstructorParameters<typeof BrowserLifecycle>[0]> = {}) {
  const clock = new FakeClock();
  const events: string[] = [];
  const logs: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  const life = new BrowserLifecycle({
    runtime,
    clock,
    idleMs: 300_000,
    viewerTtlMs: 60_000,
    retryDelayMs: 10_000,
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    onEvent: (e) => events.push(e.type),
    log: {
      debug: (message, meta) => logs.push({ level: "debug", message, meta }),
      info: (message, meta) => logs.push({ level: "info", message, meta }),
      warn: (message, meta) => logs.push({ level: "warn", message, meta }),
      error: (message, meta) => logs.push({ level: "error", message, meta }),
    },
    ...opts,
  });
  return { life, clock, events, logs };
}

/** Yield to the microtask queue so in-flight async cycles can settle. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await tick();
};

/**
 * Drive a promise that waits on the injected clock: advancing the fake clock and
 * yielding between steps lets the retry loop make progress without a real timer.
 */
async function pumpClock<T>(
  promise: Promise<T>,
  clock: FakeClock,
  { stepMs = 100, maxMs = 60_000 }: { stepMs?: number; maxMs?: number } = {},
): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: unknown;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      failure = e;
    },
  );
  let advanced = 0;
  while (!settled && advanced < maxMs) {
    clock.advance(stepMs);
    advanced += stepMs;
    await tick();
  }
  if (failure !== undefined) throw failure;
  return value as T;
}

describe("BrowserLifecycle status", () => {
  it("starts idle with a deadline and never reports asleep before a stop", () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    const status = life.status();
    expect(status.state).toBe("idle");
    expect(status.epoch).toBe(0);
    expect(status.idleDeadline).toBe(clock.now() + 300_000);
    expect(status.browserRunning).toBeNull();
    expect(status.lastErrorCode).toBeNull();
    life.shutdown();
  });

  it("status polling does not wake the browser, extend the deadline or touch the runtime", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    const before = life.status().idleDeadline;
    clock.advance(120_000);
    for (let i = 0; i < 20; i += 1) life.status();
    expect(runtime.calls.status).toBe(0);
    expect(runtime.calls.wake).toBe(0);
    expect(life.status().idleDeadline).toBe(before);
    expect(life.status().state).toBe("idle");
    life.shutdown();
  });

  it("reports the storage-bearing schema and counts without leaking contents", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    const status = life.status();
    expect(status.snapshotSchema).toBe(2);
    expect(status.snapshotHasStorage).toBe(true);
    expect(status.storageCounts).toEqual({
      cookies: 2,
      origins: 1,
      localStorageEntries: 3,
      indexedDbDatabases: 1,
    });
    expect(status.transitionBusy).toBe(false);
    // Counts only: the payload carries numbers, never storage values or URLs.
    const json = JSON.stringify(status);
    expect(json).not.toMatch(/cookie=/i);
    expect(json).not.toContain("://");
    expect(json).not.toMatch(/\{[^}]*"value"/);
    life.shutdown();
  });

  it("counts every lease kind, including explicit holds", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    const call = life.reserve("call");
    const hold = life.reserve("hold");
    life.touchViewer("w1", "s1");
    life.pin("terminal-cdp", 60_000);
    const leases = life.status().leases;
    expect(leases).toEqual({ turns: 0, calls: 1, holds: 1, viewers: 1, pins: 1 });
    call.release();
    hold.release();
    life.shutdown();
  });

  it("reports enabled:false without scheduling anything when disabled", () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime, { enabled: false });
    expect(life.status().enabled).toBe(false);
    expect(life.status().idleDeadline).toBeNull();
    clock.advance(600_000);
    expect(runtime.calls.snapshot).toBe(0);
    life.shutdown();
  });
});

describe("BrowserLifecycle idle release", () => {
  it("snapshots then stops once the idle window elapses with no holders", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(299_999);
    await settle();
    expect(runtime.calls.snapshot).toBe(0);
    clock.advance(1);
    await settle();
    expect(runtime.calls.snapshot).toBe(1);
    expect(runtime.calls.stop).toBe(1);
    const status = life.status();
    expect(status.state).toBe("asleep");
    expect(status.epoch).toBe(1);
    expect(status.snapshotAt).toBe(1_700_000_000_123);
    life.shutdown();
  });

  it("keeps a held browser awake, then releases after the holder is gone", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    const lease = life.reserve("turn");
    expect(life.status().state).toBe("awake");
    expect(life.status().leases.turns).toBe(1);
    clock.advance(600_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    lease.release();
    expect(life.status().leases.turns).toBe(0);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    life.shutdown();
  });

  it("releases the browser after a viewer TTL expires with no further calls", async () => {
    const runtime = makeRuntime();
    const { life, clock, events } = makeLifecycle(runtime);
    life.touchViewer("w1", "s1");
    expect(life.status().leases.viewers).toBe(1);
    // Nothing else happens: the expiry timer alone must drive the transition.
    clock.advance(60_000);
    expect(events).toContain("viewer.expired");
    expect(life.status().leases.viewers).toBe(0);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.snapshot).toBe(1);
    expect(runtime.calls.stop).toBe(1);
    expect(life.status().state).toBe("asleep");
    life.shutdown();
  });

  it("fires the expiry at exactly the TTL boundary and never re-arms a 0ms timer", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    life.touchViewer("w1", "s1");
    const before = clock.fired;
    // Exactly one second short of the TTL: nothing may fire yet.
    clock.advance(59_999);
    expect(clock.fired).toBe(before);
    expect(life.status().leases.viewers).toBe(1);
    clock.advance(1);
    expect(clock.fired).toBe(before + 1);
    expect(life.status().leases.viewers).toBe(0);
    // A second full idle window, plus the boundary again, stays finite.
    life.touchViewer("w2", "s1");
    clock.advance(60_000);
    clock.advance(0);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    life.shutdown();
  });

  it("never spins the event loop when a viewer and a pin expire together", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    life.touchViewer("w1", "s1");
    life.pin("terminal-cdp", 60_000);
    const before = clock.fired;
    clock.advance(60_000);
    // Two expiry deadlines, without a storm of zero-delay re-arms.
    expect(clock.fired - before).toBeLessThan(5);
    expect(life.status().leases.viewers).toBe(0);
    expect(life.status().leases.pins).toBe(0);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    life.shutdown();
  });

  it("supports several independent viewers and drops only the released one", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    life.touchViewer("w1", "s1");
    life.touchViewer("w2", "s1");
    life.touchViewer("w3", "s2");
    expect(life.status().leases.viewers).toBe(3);
    life.releaseViewer("w2");
    expect(life.status().leases.viewers).toBe(2);
    expect(life.releaseViewersForSession("s1")).toBe(1);
    expect(life.status().leases.viewers).toBe(1);
    life.shutdown();
  });

  it("ignores a heartbeat that arrives after the lease was released", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    const lease = life.touchViewer("w1", "s1");
    expect(lease?.generation).toBe(0);
    life.releaseViewer("w1");
    // A heartbeat already in flight must not resurrect the cancelled lease.
    expect(life.touchViewer("w1", "s1", 0)).toBeNull();
    expect(life.status().leases.viewers).toBe(0);
    // A panel that remounts announces a new incarnation and is accepted.
    expect(life.touchViewer("w1", "s1", 1)).not.toBeNull();
    expect(life.status().leases.viewers).toBe(1);
    // A stale heartbeat from the previous incarnation is still refused.
    expect(life.touchViewer("w1", "s1", 0)).toBeNull();
    life.shutdown();
  });

  it("an expired pin no longer holds the browser", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    life.pin("terminal-cdp", 60_000);
    expect(life.status().leases.pins).toBe(1);
    clock.advance(60_000);
    await settle();
    expect(life.status().leases.pins).toBe(0);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    life.shutdown();
  });

  it("a permanent pin never releases the browser", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    const pin = life.pin("keep-alive");
    clock.advance(3_600_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    life.unpin(pin.id);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    life.shutdown();
  });
});

describe("BrowserLifecycle ready() and wake", () => {
  it("ready() is a no-op while awake and does not start a second wake", async () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    await life.ready();
    expect(runtime.calls.wake).toBe(0);
    expect(life.status().state).toBe("idle");
    life.shutdown();
  });

  it("wakes single-flight: concurrent ready() calls share one restore", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(life.status().state).toBe("asleep");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Replace the runtime wake entirely: a counting wrapper around the original
    // would double-count, since the original increments the same counter.
    runtime.wake = async () => {
      runtime.calls.wake += 1;
      await gate;
      return { ok: true, restoredTabs: 2 };
    };
    const a = life.ready();
    const b = life.ready();
    const c = life.ready();
    release();
    await Promise.all([a, b, c]);
    expect(runtime.calls.wake).toBe(1);
    expect(life.status().state).toBe("idle");
    expect(life.status().epoch).toBe(2);
    life.shutdown();
  });

  it("reports a failed wake, keeps the snapshot and succeeds on the next ready()", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    let fail = true;
    runtime.wake = async () => (fail ? { ok: false, message: "start failed" } : { ok: true, restoredTabs: 2 });
    await expect(life.ready()).rejects.toThrow("恢复浏览器失败");
    expect(life.status().state).toBe("error");
    expect(life.status().lastErrorCode).toBe("wake_failed");
    // Still asleep: the next caller retries instead of using a dead browser.
    fail = false;
    await life.ready();
    expect(life.status().lastErrorCode).toBeNull();
    expect(life.status().epoch).toBe(2);
    life.shutdown();
  });

  it("a lease taken during a stop waits for the restore before use", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    let releaseStop!: () => void;
    runtime.gates.stop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    clock.advance(300_000);
    await settle(); // snapshot already ran; stop is now blocked on the gate
    const lease = life.reserve("call");
    expect(life.status().state).toBe("snapshotting");
    const readyPromise = life.ready();
    releaseStop();
    await readyPromise;
    expect(runtime.calls.wake).toBe(1);
    expect(life.status().state).toBe("awake");
    lease.release();
    life.shutdown();
  });
});

describe("BrowserLifecycle race safety", () => {
  it("cancels the stop when a lease arrives during the snapshot", async () => {
    const runtime = makeRuntime();
    const { life, clock, events } = makeLifecycle(runtime);
    let releaseSnapshot!: () => void;
    runtime.gates.snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    clock.advance(300_000);
    await settle();
    expect(life.status().state).toBe("snapshotting");
    const lease = life.reserve("turn");
    releaseSnapshot();
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().state).toBe("awake");
    expect(events).toContain("sleep.cancelled");
    lease.release();
    life.shutdown();
  });

  it("reserve() is synchronous so two callers cannot both see an unheld browser", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    // Simulates two submits racing: both claim before either awaits.
    const first = life.reserve("turn");
    const second = life.reserve("turn");
    expect(life.status().leases.turns).toBe(2);
    await Promise.all([life.ready(), life.ready()]);
    expect(runtime.calls.wake).toBe(1);
    first.release();
    expect(life.status().leases.turns).toBe(1);
    second.release();
    expect(life.status().leases.turns).toBe(0);
    life.shutdown();
  });

  it("sleepNow refuses while any holder exists and cannot be bypassed", async () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    const lease = life.reserve("turn");
    const blocked = await life.sleepNow();
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.message).toBe("存在占用（任务/观看/保留），未释放浏览器");
    expect(runtime.calls.snapshot).toBe(0);
    expect(runtime.calls.stop).toBe(0);
    // There is no force path: occupancy always wins, so a caller cannot ask this
    // module to drop a browser a user or a task is using, however hard it tries.
    const forced = await (life.sleepNow as unknown as (opts: unknown) => Promise<{ verdict: string }>)({
      force: true,
      bypass: true,
    });
    expect(forced.verdict).toBe("blocked");
    expect(runtime.calls.snapshot).toBe(0);
    expect(runtime.calls.stop).toBe(0);
    lease.release();
    life.shutdown();
  });

  it("cancels a stop when a viewer appears during the snapshot too", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    let releaseSnapshot!: () => void;
    runtime.gates.snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    clock.advance(300_000);
    await settle();
    life.touchViewer("w1", "s1");
    releaseSnapshot();
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().state).toBe("awake");
    life.shutdown();
  });

  it.each(["dirty_input", "download_in_flight", "tab_identity_unverified"])("exposes a safe specific snapshot refusal: %s", async (reason) => {
    const runtime = makeRuntime({ snapshot: {
      ok: false, blocked: true, reason,
      message: "https://private.example/?token=secret",
      warnings: [{code: "tab_error", message: "private cookie secret", tabIndex: 0}],
    }});
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    const status = life.status();
    expect(status.lastErrorCode).toBe("snapshot_blocked");
    expect(status.lastError).not.toBe("页面状态无法安全保存，已放弃释放浏览器");
    expect(status.lastSnapshotWarnings[0]?.code).toBe(reason);
    expect(JSON.stringify(status)).not.toMatch(/private|secret/);
    expect(runtime.calls.stop).toBe(0);
    life.shutdown();
  });

  it("never stops when the snapshot fails and reports a secret-free code", async () => {
    const runtime = makeRuntime({
      snapshot: {
        ok: false,
        blocked: true,
        message: "无法连接浏览器 CDP：https://example.com/secret?token=abcdefghijklmnopqrstuvwxyz0123456789",
      },
    });
    const { life, clock, logs } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.snapshot).toBe(1);
    expect(runtime.calls.stop).toBe(0);
    const status = life.status();
    expect(status.state).toBe("error");
    expect(status.lastErrorCode).toBe("snapshot_blocked");
    // Nothing derived from the runtime message reaches the API surface.
    expect(status.lastError).toBe("页面状态无法安全保存，已放弃释放浏览器");
    expect(JSON.stringify(status)).not.toContain("example.com");
    expect(JSON.stringify(status)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    // The log keeps a redacted breadcrumb only.
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(logged).toContain("<url>");
    life.shutdown();
  });

  it("refuses to stop when the snapshot skipped pages even if it reported ok", async () => {
    const runtime = makeRuntime({
      snapshot: { ok: true, savedAt: 7, tabs: 1, skipped: 1, warnings: [] },
    });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().lastErrorCode).toBe("snapshot_incomplete");
    life.shutdown();
  });

  it("keeps the last usable snapshot when a later snapshot fails", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(life.status().snapshotAt).toBe(1_700_000_000_123);
    const lease = life.reserve("turn");
    await life.ready();
    runtime.snapshot = async () => ({ ok: false, blocked: true, message: "失败" });
    lease.release();
    clock.advance(300_000);
    await settle();
    expect(life.status().state).toBe("error");
    expect(life.status().snapshotAt).toBe(1_700_000_000_123);
    life.shutdown();
  });

  it("reports a stop failure without claiming the browser is asleep", async () => {
    const runtime = makeRuntime({ stop: { ok: false, message: "supervisor 未退出" } });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    const status = life.status();
    expect(status.state).toBe("error");
    expect(status.lastErrorCode).toBe("stop_failed");
    expect(status.epoch).toBe(0);
    // The re-probe confirmed the browser is still there, so it stays callable
    // and the idle countdown restarts rather than waking something that is up.
    expect(status.browserRunning).toBe(true);
    await life.ready();
    await settle();
    expect(life.status().state).toBe("idle");
    life.shutdown();
  });

  it("adopts a fail-closed asleep state when a failed stop cannot be confirmed", async () => {
    // Up when the stop is attempted, gone when the failure is re-probed: the
    // half-applied case that must stay fail-closed.
    const runtime = makeRuntime({ stop: { ok: false, message: "busy" }, browserRunning: [true, false] });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(life.status().state).toBe("error");
    expect(life.status().lastErrorCode).toBe("stop_failed");
    // Half-stopped: the next caller must restore instead of using the browser.
    await life.ready();
    expect(runtime.calls.wake).toBe(1);
    expect(life.status().lastErrorCode).toBeNull();
    life.shutdown();
  });

  it("schedules a bounded retry after a failed stop, then succeeds", async () => {
    const runtime = makeRuntime({ stop: { ok: false, message: "busy" } });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    runtime.stop = async () => {
      runtime.calls.stop += 1;
      return { ok: true };
    };
    clock.advance(10_000);
    await settle();
    expect(runtime.calls.stop).toBe(2);
    expect(life.status().state).toBe("asleep");
    life.shutdown();
  });

  it("stops retrying once a holder appears again", async () => {
    const runtime = makeRuntime({ stop: { ok: false, message: "busy" } });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    const lease = life.reserve("turn");
    clock.advance(600_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    lease.release();
    life.shutdown();
  });
});

describe("BrowserLifecycle storage gate", () => {
  it("refuses to stop when the runtime reports no storage capture", async () => {
    // A lossy snapshot (cookies/localStorage/IndexedDB missing) must never be
    // followed by a stop, even though the capture itself reported `ok`.
    const runtime = makeRuntime({ snapshotHasStorage: false, snapshotSchema: 1 });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().lastErrorCode).toBe("snapshot_storage_missing");
    // The browser is untouched and still usable-with-a-caveat, not mid-transition.
    expect(life.status().state).not.toBe("asleep");
    expect(life.status().state).not.toBe("snapshotting");
    life.shutdown();
  });

  it("treats a stop refusal from the helper as blocked, not as a failure", async () => {
    // The helper re-checks the snapshot right before signalling; its refusal must
    // leave the browser running and must not be reported as a stop error.
    const runtime = makeRuntime({ stop: { ok: false, message: "no storage", reason: "snapshot_storage_missing" } });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    expect(life.status().lastErrorCode).toBe("snapshot_storage_missing");
    expect(life.status().state).not.toBe("asleep");
    life.shutdown();
  });

  it("never reports a successful snapshot that dropped the storage capture", async () => {
    // The runtime claims `ok` but with no storage counts: the core refuses.
    const runtime = makeRuntime({
      snapshot: { ok: true, savedAt: 7, tabs: 2, skipped: 0, warnings: [], storageCounts: null },
    });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().lastErrorCode).toBe("snapshot_storage_missing");
    life.shutdown();
  });
});

describe("BrowserLifecycle reconcile barrier", () => {
  it("restores before the first use after a control-plane restart onto a sleeping browser", async () => {
    // The lifecycle is constructed trusting its optimistic `idle`; the container
    // actually has no browser. The first ready() must not hand out a dead state.
    const runtime = makeRuntime({ browserRunning: false });
    const { life } = makeLifecycle(runtime);
    await life.ready();
    expect(runtime.calls.status).toBeGreaterThanOrEqual(1);
    expect(runtime.calls.wake).toBe(1);
    // No holders → the idle countdown is re-armed for the freshly built browser.
    expect(life.status().state).not.toBe("asleep");
    expect(life.status().browserRunning).toBe(true);
    life.shutdown();
  });

  it("fails closed when the first probe cannot attribute the browser", async () => {
    const runtime = makeRuntime({ browserRunning: null, pid: null });
    const { life } = makeLifecycle(runtime);
    await expect(life.ready()).rejects.toThrow("无法确认浏览器真实状态");
    expect(runtime.calls.wake).toBe(0);
    expect(life.status().lastErrorCode).toBe("reconcile_failed");
    life.shutdown();
  });

  it("fails closed on a failed probe and does not start a second browser", async () => {
    const runtime = makeRuntime({ statusOk: false });
    const { life } = makeLifecycle(runtime);
    await expect(life.ready()).rejects.toThrow("无法确认浏览器真实状态");
    expect(runtime.calls.wake).toBe(0);
    life.shutdown();
  });

  it("coalesces concurrent first uses into one probe", async () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    await Promise.all([life.ready(), life.ready(), life.ready()]);
    expect(runtime.calls.status).toBe(1);
    expect(runtime.calls.wake).toBe(0);
    life.shutdown();
  });

  it("waits out a transition held by a previous control plane, then confirms", async () => {
    // The previous control plane is still stopping/restoring: the barrier must not
    // pass while the lock is held, and must confirm the identity once it clears.
    const runtime = makeRuntime({ transitionBusy: [true, false], browserRunning: [true, true] });
    const { life, clock } = makeLifecycle(runtime, { reconcileTimeoutMs: 10_000, reconcileRetryMs: 100 });
    await pumpClock(life.ready(), clock);
    expect(runtime.calls.status).toBe(2);
    expect(runtime.calls.wake).toBe(0);
    expect(life.status().transitionBusy).toBe(false);
    life.shutdown();
  });

  it("retries a reconcile that failed so a later ready() can succeed", async () => {
    const runtime = makeRuntime({ browserRunning: [null, true] });
    const { life } = makeLifecycle(runtime);
    await expect(life.ready()).rejects.toThrow("无法确认");
    await life.ready();
    expect(life.status().lastErrorCode).toBeNull();
    // Confirmed running with no holders → the idle countdown is re-armed.
    expect(life.status().state).toBe("idle");
    expect(life.status().browserRunning).toBe(true);
    life.shutdown();
  });

  it("status() never reconciles, wakes or extends the idle deadline", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    const deadline = life.status().idleDeadline;
    clock.advance(60_000);
    for (let i = 0; i < 10; i += 1) life.status();
    expect(runtime.calls.status).toBe(0);
    expect(runtime.calls.wake).toBe(0);
    expect(life.status().idleDeadline).toBe(deadline);
    life.shutdown();
  });

  it("keeps an owed restore blocked rather than adopting the running browser", async () => {
    // A stop that found a process we cannot vouch for records a pending restore.
    // A later probe that sees only "running" must not clear it.
    const runtime = makeRuntime({
      stop: { ok: false, message: "busy" },
      browserRunning: [true, true, true],
      pid: [294, 999, 999],
      starttime: [1000, 5, 5],
    });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(life.status().lastErrorCode).toBe("stop_failed");
    // The next use must restore, never adopt the unidentified process.
    await life.ready();
    expect(runtime.calls.wake).toBe(1);
    life.shutdown();
  });
});

describe("BrowserLifecycle reconciliation", () => {
  it("adopts an out-of-band stop without touching the runtime state machine", async () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    runtime.script.browserRunning = false;
    await life.observeRuntime();
    expect(life.status().state).toBe("asleep");
    expect(life.status().browserRunning).toBe(false);
    expect(life.status().epoch).toBe(1);
    life.shutdown();
  });

  it("adopts a browser running again after a control-plane restart", async () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    runtime.script.browserRunning = false;
    await life.observeRuntime();
    expect(life.status().state).toBe("asleep");
    // The runtime is the only authority on whether a restore is owed: it is up
    // *and* still reporting the un-applied snapshot.
    runtime.script.browserRunning = true;
    runtime.script.restorePending = true;
    runtime.script.pendingBrowserPid = 294;
    runtime.script.pendingBrowserStarttime = 1000;
    await life.observeRuntime();
    // The browser is up but its tabs have not been rebuilt from the snapshot, so
    // it is not handed out, and the idle countdown does not run either.
    expect(life.status().state).toBe("awake");
    expect(life.status().lastErrorCode).toBe("restore_pending");
    expect(life.status().idleDeadline).toBeNull();
    expect(life.status().epoch).toBe(2);
    life.shutdown();
  });

  it("discards a status probe that a sleep completed while it was in flight", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    let releaseProbe!: () => void;
    // Only the observe probe is held open; the sleep cycle's own attribution
    // probe and stop must be able to run to completion underneath it.
    runtime.gates.status = (call) =>
      call === 0
        ? new Promise<void>((resolve) => {
            releaseProbe = resolve;
          })
        : undefined;
    const probe = life.observeRuntime();
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(1);
    expect(life.status().epoch).toBe(1);
    // The probe describes a world that is already out of date.
    runtime.script.browserRunning = true;
    releaseProbe();
    expect(runtime.calls.status).toBe(2);
    await probe;
    expect(life.status().state).toBe("asleep");
    expect(life.status().browserRunning).toBe(false);
    expect(life.status().epoch).toBe(1);
    life.shutdown();
  });

  it("restores before use when a running browser still owes a pending snapshot", async () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    runtime.script.snapshotAt = 4_242;
    runtime.script.restoredSnapshotAt = null;
    runtime.script.browserRunning = true;
    runtime.script.restorePending = true;
    await life.observeRuntime();
    expect(life.status().lastErrorCode).toBe("restore_pending");
    // 1. The idle path must not snapshot over the tabs the user still needs.
    const blocked = await life.sleepNow();
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.message).toBe("存在尚未恢复到运行中浏览器的快照，暂不释放浏览器");
    expect(runtime.calls.snapshot).toBe(0);
    expect(runtime.calls.stop).toBe(0);
    // 2. The first real caller rebuilds the snapshot into the running browser.
    runtime.script.restoredSnapshotAt = 4_242;
    await life.ready();
    expect(runtime.calls.wake).toBe(1);
    expect(life.status().lastErrorCode).toBeNull();
    expect(life.status().idleDeadline).not.toBeNull();
    life.shutdown();
  });

  it("keeps a pending restore from ever starting an idle countdown", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    runtime.script.browserRunning = true;
    runtime.script.snapshotAt = 4_242;
    runtime.script.restoredSnapshotAt = null;
    runtime.script.restorePending = true;
    await life.observeRuntime();
    expect(life.status().lastErrorCode).toBe("restore_pending");
    // A viewer joins and leaves; neither the join nor the release may start a
    // countdown over a browser whose tabs have not been rebuilt yet.
    life.touchViewer("w1", "s1");
    life.releaseViewer("w1");
    expect(life.status().idleDeadline).toBeNull();
    // The retry path is blocked too, so nothing can stop it behind the user's back.
    runtime.script.snapshot = { ok: true, savedAt: 9, tabs: 2, skipped: 0 };
    clock.advance(600_000);
    await settle();
    expect(runtime.calls.snapshot).toBe(0);
    expect(runtime.calls.stop).toBe(0);
    life.shutdown();
  });

  it("reports an unknown browser state when the probe fails", async () => {
    const runtime = makeRuntime({ statusOk: false });
    const { life } = makeLifecycle(runtime);
    await life.observeRuntime();
    expect(life.status().browserRunning).toBeNull();
    expect(life.status().state).toBe("idle");
    life.shutdown();
  });

  it("observe() never wakes the browser and never releases it", async () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    await life.observeRuntime();
    expect(runtime.calls.wake).toBe(0);
    expect(runtime.calls.stop).toBe(0);
    life.shutdown();
  });

  it("does not reconcile underneath an in-flight sleep", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    let releaseSnapshot!: () => void;
    runtime.gates.snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    clock.advance(300_000);
    await settle();
    runtime.script.browserRunning = false;
    await life.observeRuntime();
    // The cycle owns the state until it settles; no double transition happened.
    expect(life.status().epoch).toBe(0);
    releaseSnapshot();
    await settle();
    expect(life.status().state).toBe("asleep");
    expect(life.status().epoch).toBe(1);
    life.shutdown();
  });
});

describe("BrowserLifecycle shutdown", () => {
  it("clears timers and refuses further operations", () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    life.touchViewer("w1", "s1");
    // Only the viewer expiry timer: joining a viewer cancels the idle countdown.
    expect(clock.pendingTimers).toBe(1);
    life.shutdown();
    expect(clock.pendingTimers).toBe(0);
    expect(() => life.reserve("turn")).toThrow();
    expect(() => life.pin("x")).toThrow();
    // A viewer was holding the browser, so the last state stays "awake"; the
    // point is that nothing is scheduled any more.
    expect(life.status().state).toBe("awake");
    expect(life.status().idleDeadline).toBeNull();
  });

  it("shutdown during a snapshot does not stop the browser", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    let releaseSnapshot!: () => void;
    runtime.gates.snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    clock.advance(300_000);
    await settle();
    life.shutdown();
    releaseSnapshot();
    await settle();
    expect(runtime.calls.stop).toBe(0);
  });

  it("shutdown is idempotent", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    life.shutdown();
    life.shutdown();
    expect(life.status().state).toBe("idle");
  });
});

describe("BrowserLifecycle lease bookkeeping", () => {
  it("release() is idempotent and unknown ids are ignored", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    const lease = life.reserve("call");
    lease.release();
    lease.release();
    life.release("does-not-exist");
    expect(life.status().leases.calls).toBe(0);
    life.shutdown();
  });

  it("never infers a pending restore from a snapshot file alone", async () => {
    // A brand-new control plane that can see a snapshot on disk but whose runtime
    // says no restore is owed must treat the running browser as a normal one. A
    // snapshot existing is not evidence that the browser was ever released.
    const runtime = makeRuntime({ snapshotAt: 4_242, restoredSnapshotAt: null, browserRunning: true });
    const { life } = makeLifecycle(runtime);
    await life.observeRuntime();
    expect(life.status().lastErrorCode).toBeNull();
    expect(life.status().state).not.toBe("restoring");
    // The snapshot age is adopted for display only.
    expect(life.status().snapshotAt).toBe(4_242);
    await life.ready();
    expect(runtime.calls.wake).toBe(0);
    life.shutdown();
  });

  it("keeps a browser running when a cancel after the snapshot leaves it alive", async () => {
    // The exact false positive from review item 1: the snapshot is saved, a lease
    // arrives, the stop is cancelled, and the browser is still the original
    // process. Status must not claim a restore is owed, and the next caller must
    // not rebuild tabs over live ones.
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    let releaseSnapshot!: () => void;
    runtime.gates.snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    clock.advance(300_000);
    await settle();
    const lease = life.reserve("turn");
    releaseSnapshot();
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().snapshotAt).toBe(1_700_000_000_123);
    expect(life.status().lastErrorCode).toBeNull();
    // Still running: nothing may be restored over it.
    await life.ready();
    expect(runtime.calls.wake).toBe(0);
    lease.release();
    life.shutdown();
  });

  it("does not resurrect a pending restore across a control-plane restart simulation", async () => {
    const runtime = makeRuntime({ browserRunning: true, snapshotAt: 4_242, restorePending: false });
    const { life } = makeLifecycle(runtime);
    await life.observeRuntime();
    await life.observeRuntime();
    expect(runtime.calls.wake).toBe(0);
    expect(life.status().lastErrorCode).toBeNull();
    life.shutdown();
  });

  it("never treats an unknown attribution as a missing browser", async () => {
    // The runtime cannot prove what the process is (verified real case: Chromium
    // flattened its cmdline). That is not "no browser": ready() must not start a
    // second one, and the stop must never be attempted.
    const runtime = makeRuntime({ browserRunning: null, pid: null });
    const { life, clock } = makeLifecycle(runtime);
    await life.observeRuntime();
    expect(life.status().browserRunning).toBeNull();
    // The status stays truthful and the idle countdown is not treated as "gone".
    expect(life.status().state).not.toBe("asleep");
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(runtime.calls.wake).toBe(0);
    expect(life.status().lastErrorCode).toBe("stop_unattributed");
    life.shutdown();
  });

  it("refuses to stop a browser it cannot attribute to a PID", async () => {
    const runtime = makeRuntime({ pid: null });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().lastErrorCode).toBe("stop_unattributed");
    // The browser is still up, so it must not look mid-transition or asleep.
    expect(life.status().state).not.toBe("snapshotting");
    expect(life.status().state).not.toBe("asleep");
    life.shutdown();
  });

  it("blocks the stop when the runtime still owes a restore", async () => {
    const runtime = makeRuntime({ browserRunning: true, restorePending: true });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().lastErrorCode).toBe("restore_pending");
    life.shutdown();
  });

  it("hands the verified source identity to the runtime stop call", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    expect(runtime.stopOpts).toEqual([{ sourcePid: 294, sourceStarttime: 1000 }]);
    life.shutdown();
  });

  it("rejects a replacement browser that reused the PID with a different starttime", async () => {
    // A recycled PID must never be adopted as "the browser I was going to stop".
    const runtime = makeRuntime({
      stop: { ok: false, message: "busy" },
      browserRunning: [true, true],
      pid: [294, 294],
      starttime: [1000, 2000],
    });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    const status = life.status();
    expect(status.lastErrorCode).toBe("stop_failed");
    // Not the same process: fail closed and restore before the next use.
    await life.ready();
    expect(runtime.calls.wake).toBe(1);
    life.shutdown();
  });

  it("accepts the same process when a failed stop is re-probed" , async () => {
    const runtime = makeRuntime({ stop: { ok: false, message: "busy" }, browserRunning: [true, true] });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    const status = life.status();
    expect(status.lastErrorCode).toBe("stop_failed");
    expect(status.browserRunning).toBe(true);
    await life.ready();
    expect(runtime.calls.wake).toBe(0);
    life.shutdown();
  });

  it("adopts an already-stopped browser instead of signalling it again", async () => {
    // The idle cycle wakes up to find the browser already gone: no signal is sent.
    const runtime = makeRuntime({ browserRunning: [true, false] });
    const { life, clock } = makeLifecycle(runtime);
    await life.observeRuntime();
    clock.advance(300_000);
    await settle();
    expect(runtime.calls.stop).toBe(0);
    expect(life.status().state).toBe("asleep");
    expect(life.status().lastErrorCode).toBeNull();
    life.shutdown();
  });

  it("throws a secret-free error when the runtime rejects with a raw Error", async () => {
    const leak = new Error("failed on https://bank.example.com/account?token=abc123");
    const runtime = makeRuntime({ browserRunning: false, wake: leak });
    const { life } = makeLifecycle(runtime);
    await life.observeRuntime();
    await expect(life.ready()).rejects.toThrow("恢复浏览器失败，快照仍然保留");
    await expect(life.ready()).rejects.not.toThrow("bank.example.com");
    const status = life.status();
    expect(status.lastError).toBe("恢复浏览器失败，快照仍然保留");
    expect(JSON.stringify(status)).not.toContain("bank.example.com");
    expect(JSON.stringify(status)).not.toContain("abc123");
    // The snapshot is kept: the next caller retries the restore.
    expect(life.status().lastErrorCode).toBe("wake_failed");
    life.shutdown();
  });

  it("throws a secret-free error when the runtime rejects during a sleep cycle", async () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    runtime.script.stop = undefined;
    runtime.gates.stop = undefined;
    // Force the stop path itself to reject.
    runtime.stop = async () => {
      throw new Error("cdp went away at https://secret.example.com/x?cookie=zzz");
    };
    clock.advance(300_000);
    await settle();
    const status = life.status();
    expect(status.state).toBe("error");
    expect(status.lastErrorCode).toBe("runtime_error");
    expect(JSON.stringify(status)).not.toContain("secret.example.com");
    expect(JSON.stringify(status)).not.toContain("zzz");
    life.shutdown();
  });

  it("exposes snapshot warnings without leaking tab contents", async () => {
    const warning: SnapshotWarning = { code: "unsupported_scheme", message: "chrome:// 无法恢复", tabIndex: 1 };
    const runtime = makeRuntime({
      snapshot: {
        ok: true,
        savedAt: 5,
        tabs: 1,
        skipped: 0,
        warnings: [warning],
        storageCounts: { cookies: 1, origins: 1, localStorageEntries: 0, indexedDbDatabases: 0 },
      },
    });
    const { life, clock } = makeLifecycle(runtime);
    clock.advance(300_000);
    await settle();
    const status = life.status();
    expect(status.lastSnapshotWarnings).toEqual([warning]);
    expect(status.unrestoredTabCount).toBe(0);
    expect(status.state).toBe("asleep");
    life.shutdown();
  });

  it("expires a viewer exactly at unseenAt+ttl without spinning the timer", () => {
    // Regression: the expiry timer fires at exactly `seenAt + ttl`, so the prune
    // comparison must be `>=`. A strict `>` left the lease alive, re-armed a 0ms
    // timer and burned a core in an infinite loop.
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    life.touchViewer("w1", "s1");
    expect(life.status().leases.viewers).toBe(1);
    clock.advance(60_000);
    // Firing at the boundary must expire the lease, schedule the idle countdown
    // and leave no timer behind that could re-fire at once.
    expect(life.status().leases.viewers).toBe(0);
    expect(life.status().state).toBe("idle");
    expect(clock.pendingTimers).toBe(1);
    life.shutdown();
  });

  it("does not spin when a pin expires exactly at its deadline", () => {
    const runtime = makeRuntime();
    const { life, clock } = makeLifecycle(runtime);
    life.pin("cdp", 30_000);
    expect(life.status().leases.pins).toBe(1);
    clock.advance(30_000);
    expect(life.status().leases.pins).toBe(0);
    life.shutdown();
  });
});

describe("BrowserLifecycle identified pins", () => {
  it("reuses the same pin for a repeated identified add", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    const first = life.pinIdentified("UI 手动保留浏览器");
    const second = life.pinIdentified("UI 手动保留浏览器");
    // A reload or a second window must not stack a second permanent pin.
    expect(second.id).toBe(first.id);
    expect(life.pins().length).toBe(1);
    life.shutdown();
  });

  it("releases only the identified pin, never a differently-noted one", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    const scriptPin = life.pin("cdp 自动化", 600_000);
    life.pinIdentified("UI 手动保留浏览器");
    const removed = life.unpinNote("UI 手动保留浏览器");
    expect(removed).toBe(1);
    const left = life.pins();
    expect(left.map((p) => p.id)).toEqual([scriptPin.id]);
    life.shutdown();
  });

  it("can be released after a reload re-derives it from the status payload", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    life.pinIdentified("UI 手动保留浏览器");
    // A fresh component only sees status().pins; it filters by the fixed note.
    const seen = life.status().pins.filter((p) => p.note === "UI 手动保留浏览器");
    expect(seen.length).toBe(1);
    expect(life.unpinNote("UI 手动保留浏览器")).toBe(1);
    expect(life.status().pins.length).toBe(0);
    life.shutdown();
  });

  it("re-adding an already-released identified pin creates it again", () => {
    const runtime = makeRuntime();
    const { life } = makeLifecycle(runtime);
    life.pinIdentified("UI 手动保留浏览器");
    life.unpinNote("UI 手动保留浏览器");
    const again = life.pinIdentified("UI 手动保留浏览器");
    expect(life.pins().map((p) => p.id)).toEqual([again.id]);
    life.shutdown();
  });
});

it('isolates identical viewer ids by session and tombstones releases before first touch', () => {
  const {life}=makeLifecycle(makeRuntime());
  life.releaseViewer('window', 1, 'a');
  expect(life.touchViewer('window','a',1)).toBeNull();
  expect(life.touchViewer('window','b',1)).not.toBeNull();
  life.releaseViewer('window',2,'a');
  expect(life.status().leases.viewers).toBe(1);
  expect(life.touchViewer('window','a',3)).not.toBeNull();
  life.releaseViewer('window',1,'a');
  expect(life.status().leases.viewers).toBe(2);
  life.shutdown();
});
it('does not reuse an initial success after an unknown ownership observation', async () => {
  const runtime=makeRuntime({browserRunning:[true,null,null]});
  const {life}=makeLifecycle(runtime);
  await life.ready();
  await life.observeRuntime();
  await expect(life.ready()).rejects.toThrow();
  life.shutdown();
});
