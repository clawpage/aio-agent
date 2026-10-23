import type { AppContext } from "../context.js";

/** An IANA time zone the browser reported, in its canonical spelling, or null. */
export function loginTimezone(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * After a sign-in: the account's daily feed moves to the time zone the browser
 * signed in from. In the background, so signing in never waits for (or fails
 * on) the account's runtime starting up.
 */
export function followLoginTimezone(context: Pick<AppContext, "cfg" | "log" | "tasks" | "runtimeForUser">, userId: string, raw: unknown): void {
  const tz = loginTimezone(raw);
  if (!tz) return;
  const runtime = userId === context.cfg.runtimeUserId || !context.runtimeForUser ? Promise.resolve(context) : context.runtimeForUser(userId);
  void runtime
    .then((rt) => { if (rt.tasks.followFeedTimezone(userId, tz)) context.log.info("daily feed follows sign-in time zone", { userId, timezone: tz }); })
    .catch((err) => context.log.warn("daily feed time zone not updated", { userId, error: err instanceof Error ? err.message : String(err) }));
}
