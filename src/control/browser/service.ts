/**
 * Control-plane surface for the sandbox browser lifecycle.
 *
 * `BrowserLifecycle` owns the state machine; this class is the thin, opinionated
 * layer the HTTP API, the agent manager and the companion proxy talk to. It keeps
 * one rule in a single place: nothing that merely *reads* the browser may keep it
 * awake.
 *
 *  - `status()` and `observe()` are read-only: they never take a lease, never
 *    reset the idle countdown and never wake the browser.
 *  - `withTurn()` reserves synchronously before any await and releases in a
 *    `finally`, so an exception, a stop or a waiting approval cannot leak a hold.
 *  - `withCall()` is for in-flight proxied browser traffic. It only protects
 *    paths the companion proxy proves are browser/CDP/VNC bound.
 *  - Viewer heartbeats come from a visible panel in a visible document and expire
 *    on their own (TTL), and a logout drops every lease the session held.
 */

import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import type { BrowserRuntimeLike, LifecycleClock, LifecycleEvent } from "./lifecycle.js";
import { BrowserLifecycle } from "./lifecycle.js";
import type { BrowserLifecycleStatus, LeaseSummary, PinLease, ViewerLease } from "./types.js";

export interface BrowserServiceEvent extends LifecycleEvent {
  at: number;
}

export interface BrowserServiceOptions {
  cfg: Config;
  log: Logger;
  runtime: BrowserRuntimeLike;
  clock?: LifecycleClock;
  onEvent?: (event: BrowserServiceEvent) => void;
}

export interface BrowserStatusView extends BrowserLifecycleStatus {
  /** Container path of the snapshot; the API never returns this, only the UI text. */
  snapshotConfigured: boolean;
  /** Recently released viewer ids, for tests and operator diagnosis (no secrets). */
  viewerCount: number;
}

/** Reasons a companion-domain request counts as real browser activity. */
const BROWSER_PATH_PREFIXES = [
  "/api/v1/browser",
  "/v1/browser",
  // The AIO browser console page and the raw CDP/devtools surfaces. `/browser-ui`
  // is its own prefix (not a child of `/browser`), so it must be listed explicitly
  // or the panel page itself would go unprotected while its assets stayed excluded.
  "/browser-ui",
  "/browser",
  "/cdp",
  "/devtools",
  "/json",
  "/vnc",
  "/websockify",
  // The live screen stream. The workspace panel opens the VNC websocket at
  // `/ws`, and `/v1/display` serves its screenshots/input; both are real viewing.
  // `/v1/shell/ws` (the terminal) is deliberately NOT listed: it is a different
  // surface and must never keep Chromium awake.
  "/ws",
  "/v1/display",
];

/**
 * True when a companion-domain path is genuinely driven by the browser surface.
 * Terminal, file, code-server and Jupyter traffic must never keep the browser up,
 * and neither may an iframe's static assets.
 */
/** Paths that are never browser viewing even though a listed prefix could match. */
const NON_BROWSER_PATH_PREFIXES = ["/v1/shell", "/v1/files", "/v1/jupyter", "/api/v1/shell"];

/**
 * Fixed note of the browser panel's keep-awake pin. It is a protocol constant,
 * not a user-visible string: both the server and the panel match on it, and the
 * panel filters `status().pins` by it to rebuild its own toggle state.
 */
export const UI_KEEP_ALIVE_NOTE = "UI 手动保留浏览器";

export function isBrowserBoundPath(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url, "http://placeholder.invalid").pathname;
  } catch {
    return false;
  }
  const lower = pathname.toLowerCase();
  // Terminal/file/notebook surfaces are excluded first: an open terminal must
  // never hold Chromium awake, whatever a prefix rule says.
  if (NON_BROWSER_PATH_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
    return false;
  }
  if (lower === "/json" || lower === "/json/list" || lower === "/json/version" || lower.startsWith("/json/")) {
    return true;
  }
  return BROWSER_PATH_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

/**
 * Static asset paths that a browser panel legitimately loads. They are excluded
 * explicitly so a long-lived page cannot hold the browser awake through its own
 * images/scripts: only a real API/CDP/VNC call protects it.
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  ".js", ".mjs", ".css", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".txt", ".wasm",
]);

export function isStaticAssetPath(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url, "http://placeholder.invalid").pathname;
  } catch {
    return false;
  }
  const lower = pathname.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  const slash = lower.lastIndexOf("/");
  if (dot < slash) return false;
  return STATIC_ASSET_EXTENSIONS.has(lower.slice(dot));
}

export class BrowserService {
  #lifecycle: BrowserLifecycle;
  #log: Logger;
  #onEvent: ((event: BrowserServiceEvent) => void) | undefined;

  constructor(opts: BrowserServiceOptions) {
    this.#log = opts.log;
    this.#onEvent = opts.onEvent;
    this.#lifecycle = new BrowserLifecycle({
      runtime: opts.runtime,
      enabled: opts.cfg.browser.enabled,
      idleMs: opts.cfg.browser.idleMs,
      releaseWhenIdle: opts.cfg.browser.releaseWhenIdle,
      viewerTtlMs: opts.cfg.browser.viewerTtlMs,
      clock: opts.clock,
      log: opts.log,
      onEvent: (event) => {
        this.#log.debug?.("browser lifecycle event", { type: event.type, state: event.state });
        this.#onEvent?.({ ...event, at: Date.now() });
      },
      snapshotTimeoutMs: opts.cfg.browser.helperTimeoutMs,
      stopTimeoutMs: opts.cfg.browser.stopTimeoutMs,
      wakeTimeoutMs: opts.cfg.browser.wakeTimeoutMs,
    });
  }

  get enabled(): boolean {
    return this.#lifecycle.status().enabled;
  }

  /**
   * Read-only lifecycle snapshot. Deliberately in-memory: a status poll must
   * never wake the browser or move the idle deadline.
   */
  status(): BrowserStatusView {
    const status = this.#lifecycle.status();
    return { ...status, snapshotConfigured: true, viewerCount: status.leases.viewers };
  }

  /**
   * Read-only reconciliation against the container. Also never wakes: it only
   * asks the runtime what is true and adopts the answer.
   */
  async observe(): Promise<BrowserStatusView> {
    const status = await this.#lifecycle.observeRuntime();
    return { ...status, snapshotConfigured: true, viewerCount: status.leases.viewers };
  }

  /**
   * The proxy's narrow view of this service: reserve a call lease for a
   * browser-bound connection and have it released when the connection ends.
   */
  proxyGate(): { reserveCall: () => () => void; ready: () => Promise<void> } {
    return {
      reserveCall: () => {
        const lease = this.#lifecycle.reserve("call");
        return () => lease.release();
      },
      ready: () => this.#lifecycle.ready(),
    };
  }

  /** Reserve a hold for one managed agent turn and return the release function. */
  reserveTurn(): () => void {
    const lease = this.#lifecycle.reserve("turn");
    return () => lease.release();
  }

  /**
   * Wrap work that needs a usable browser. The reservation is synchronous and
   * happens before `ready()`, so two concurrent callers cannot both decide the
   * browser is free.
   */
  async withCall<T>(kind: "call" | "hold", fn: () => Promise<T> | T): Promise<T> {
    const lease = this.#lifecycle.reserve(kind);
    try {
      await this.#lifecycle.ready();
      return await fn();
    } finally {
      lease.release();
    }
  }

  /** Await a usable browser while a turn lease is already held. */
  async ready(): Promise<void> {
    await this.#lifecycle.ready();
  }

  /** Explicit wake, used by the API's keep-alive/retry action. */
  async wake(): Promise<void> {
    await this.#lifecycle.wake();
  }

  /** The sandbox container stopped (or was found stopped): every browser timer goes off. */
  containerStopped(): void {
    this.#lifecycle.containerStopped();
  }

  /** The sandbox container is up again: reconcile before any release is considered. */
  containerStarted(): void {
    this.#lifecycle.containerStarted();
  }

  /** Run `fn` with no wake/restore or release in flight, and none starting until it ends. */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    return await this.#lifecycle.runExclusive(fn);
  }

  /** Run one sleep cycle now (used by tests and a manual "release now" action). */
  async sleepNow() {
    return await this.#lifecycle.sleepNow();
  }

  // ------------------------------------------------------------- viewers

  /** A visible panel heartbeats here; a stale generation is rejected. */
  touchViewer(id: string, sessionId: string, generation = 0): ViewerLease | null {
    return this.#lifecycle.touchViewer(id, sessionId, generation);
  }

  releaseViewer(id: string, generation?: number, sessionId?: string): void {
    this.#lifecycle.releaseViewer(id, generation, sessionId);
  }

  /** Drop every viewer lease a session held (logout). */
  releaseViewersForSession(sessionId: string): number {
    return this.#lifecycle.releaseViewersForSession(sessionId);
  }

  // ---------------------------------------------------------------- pins

  pin(note: string, ttlMs?: number): PinLease {
    return this.#lifecycle.pin(note, ttlMs);
  }

  unpin(id: string): void {
    this.#lifecycle.unpin(id);
  }

  pins(): PinLease[] {
    return this.#lifecycle.pins();
  }

  /**
   * The browser panel's own "keep the browser awake" switch, made idempotent and
   * rebuildable from `status()`. The note is a fixed control-plane constant, so a
   * reload, a second window or a re-login re-derives the same pin instead of
   * stacking a new permanent one, and releasing it can never release an operator
   * or background-script pin that happens to exist at the same time.
   */
  pinUiKeepAlive(): PinLease {
    return this.#lifecycle.pinIdentified(UI_KEEP_ALIVE_NOTE);
  }

  unpinUiKeepAlive(): number {
    return this.#lifecycle.unpinNote(UI_KEEP_ALIVE_NOTE);
  }

  /** The UI keep-alive pin currently held, or null. Reconstructed from server state. */
  uiKeepAlivePin(): PinLease | null {
    return this.pins().find((pin) => pin.note === UI_KEEP_ALIVE_NOTE) ?? null;
  }

  leases(): LeaseSummary {
    return this.#lifecycle.status().leases;
  }

  /** Stop our own timers. Never touches the container or the browser. */
  shutdown(): void {
    this.#lifecycle.shutdown();
  }
}
