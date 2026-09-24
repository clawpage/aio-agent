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
  /** One heartbeat for `id` at `generation`. */
  heartbeat(id: string, generation: number): Promise<HeartbeatResult>;
  /** Best-effort explicit release; a failure means the TTL will expire it. */
  release(id: string): Promise<void>;
}

export interface BrowserViewerOptions {
  id?: string;
  transport: ViewerTransport;
  /** Heartbeat cadence while the lease is held; must be well under the server TTL. */
  heartbeatMs?: number;
  /** Injected so tests can drive visibility without a DOM. */
  visibilityState?: () => "visible" | "hidden";
  onError?: (message: string) => void;
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

  /**
   * Incarnation counter. Bumped on every release *and* on a stale-heartbeat
   * rejection, so a heartbeat that was already in flight can never be mistaken
   * for the current incarnation.
   */
  #generation = 0;
  #held = false;
  /**
   * Generation of the heartbeat currently in flight; used to drop its reply when
   * a release happened while it was travelling.
   */
  #inFlight: number | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(opts: BrowserViewerOptions) {
    this.id = opts.id ?? defaultId();
    this.#transport = opts.transport;
    this.#heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#visibility = opts.visibilityState ?? (() => (typeof document === "undefined" ? "visible" : document.visibilityState));
    this.#onError = opts.onError;
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
    const generation = this.#generation + 1;
    this.#generation = generation;
    this.#inFlight = generation;
    const result = await this.#send(generation);
    // A release (or a newer claim) happened while this heartbeat was in flight:
    // its reply describes an incarnation that is no longer current.
    if (this.#disposed || generation !== this.#generation) return this.#held ? this.#generation : 0;
    this.#inFlight = null;
    if (result.kind === "ok") {
      this.#held = true;
      this.#armTimer();
      return this.#generation;
    }
    if (result.kind === "stale") {
      // The server had already tombstoned this id at a higher generation (for
      // example another window reused the id after a crash), so this incarnation
      // is behind. Move past the tombstone and claim once more.
      this.#held = false;
      this.#generation += 1;
      const retryGeneration = this.#generation;
      const retried = await this.#send(retryGeneration);
      if (this.#disposed || retryGeneration !== this.#generation) {
        return this.#held ? this.#generation : 0;
      }
      this.#inFlight = null;
      if (retried.kind === "ok") {
        this.#held = true;
        this.#armTimer();
        return this.#generation;
      }
      this.#onError?.("无法保护浏览器占用状态，请重新打开面板");
      return 0;
    }
    this.#held = false;
    this.#onError?.(result.message ?? "无法连接控制面，浏览器可能被释放");
    return 0;
  }

  /**
   * Drop the lease now. The generation is bumped immediately (before the network
   * call) so any heartbeat still in flight is already stale when it lands.
   */
  async release(): Promise<void> {
    this.#cancelTimer();
    this.#generation += 1;
    this.#inFlight = null;
    if (!this.#held) return;
    this.#held = false;
    try {
      await this.#transport.release(this.id);
    } catch {
      // The server expires the lease by TTL anyway; never surface this as an error
      // the user must act on.
    }
  }

  /** True when `generation` is still the incarnation this controller holds. */
  isCurrent(generation: number): boolean {
    return this.#held && generation === this.#generation;
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
      if (this.#disposed || !this.#held) return;
      if (this.#visibility() !== "visible") {
        void this.release();
        return;
      }
      void this.claim();
    }, this.#heartbeatMs);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async #send(generation: number): Promise<HeartbeatResult> {
    try {
      return await this.#transport.heartbeat(this.id, generation);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
