import { track } from "./analytics";

/**
 * How long opening the console takes, step by step, reported once per page load as `boot_timing`
 * (src/control/analytics.ts aggregates it for the owner's dashboard). Times are milliseconds from the
 * start of the navigation (`performance.now()`), so they add up along the path a cold start takes:
 * the page (the network, or the copy the service worker keeps), then the version and the session
 * (asked together), then the feed, then the loading mark lifting off.
 */
type Step = "version" | "session" | "feed" | "cover";
const marks: Partial<Record<Step, number>> = {};
let sent = false;

/** The first time each step is reached; later ones (a reconnect, a reload of the feed) are not the opening. */
export function bootStep(step: Step): void {
  if (marks[step] === undefined) marks[step] = Math.round(performance.now());
}

/** Where the page came from: the service worker's saved copy (it says so in Server-Timing), or the network. */
function pageSource(nav: PerformanceNavigationTiming | undefined): string {
  if (!nav) return "unknown";
  if (nav.serverTiming?.some((s) => s.name === "sw" && s.description === "cache")) return "cache";
  return navigator.serviceWorker?.controller ? "network" : "no_worker";
}

/** The build this page is: its entry script's name changes with every build, so a device opening an old saved page shows up. */
export function build(): string {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? "";
  return src.split("/").pop()?.replace(/\.js$/, "") ?? "";
}

/** Sent when the mark lifts: the opening is over then, as far as the person can tell. */
export function reportBoot(): void {
  bootStep("cover");
  if (sent) return;
  sent = true;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  track("boot_timing", {
    page: pageSource(nav),
    build: build(),
    ttfb: Math.round(nav?.responseStart ?? -1),
    dom: Math.round(nav?.domContentLoadedEventEnd ?? -1),
    version: marks.version ?? -1,
    session: marks.session ?? -1,
    feed: marks.feed ?? -1,
    cover: marks.cover ?? -1,
  });
}
