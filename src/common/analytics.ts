/** Product analytics wire types and the events a console may report (the control plane records the rest itself). */

/** Where a request came from, as the console reports it in `x-client-platform`. */
export const PLATFORMS = ["web", "pwa", "ios", "android", "mac"] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Events the console reports: only what happens in the page and nowhere else
 * (the control plane records what it sees itself). `auth_view` is the only one
 * accepted without a session. `attribution` is the campaign link the browser
 * first arrived by (ATTRIBUTION_KEYS), reported once after signing in.
 */
export const CLIENT_EVENTS = ["app_open", "page_view", "auth_view", "welcome_card", "file_save", "retry_tap", "boot_timing", "stale_build", "attribution"] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];

/**
 * Where a visitor came from: the `utm_source`, `utm_medium`, `utm_campaign` and `utm_content` of the link
 * that first brought the browser here, as event properties without the prefix. Short identifiers only.
 */
export const ATTRIBUTION_KEYS = ["source", "medium", "campaign", "content"] as const;
export const ATTRIBUTION_VALUE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Features the report counts adoption of, in the order the dashboard lists them. */
export const FEATURES = [
  "task_typed", "task_scheduled", "task_gadget", "attachment", "photo", "voice_input", "schedule_create",
  "browser_takeover", "clawpage_publish", "clawpage_create", "clawpage_visit", "shared_kb_create", "shared_kb_invite",
  "shared_kb_join", "knowledge_use", "image_generate", "image_gif", "file_save", "welcome_card", "push_subscribe",
] as const;
export type Feature = (typeof FEATURES)[number];

/** The activation funnel's steps, in order. */
export const FUNNEL_STEPS = ["register_view", "signup", "first_task", "first_completed", "day1", "day7"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export type AnalyticsDay = {
  date: string;
  /** Accounts that opened the console, used a feature or submitted a task that day. */
  active: number;
  signups: number;
  logins: number;
  tasks: number;
  completed: number;
  failed: number;
  /** Console openings (`app_open`) that day; absent from a control plane that predates it. */
  sessions?: number;
  /** Distinct accounts active over the 7 days ending that day. */
  wau?: number;
};

/** One account's activity today: when it was last seen, its events and typed (not scheduled) tasks, and the platforms it used. */
export type ActiveAccount = { username: string | null; role: string | null; lastSeenAt: number; events: number; tasks: number; platforms: string[] };

/** The headline figures of one period (the range, or the same number of days just before it). */
export type PeriodTotals = {
  /** Distinct accounts active on any day of the period. */
  active: number;
  signups: number;
  tasks: number;
  completed: number;
  /** Failed, failed to plan, or ended with an unknown result. */
  failed: number;
  interrupted: number;
  sessions: number;
  /** Median time from submission to completion of the period's completed tasks. */
  medianTaskMs: number | null;
};

/** One step of the activation funnel. `eligible` is set for the return steps: the accounts old enough to have made it. */
export type FunnelEntry = { step: FunnelStep; count: number; eligible: number | null };

/** Accounts that signed up in one week (Monday first), and how many came back the next day and within 7 days. */
export type Cohort = { start: string; size: number; d1: { eligible: number; retained: number }; d7: { eligible: number; retained: number } };

export type FeatureUse = { feature: Feature; count: number; users: number; prevUsers: number };

export type TaskQuality = {
  /** Every task created in the range by how it stands now. `other` is still working, waiting for the person, or merged. */
  outcomes: { completed: number; failed: number; interrupted: number; unknown: number; other: number };
  medianMs: number | null;
  p90Ms: number | null;
  /** Stop taps, retries (planning retries and the console's retry buttons), content reports and browser restores that failed. */
  stops: number;
  retries: number;
  reports: number;
  /** 👍 and 👎 on replies given this period, as they stand now (a vote taken back is not counted). */
  likes: number;
  dislikes: number;
  restoreFailures: number;
  /** When some failed: the accounts they happened to, most first, and the step each failure stopped at (`mcp_unready`, `deadline`, …). */
  restoreAccounts?: Array<{ username: string; count: number }>;
  restoreReasons?: Record<string, number>;
};

/**
 * Opening the console, step by step (src/ui/src/bootTiming.ts), in milliseconds from the start of the
 * navigation: the first byte of the page, the page ready, the version and the session answered, the feed
 * here, the loading mark lifted.
 */
export const BOOT_METRICS = ["ttfb", "dom", "version", "session", "feed", "cover"] as const;
export type BootMetric = (typeof BOOT_METRICS)[number];
export type BootTimes = Record<BootMetric, { p50: number | null; p90: number | null }>;
/** One platform's openings this period: how many, how many from the saved page, and how long each step took. */
export type BootPlatform = { platform: string; opens: number; cached: number; times: BootTimes };

/**
 * One campaign link in the range: views of the register page that arrived by it, and the accounts created in
 * the range that reported it within a day of signing up, down to their first task. The row whose fields are
 * all null is everything that carried no campaign (typed address, apps, links without utm parameters).
 */
export type AcquisitionRow = {
  source: string | null; medium: string | null; campaign: string | null; content: string | null;
  registerViews: number; signups: number; firstTask: number; firstCompleted: number;
};

/** One account in the range: activity, tasks, where it used the console and the model of its latest task. */
export type AccountRow = {
  id: string;
  username: string;
  role: string;
  createdAt: number;
  /** Last activity in the report's window (at least 30 days); null when none. */
  lastSeenAt: number | null;
  activeDays: number;
  sessions: number;
  tasks: number;
  completed: number;
  failed: number;
  platforms: string[];
  model: string | null;
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
  /** Who counts towards `totals.activeToday`, most recently seen first. `username` is null for a deleted account.
   * Optional so a console can read a report from a control plane that predates it. */
  activeTodayAccounts?: ActiveAccount[];
  /** Every recorded event in the range, most frequent first. */
  events: Array<{ name: string; count: number; users: number }>;
  platforms: Array<{ platform: string; users: number; events: number }>;
  /** Register-form views (anonymous) against password sign-ups from that form, both from events in the range. */
  funnel: { registerViews: number; loginViews: number; signups: number };
  /** When event recording started; days before it only have task and account figures. */
  collectionStartedAt: number | null;
  // The rest is optional, so a console can read a report from a control plane that predates it.
  /** The range and the same number of days just before it. */
  current?: PeriodTotals;
  previous?: PeriodTotals;
  /** Accounts that signed up in the range, step by step to coming back. */
  activation?: FunnelEntry[];
  cohorts?: Cohort[];
  features?: FeatureUse[];
  quality?: TaskQuality;
  accounts?: AccountRow[];
  /** Console builds seen in the range (`app_open`), by platform. */
  versions?: Array<{ platform: string; version: string; users: number }>;
  /** Which welcome card in the main chat was tapped. */
  welcomeCards?: Array<{ card: string; count: number; users: number }>;
  /** Openings of the console this period, per platform, most first. */
  boot?: BootPlatform[];
  /** Register-page views and sign-ups by campaign link, most sign-ups first. */
  acquisition?: AcquisitionRow[];
  /** When a campaign was first recorded; null while none ever was (then `acquisition` says nothing about sources, not zero). */
  acquisitionStartedAt?: number | null;
};
