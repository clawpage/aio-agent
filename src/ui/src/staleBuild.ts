import { track } from "./analytics";
import { build } from "./bootTiming";

/** How long after it first found itself behind the deployed console a page may run on before it switches. */
export const STALE_SWITCH_MS = 3 * 3600_000;
/** Coming back to the console checks again at most this often. */
const RECHECK_MS = 10 * 60_000;
/** Where this device keeps when its build was first found behind (a convenience: without it, the count starts again). */
const KEY = "aio.behindSince";

type Behind = { build: string; since: number };

/** When `mine` was first found behind: the time kept for it, or now for a build not yet found behind. */
export function behindSince(kept: Behind | null, mine: string, now: number): Behind {
  return kept && kept.build === mine && kept.since <= now ? kept : { build: mine, since: now };
}

const keep = (value: Behind | null) => { try { if (value) localStorage.setItem(KEY, JSON.stringify(value)); else localStorage.removeItem(KEY); } catch { /* not kept */ } };
const kept = (): Behind | null => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "null"); return typeof v?.build === "string" && typeof v?.since === "number" ? v : null; } catch { return null; } };

/** Nothing would be lost by loading the page again: nothing being typed (a message, or a sign-in form), sending or left unsent. */
const idle = () => ![...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, .login input:not([type=hidden]):not([type=checkbox])")].some((box) => box.value.trim()) && !document.querySelector(".outgoing-state");
/** Signed out (the sign-in or registration page): an old page here may lack a step the server now asks for, such as the email code. */
const signedOut = () => !!document.querySelector(".login");

const reported = new Set<string>();
let checkedAt = -Infinity;

/**
 * A phone app is resumed far more often than reopened, so it can run an old build of the console for a long time.
 * On opening and each time the console comes back on screen, the deployed page is asked for. The first time this
 * build is found behind is kept; each newer build found is reported once (`stale_build`, with how long since then),
 * and STALE_SWITCH_MS after it the console switches to the deployed one with `load`, when nothing would be lost;
 * on the sign-in and registration page at once, where nothing of the person's work is open.
 */
export async function checkBuild(load: () => boolean, signedOutNow = false): Promise<void> {
  if (Date.now() - checkedAt < RECHECK_MS) return;
  checkedAt = Date.now();
  const mine = build();
  if (!mine) return;
  const response = await fetch("/", { cache: "no-store", credentials: "same-origin" }).catch(() => null);
  if (!response?.ok) return;
  const deployed = /\/assets\/(index-[^"'\s/]+)\.js/.exec(await response.text())?.[1];
  if (!deployed) return;
  if (deployed === mine) { keep(null); return; }
  const now = Date.now();
  const behind = behindSince(kept(), mine, now);
  keep(behind);
  const switching = (signedOutNow || signedOut() || now - behind.since > STALE_SWITCH_MS) && idle();
  if (!reported.has(deployed) || switching) {
    reported.add(deployed);
    track("stale_build", { build: mine, deployed, behind_min: Math.round((now - behind.since) / 60_000), switched: switching });
  }
  if (switching) load();
}
