/**
 * Viewer-lease client for the sandbox browser panel.
 *
 * The control plane only keeps Chromium awake while someone is actually looking
 * at it, so this controller answers one question per visible panel: "is a real
 * human watching the browser right now?" A lease is claimed only while the panel
 * is shown AND the document is visible; hiding, closing, switching tabs or a
 * backgrounded window releases it immediately instead of waiting for the TTL.
 *
 * Two properties matter and are unit-tested:
 *  - a late heartbeat can never resurrect a released lease (the generation is
 *    bumped on release, so the server rejects the stale incarnation and the
 *    client ignores its reply), and
 *  - multiple windows are independent (each controller owns its own id and
 *    generation), so closing one window never disturbs another.
 */

export type HeartbeatResult =
  | { kind: "ok"; generation: number }
  | { kind: "stale" }
  | { kind: "error"; message?: string };

export interface ViewerTransport {
  /** One heartbeat for `id` at `generation`; the server replies with its own. */
  heartbeat(id: string, generation: number): Promise<HeartbeatResult>;
  /**
   * Best-effort explicit release. The generation travels with the id so the
   * server can ignore a release from an already-superseded incarnation: a reply
   * that was delayed across a remount must never drop the *new* panel's lease.
   * A failure means the TTL will expire the lease on its own.
   */
  release(id: string, generation: number): Promise<void>;
}

export interface BrowserViewerOptions {
  id?: string;
  transport: ViewerTransport;
  /** Heartbeat cadence while the lease is held; must be well under the server TTL. */
  heartbeatMs?: number;
  /** Injected so tests can drive visibility without a DOM. */
  visibilityState?: () => "visible" | "hidden";
  onError?: (message: string) => void;
  /** Called whenever the lease is gained or lost, so the panel never claims to be watching without one. */
  onHeldChange?: (held: boolean) => void;
}

const DEFAULT_HEARTBEAT_MS = 20_000;

/** Safe id for one panel instance; unique per window without a server round trip. */
function defaultId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `v_${Date.now().toString(36)}_${rand}`;
}

export class BrowserViewerController {
  readonly id: string;
  #transport: ViewerTransport;
  #heartbeatMs: number;
  #visibility: () => "visible" | "hidden";
  #onError: ((message: string) => void) | undefined;
  #onHeldChange: ((held: boolean) => void) | undefined;

  /**
   * Incarnation counter. Bumped when the panel joins, when it releases, and on a
   * stale-heartbeat rejection - but *not* on a routine heartbeat. A heartbeat
   * extends the incarnation it already holds, so a slow restore that spans more
   * than one heartbeat interval cannot invalidate the generation the panel is
   * waiting on.
   */
  #generation = 0;
  #held = false;
  /** The last heartbeat failed; retries stay quiet until one succeeds again. */
  #failing = false;
  /** A heartbeat was attempted since the last release, even if its reply is late. */
  #mayHaveLease = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(opts: BrowserViewerOptions) {
    this.id = opts.id ?? defaultId();
    this.#transport = opts.transport;
    this.#heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#visibility = opts.visibilityState ?? (() => (typeof document === "undefined" ? "visible" : document.visibilityState));
    this.#onError = opts.onError;
    this.#onHeldChange = opts.onHeldChange;
  }

  get generation(): number {
    return this.#generation;
  }

  get held(): boolean {
    return this.#held;
  }

  /**
   * Claim (or refresh) the lease. Only call this while the panel is genuinely on
   * screen; the visibility check is repeated here so a queued claim that lands
   * after the user looked away does nothing.
   */
  async claim(): Promise<number> {
    if (this.#disposed || this.#visibility() !== "visible") return 0;
    if (this.#held) {
      // Routine heartbeat: extend the *same* incarnation. The generation is not
      // bumped, so a caller waiting on it (e.g. across a slow restore) is not
      // invalidated by a heartbeat that merely kept the lease alive.
      const generation = this.#generation;
      const result = await this.#send(generation);
      if (this.#disposed || !this.#held || generation !== this.#generation) return 0;
      return this.#handleHeartbeat(result, generation);
    }
    // First join for this incarnation: mint a new generation.
    const generation = this.#generation + 1;
    this.#generation = generation;
    const result = await this.#send(generation);
    // A release (or a newer join) landed while this heartbeat was in flight: its
    // reply describes an incarnation that is no longer current.
    if (this.#disposed || generation !== this.#generation) {
      return this.#held ? this.#generation : 0;
    }
    return this.#handleHeartbeat(result, generation, true);
  }

  /**
   * Apply a heartbeat reply to `generation`. `mayRetryStale` allows exactly one
   * follow-up attempt after the server reports a tombstone at a higher
   * generation - never a loop.
   */
  async #handleHeartbeat(result: HeartbeatResult, generation: number, mayRetryStale = false): Promise<number> {
    if (result.kind === "ok") {
      this.#failing = false;
      this.#setHeld(true);
      this.#armTimer();
      return this.#generation;
    }
    if (result.kind === "stale") {
      // Another incarnation reused this id (a crashed window was replaced). Move
      // past the tombstone once, then give up honestly.
      this.#setHeld(false);
      if (!mayRetryStale) {
        this.#onError?.("无法保护浏览器占用状态，请重新打开面板");
        return 0;
      }
      const retryGeneration = generation + 1;
      this.#generation = retryGeneration;
      const retried = await this.#send(retryGeneration);
      if (this.#disposed || retryGeneration !== this.#generation) {
        return this.#held ? this.#generation : 0;
      }
      if (retried.kind === "ok") {
        this.#failing = false;
        this.#setHeld(true);
        this.#armTimer();
        return this.#generation;
      }
      this.#setHeld(false);
      this.#onError?.("无法保护浏览器占用状态，请重新打开面板");
      return 0;
    }
    // A failed heartbeat (control restart, network blip, a 503 while waking) must
    // not drop the lease for good: keep the timer running so the next tick joins
    // again, and say so once instead of on every retry.
    this.#setHeld(false);
    if (!this.#failing) this.#onError?.(result.message ?? "无法连接控制面，浏览器可能被释放");
    this.#failing = true;
    if (this.#timer === null) this.#armTimer();
    return 0;
  }

  /**
   * Drop the lease now. The generation is bumped immediately (before the network
   * call) so any heartbeat still in flight is already stale when it lands.
   */
  async release(): Promise<void> {
    this.#cancelTimer();
    // The incarnation being given up. The generation is sent with the release so
    // the server can ignore a late release that belongs to an older incarnation
    // than the one it is currently tracking; bumping it locally supersedes this
    // incarnation for any heartbeat still travelling.
    const releasedGeneration = this.#generation;
    this.#generation += 1;
    this.#setHeld(false);
    this.#failing = false;
    // The release is always sent, even when no heartbeat has completed yet: the
    // server may already have recorded this incarnation (the first heartbeat can
    // still be in flight when the panel is hidden again), and skipping it would
    // leave the browser awake until the TTL lapses.
    if (!this.#mayHaveLease) return;
    this.#mayHaveLease = false;
    try {
      await this.#transport.release(this.id, releasedGeneration);
    } catch {
      // The server expires the lease by TTL anyway; never surface this as an error
      // the user must act on.
    }
  }

  /**
   * True when `generation` is still the incarnation this controller holds. A
   * routine heartbeat never changes the generation, so a panel waiting on a slow
   * restore stays current as long as the lease is still held.
   */
  isCurrent(generation: number): boolean {
    return this.#held && !this.#disposed && generation === this.#generation;
  }

  /** Release and stop every timer; safe to call from an unmount path. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.release();
  }

  #armTimer(): void {
    this.#cancelTimer();
    if (this.#heartbeatMs <= 0) return;
    this.#timer = setInterval(() => {
      // Never keep heartbeating for a panel that is no longer on screen.
      if (this.#disposed) return;
      if (this.#visibility() !== "visible") {
        void this.release();
        return;
      }
      // Held: extend the lease. Lost after a failed heartbeat: join again as a new
      // incarnation, so one blip never leaves a watched browser unprotected.
      void this.claim();
    }, this.#heartbeatMs);
  }

  #setHeld(held: boolean): void {
    if (this.#held === held) return;
    this.#held = held;
    this.#onHeldChange?.(held);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async #send(generation: number): Promise<HeartbeatResult> {
    this.#mayHaveLease = true;
    try {
      return await this.#transport.heartbeat(this.id, generation);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
