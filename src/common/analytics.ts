/** Product analytics wire types and the events a console may report (the control plane records the rest itself). */

/** Where a request came from, as the console reports it in `x-client-platform`. */
export const PLATFORMS = ["web", "pwa", "ios", "android", "mac"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Events the console reports; `auth_view` is the only one accepted without a session. */
export const CLIENT_EVENTS = ["app_open", "page_view", "auth_view"] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];

export type AnalyticsDay = {
  date: string;
  /** Accounts that opened the console, used a feature or submitted a task that day. */
  active: number;
  signups: number;
  logins: number;
  tasks: number;
  completed: number;
  failed: number;
};

export type AnalyticsReport = {
  timezone: string;
  days: number;
  dates: string[];
  generatedAt: number;
  totals: {
    accounts: number;
    signups: number;
    /** Distinct active accounts today, over the last 7 and the last 30 days. */
    activeToday: number;
    active7: number;
    active30: number;
    tasks: number;
    completed: number;
    failed: number;
    /** Tasks by how they were started: typed in the console, by a schedule, or by the voice gadget. */
    sources: { manual: number; schedule: number; gadget: number };
  };
  daily: AnalyticsDay[];
  /** Every recorded event in the range, most frequent first. */
  events: Array<{ name: string; count: number; users: number }>;
  platforms: Array<{ platform: string; users: number; events: number }>;
  /** Register-form views (anonymous) against completed registrations, in the range. */
  funnel: { registerViews: number; loginViews: number; signups: number };
  /** When event recording started; days before it only have task and account figures. */
  collectionStartedAt: number | null;
};
