import { ATTRIBUTION_KEYS, ATTRIBUTION_VALUE, type ClientEvent, type Platform } from "../../common/analytics";
import { hasDeviceLink } from "./deviceLink";
import { hasNativeBrowser } from "./deviceBrowser";

/**
 * The console's side of product analytics (src/control/analytics.ts): which
 * platform it runs on (sent with every API request), opening the console and
 * the pages people visit, and what happens only in the page (a welcome card
 * tapped, a chart saved, a retry button). Everything else is recorded by the
 * control plane. Props are small enumerated values: never text, names or URLs.
 */
let cached: Platform | null = null;
export function clientPlatform(): Platform {
  if (cached) return cached;
  if (typeof window === "undefined") return "web";
  // The Mac app is the only shell with the phone link; the phone apps have the device browser.
  if (hasDeviceLink()) cached = "mac";
  else if (hasNativeBrowser()) cached = /Android/i.test(navigator.userAgent) ? "android" : "ios";
  else if (matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true) cached = "pwa";
  else cached = "web";
  return cached;
}

type Send = (name: ClientEvent, props?: Record<string, string | number | boolean>) => Promise<unknown>;
let send: Send | null = null;
/** api.ts hands over its request function, so this module needs no import cycle. */
export function setAnalyticsSender(fn: Send): void { send = fn; }

/** Fire and forget: analytics never shows an error or holds anything up. */
export function track(name: ClientEvent, props?: Record<string, string | number | boolean>): void {
  void send?.(name, props).catch(() => undefined);
}

const REOPEN_MS = 30 * 60_000;
let lastOpen = 0;
/** Opening the console, and coming back to it after half an hour away (a phone app is rarely reloaded). */
export function trackOpen(lang: string): void {
  const now = Date.now();
  if (now - lastOpen < REOPEN_MS) return;
  lastOpen = now;
  track("app_open", { lang, ui: String(import.meta.env.VITE_AIO_UI_VERSION ?? "dev") });
}

const CAMPAIGN_KEY = "aio.campaign";
const CAMPAIGN_MS = 30 * 86400000;
type Campaign = { at: number; sent?: boolean; props: Record<string, string> };

function savedCampaign(): Campaign | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CAMPAIGN_KEY) ?? "null") as Campaign | null;
    return saved && typeof saved.at === "number" && Date.now() - saved.at < CAMPAIGN_MS && saved.props ? saved : null;
  } catch { return null; }
}

/**
 * The campaign link this browser first arrived by (`utm_source` and the like), kept for a month so it
 * survives email verification and the Google / Apple round trip. A later link does not replace it.
 */
export function captureCampaign(search = location.search): void {
  try {
    const query = new URLSearchParams(search), props: Record<string, string> = {};
    for (const key of ATTRIBUTION_KEYS) { const v = query.get(`utm_${key}`); if (v && ATTRIBUTION_VALUE.test(v)) props[key] = v; }
    if (props.source && !savedCampaign()) localStorage.setItem(CAMPAIGN_KEY, JSON.stringify({ at: Date.now(), props }));
  } catch { /* no storage: the visit simply carries no campaign */ }
}

/** The saved campaign as event properties (none when there is none). */
export function campaignProps(): Record<string, string> {
  return savedCampaign()?.props ?? {};
}

/** Once signed in, report the saved campaign a single time; the report counts it only for an account just created. */
export function reportCampaign(): void {
  const saved = savedCampaign();
  if (!saved || saved.sent || !send) return;
  void send("attribution", saved.props).then(() => {
    try { localStorage.setItem(CAMPAIGN_KEY, JSON.stringify({ ...saved, sent: true })); } catch { /* reported again next time */ }
  }).catch(() => undefined);
}
