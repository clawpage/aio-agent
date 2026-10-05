import type { AppContext } from "../context.js";

/** Task states that mean the sandbox is about to be used (planning runs on the sandbox Codex). */
const ACTIVE_TASKS = "'planning','queued','running','steering','stopping','merging'";
/** Shell commands still running: `no_change_timeout` returned early but did not stop the command. */
const RUNNING_SHELL = new Set(["running", "no_change_timeout"]);

export type SandboxIdleState = "running" | "parking" | "parked" | "waking";

export interface SandboxIdleOptions {
  ctx: AppContext;
  /** How long both signals must stay quiet before the container is stopped. */
  idleMs: number;
  /** Brings the container and the Codex session back (startSandboxRuntime). */
  start: (ctx: AppContext) => Promise<void>;
  /** A console heartbeat counts for this long (it is sent every 20 s while visible). */
  foregroundTtlMs?: number;
  /** Container CPU above this is work nobody told us about (a build, a kernel). */
  cpuBusyPercent?: number;
  intervalMs?: number;
  /** The container was found stopped when the runtime was created: it stays stopped until the first use. */
  parked?: boolean;
  now?: () => number;
}

/**
 * Stops a whole sandbox container nobody is using, and starts it again on the
 * next use.
 *
 * In use means either signal: the sandbox is doing something (a turn, a planning
 * task, a browser lease, a proxied workspace request, a pending approval, a
 * running shell command, CPU) or the account has its console in the foreground.
 * Only after both have been quiet for `idleMs` is the browser snapshotted (so its
 * logins survive) and the container stopped. While parked, the recovery loop
 * leaves it alone; `wake()` is the only way back, and every path that needs the
 * container awaits it.
 */
export class SandboxIdle {
  readonly #ctx: AppContext;
  readonly #idleMs: number;
  readonly #start: (ctx: AppContext) => Promise<void>;
  readonly #foregroundTtlMs: number;
  readonly #cpuBusyPercent: number;
  readonly #now: () => number;
  #state: SandboxIdleState = "running";
  #connections = 0;
  #lastActive: number;
  #foregroundAt = 0;
  #parking: Promise<void> | null = null;
  #waking: Promise<void> | null = null;
  #ticking = false;
  /** Last reason the sandbox counted as in use, logged once per change. */
  #reason: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SandboxIdleOptions) {
    this.#ctx = opts.ctx;
    this.#idleMs = opts.idleMs;
    this.#start = opts.start;
    this.#foregroundTtlMs = opts.foregroundTtlMs ?? 60_000;
    this.#cpuBusyPercent = opts.cpuBusyPercent ?? 5;
    this.#now = opts.now ?? Date.now;
    this.#lastActive = this.#now();
    if (opts.parked) {
      this.#state = "parked";
      // Nothing can be probed or released in a stopped container: the browser's timers stay off.
      if (this.#ctx.cfg.browser.enabled) this.#ctx.browser.containerStopped();
    }
    if (opts.intervalMs) {
      this.#timer = setInterval(() => void this.tick(), opts.intervalMs);
      this.#timer.unref?.();
    }
  }

  get state(): SandboxIdleState {
    return this.#state;
  }

  /** True while the container is (being) stopped or started here: the recovery loop must stay out. */
  get managing(): boolean {
    return this.#state !== "running";
  }

  /** A proxied workspace request or socket: in use for its whole lifetime. */
  hold(): () => void {
    this.#connections += 1;
    this.#lastActive = this.#now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#connections -= 1;
      this.#lastActive = this.#now();
    };
  }

  /** Someone typed into a proxied workspace socket. */
  touch(): void {
    this.#lastActive = this.#now();
  }

  /**
   * Admit a workspace request. A stopped container is started only for a request
   * that may (`wakes`): a hidden tab's reconnecting editor socket or poll is
   * refused instead, or it would wake the container right after every stop.
   */
  async enter(wakes: boolean): Promise<boolean> {
    if ((this.#state === "parked" || this.#state === "parking") && !wakes) return false;
    await this.wake();
    return true;
  }

  /** The account's console is visible on a screen; a parked sandbox starts warming up. */
  foreground(): void {
    this.#foregroundAt = this.#lastActive = this.#now();
    if (this.#state === "parked" || this.#state === "parking") {
      void this.wake().catch((err) => this.#ctx.log.warn("sandbox wake failed", { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Make sure the container is up before using it; immediate while it is running. */
  async wake(): Promise<void> {
    this.#lastActive = this.#now();
    if (this.#state === "running") return;
    if (this.#waking) return this.#waking;
    this.#waking = (async () => {
      // A stop in progress finishes first (or aborts on this very activity). The
      // yield lets a stop that started in this same tick register its promise.
      await Promise.resolve();
      if (this.#parking) await this.#parking.catch(() => undefined);
      if (this.#state === "running") return;
      this.#state = "waking";
      this.#ctx.log.info("sandbox waking from idle");
      try {
        await this.#start(this.#ctx);
      } finally {
        // Running again either way: a failed start is the recovery loop's to retry.
        this.#state = "running";
        this.#lastActive = this.#now();
        // The browser reconciles with what the container holds before any release.
        if (this.#ctx.cfg.browser.enabled) this.#ctx.browser.containerStarted();
      }
      if (this.#ctx.sandboxSetupError) throw new Error("沙箱启动失败，请稍后重试");
    })().finally(() => {
      this.#waking = null;
    });
    return this.#waking;
  }

  /** Why the sandbox counts as in use right now, or null. Cheap: no container calls. */
  async busyReason(): Promise<string | null> {
    const ctx = this.#ctx;
    if (this.#connections > 0) return "connections";
    if (this.#now() - this.#foregroundAt < this.#foregroundTtlMs) return "foreground";
    const agent = await ctx.agent.status();
    if (agent.activeTurns.length > 0 || agent.queuedTurns > 0) return "turns";
    if (ctx.agent.listPendingRequests().length > 0) return "approvals";
    if (ctx.db.prepare(`SELECT 1 FROM tasks WHERE status IN (${ACTIVE_TASKS}) LIMIT 1`).get()) return "tasks";
    if (ctx.cfg.browser.enabled) {
      const leases = ctx.browser.leases();
      if (leases.turns + leases.viewers + leases.calls + leases.holds + leases.pins > 0) return "browser";
    }
    return null;
  }

  /** Work inside the container the control plane did not start: running shell commands, CPU (browser excluded). */
  async probe(): Promise<string | null> {
    const result = (await this.#ctx.aio.get("/v1/shell/sessions")) as { data?: { sessions?: Record<string, { status?: unknown }> } };
    const sessions = Object.values(result?.data?.sessions ?? {});
    if (sessions.some((s) => typeof s?.status === "string" && RUNNING_SHELL.has(s.status))) return "shell";
    const cpu = await this.#ctx.container.cpuPercent();
    if (cpu === null || cpu >= this.#cpuBusyPercent) return "cpu";
    return null;
  }

  /** One decision pass; runs every `intervalMs`, never overlapping. */
  async tick(): Promise<void> {
    if (this.#ticking || this.#state !== "running") return;
    this.#ticking = true;
    try {
      const busy = await this.busyReason();
      this.#note(busy);
      if (busy) {
        this.#lastActive = this.#now();
        return;
      }
      if (this.#now() - this.#lastActive < this.#idleMs) return;
      const state = await this.#ctx.container.inspect();
      if (!state.running) return;
      // A probe that fails says nothing about idleness: keep the container.
      const inside = await this.probe().catch(() => "probe_failed");
      this.#note(inside);
      if (inside) {
        this.#lastActive = this.#now();
        return;
      }
      this.#parking = this.#park().finally(() => {
        this.#parking = null;
      });
      await this.#parking;
    } catch (err) {
      this.#ctx.log.warn("sandbox idle pass failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.#ticking = false;
    }
  }

  #note(reason: string | null): void {
    if (reason === this.#reason) return;
    this.#reason = reason;
    this.#ctx.log.info(reason ? "sandbox in use" : "sandbox quiet", reason ? { reason } : {});
  }

  async #park(): Promise<void> {
    const ctx = this.#ctx;
    const startedAt = this.#now();
    this.#state = "parking";
    // Any activity since the decision (a request, a heartbeat, a wake) cancels the stop.
    const interrupted = async () => this.#lastActive >= startedAt || (await this.busyReason()) !== null;
    try {
      if (ctx.cfg.browser.enabled) {
        // The snapshot is what brings the logins back on the next start.
        const slept = await ctx.browser.sleepNow();
        const seen = ctx.browser.status();
        // A snapshot still waiting to be restored is the real state: the running
        // browser was never used since (any use restores first), so stopping it
        // loses nothing and the snapshot comes back on the next use.
        if (slept.verdict !== "asleep" && seen.state !== "asleep" && !seen.restorePending) {
          // The message is one of the lifecycle's fixed, secret-free sentences.
          ctx.log.info("sandbox idle stop skipped: browser not released", { verdict: slept.verdict, message: slept.message });
          this.#state = "running";
          this.#lastActive = this.#now();
          return;
        }
      }
      if (await interrupted()) {
        this.#state = "running";
        return;
      }
      await ctx.container.stop();
      const after = await ctx.container.inspect();
      if (after.running) throw new Error("container still running after stop");
      ctx.sandboxSurfaces = null;
      this.#state = "parked";
      if (ctx.cfg.browser.enabled) ctx.browser.containerStopped();
      ctx.log.info("sandbox stopped after idle", { idleSeconds: Math.round((this.#now() - this.#lastActive) / 1000) });
    } catch (err) {
      this.#state = "running";
      this.#lastActive = this.#now();
      throw err;
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
