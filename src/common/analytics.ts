/** Product analytics wire types and the events a console may report (the control plane records the rest itself). */

/** Where a request came from, as the console reports it in `x-client-platform`. */
export const PLATFORMS = ["web", "pwa", "ios", "android", "mac"] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Events the console reports: only what happens in the page and nowhere else
 * (the control plane records what it sees itself). `auth_view` is the only one
 * accepted without a session.
 */
export const CLIENT_EVENTS = ["app_open", "page_view", "auth_view", "welcome_card", "file_save", "retry_tap"] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];

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
  restoreFailures: number;
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
};
