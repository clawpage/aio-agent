/**
 * Whether a person is actually at the console: the page is visible and someone
 * touched it (or a workspace frame reported a touch) within `ATTENTION_MS`.
 * Visibility alone is not use: a console left open on a desktop screen kept its
 * sandbox (and through the browser panel, its Chromium) running for days.
 */
export const ATTENTION_MS = 5 * 60_000;

/** Input that only a person produces; `pointermove` covers reading with the mouse. */
const EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export interface AttentionEnv {
  now(): number;
  visible(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class Attention {
  #env: AttentionEnv;
  #lastAt: number;
  #attended: boolean;
  #timer: unknown = null;
  #listeners = new Set<(attended: boolean) => void>();

  constructor(env: AttentionEnv) {
    this.#env = env;
    this.#lastAt = env.now();
    this.#attended = env.visible();
    this.#arm();
  }

  get attended(): boolean {
    return this.#attended;
  }

  /** Someone did something; cheap enough for every pointer move. */
  mark(): void {
    this.#lastAt = this.#env.now();
    // While attended the expiry timer re-reads `#lastAt` when it fires.
    if (!this.#attended) this.update();
  }

  /** Re-read visibility and the time since the last input; tells listeners about a change. */
  update(): void {
    const next = this.#env.visible() && this.#env.now() - this.#lastAt < ATTENTION_MS;
    this.#arm();
    if (next === this.#attended) return;
    this.#attended = next;
    for (const listener of this.#listeners) listener(next);
  }

  subscribe(listener: (attended: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #arm(): void {
    if (this.#timer !== null) this.#env.clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#env.visible()) return;
    const left = this.#lastAt + ATTENTION_MS - this.#env.now();
    if (left > 0) this.#timer = this.#env.setTimeout(() => { this.#timer = null; this.update(); }, left);
  }
}

let shared: Attention | null = null;

/** The page's one tracker, wired to its input, visibility and workspace frames on first use. */
export function attention(): Attention {
  if (shared) return shared;
  const tracker = new Attention({
    now: () => Date.now(),
    visible: () => document.visibilityState === "visible",
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });
  const mark = () => tracker.mark();
  for (const name of EVENTS) window.addEventListener(name, mark, { capture: true, passive: true });
  // Coming back to the tab is itself a touch.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tracker.mark();
    tracker.update();
  });
  // Input inside a workspace frame (the sandbox desktop) never reaches this page; the frame reports it.
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || m.aio !== "desktop" || m.type !== "activity") return;
    if (![...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === event.source)) return;
    tracker.mark();
  });
  shared = tracker;
  return tracker;
}
