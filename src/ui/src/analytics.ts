import type { ClientEvent, Platform } from "../../common/analytics";
import { hasDeviceLink } from "./deviceLink";
import { hasNativeBrowser } from "./deviceBrowser";

/**
 * The console's side of product analytics (src/control/analytics.ts): which
 * platform it runs on (sent with every API request), opening the console and
 * the pages people visit. Everything else is recorded by the control plane.
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
  track("app_open", { lang });
}
