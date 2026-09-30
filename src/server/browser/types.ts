/**
 * Shared types for the sandbox browser lifecycle.
 *
 * The control plane owns a single state machine per sandbox: it aggregates every
 * reason the browser must stay awake (agent turns, human viewers, in-flight
 * proxied browser traffic, explicit operator pins) and, when none remain, hands
 * the browser to the in-container managed helper to snapshot and release.
 *
 * Nothing here ever stops the container, Codex, the terminal, code-server or
 * Jupyter - only the Chromium process is released.
 */

/** Aggregate lifecycle state, surfaced verbatim in the Chinese UI. */
export type BrowserLifecycleState =
  | "awake"
  | "idle"
  | "snapshotting"
  | "asleep"
  | "restoring"
  | "error";

/** Why the browser is currently held awake, one entry per lease kind. */
export interface LeaseSummary {
  /** Running agent turns - conservatively protects the whole turn, not a tool. */
  turns: number;
  /** Live viewer leases (visible workspace panel in a browser window). */
  viewers: number;
  /** In-flight proxied HTTP/WS requests to browser-bound sandbox endpoints. */
  calls: number;
  /**
   * Explicit holds that are not a task and not a viewer (a terminal driving CDP,
   * a background script, or a manual "keep the browser up" reservation).
   */
  holds: number;
  /** Operator pins that outlive any single request. */
  pins: number;
}

/**
 * Safe, URL-free error codes. Callers surface a Chinese message keyed by the
 * code; the raw runtime message is never propagated verbatim because it can
 * embed page URLs, cookies or storage contents.
 */
export type LifecycleErrorCode =
  | "disabled"
  | "holders"
  | "shutdown"
  | "snapshot_failed"
  | "snapshot_blocked"
  | "snapshot_incomplete"
  | "snapshot_storage_missing"
  | "stop_failed"
  | "stop_unattributed"
  | "restore_pending"
  | "wake_failed"
  | "reconcile_failed"
  | "runtime_error";

export interface BrowserLifecycleStatus {
  /** False when the feature is disabled by configuration. */
  enabled: boolean;
  /** Never released for idleness: one live browser per account, logins kept in place. */
  resident: boolean;
  state: BrowserLifecycleState;
  /** Unix ms when the browser is released; null while it is held awake. */
  idleDeadline: number | null;
  /** Unix ms the current state was entered. */
  since: number;
  /** Epoch incremented on every successful sleep/wake; used for race checks. */
  epoch: number;
  leases: LeaseSummary;
  /** Non-secret reason the last transition failed; never contains URLs/cookies. */
  lastError: string | null;
  /** Stable machine-readable form of `lastError`; null when the last cycle was clean. */
  lastErrorCode: LifecycleErrorCode | null;
  /** Age of the last successful snapshot, if one exists. */
  snapshotAt: number | null;
  /** Non-fatal warnings about the last snapshot (e.g. pages that cannot be restored). */
  lastSnapshotWarnings: SnapshotWarning[];
  /** Browser tabs that could not be snapshotted and must be re-opened manually. */
  unrestoredTabCount: number | null;
/** True when the container reports a live Chromium process. */
  browserRunning: boolean | null;
  /** Timestamp the state was last read from the container (null = never probed). */
  probedAt: number | null;
  /** Currently held keep-alive pins, expired ones excluded. */
  pins: PinLease[];
  /** savedAt of the snapshot already applied to the running browser. */
  restoredSnapshotAt: number | null;
  /** True when the runtime still owes a restore of the held snapshot. */
  restorePending: boolean;
  /** Schema of the snapshot on disk; null when there is none. */
  snapshotSchema: number | null;
  /**
   * True only when the snapshot carries a complete cookies/localStorage/IndexedDB
   * capture. A snapshot without it is lossy: releasing on it logs the user out, so
   * the state machine refuses to sleep until a fresh snapshot is taken.
   */
  snapshotHasStorage: boolean;
  /** Content-free storage counts for the UI (never cookies/localStorage values). */
  storageCounts: {
    cookies: number;
    origins: number;
    localStorageEntries: number;
    indexedDbDatabases: number;
  } | null;
  /**
   * True while another process holds the cross-process transition lock - a
   * previous control plane still finishing a stop/restore. Purely informational.
   */
  transitionBusy: boolean;
}

/** One viewer of the browser panel; identified per browser window/tab. */
export interface ViewerLease {
  id: string;
  /** Session that owns the lease, so a logout can drop it deterministically. */
  sessionId: string;
  /** Unix ms of the last accepted heartbeat. */
  seenAt: number;
  /**
   * Incarnation counter for this viewer id. A panel that hides/closes releases
   * its lease and the next mount registers a higher generation, so a heartbeat
   * that was already in flight when the lease was dropped is rejected instead of
   * resurrecting a cancelled lease.
   */
  generation: number;
}

/** A manually acquired hold that survives until it is released or expires. */
export interface PinLease {
  id: string;
  note: string;
  createdAt: number;
  expiresAt: number;
}

/** A page the helper could not fully capture and refused to lose silently. */
export interface SnapshotWarning {
  code:
    | "ambiguous_duplicate_tabs"
    | "tab_identity_unverified"
    | "tab_focus_unverified"
    | "tab_set_mismatch"
    | "tab_target_not_unique"
    | "cdp_target_missing_id"
    | "storage_unavailable"
    | "unsupported_scheme"
    | "unreachable"
    | "dirty_input"
    | "download_in_flight"
    | "no_tabs"
    | "tab_error"
    | "tab_order_unverified"
    | "active_unknown";
  /** Human, Chinese, secret-free description shown in the UI. */
  message: string;
  /** Index of the tab the warning is about, when it applies to one tab. */
  tabIndex: number | null;
}

/** A tab recorded in the snapshot. */
export interface SnapshotTab {
  url: string;
  title: string;
  active: boolean;
  /** Vertical scroll offset recorded before release (best-effort). */
  scrollY: number | null;
  /**
   * sessionStorage entries for the tab's origin, captured best-effort. Never
   * surfaced through the API: it can hold tokens for third-party sites.
   */
  sessionStorage: Record<string, string> | null;
}

export interface BrowserSnapshot {
  schema: 1 | 2;
  savedAt: number;
  /** Browser build string from CDP, for operator diagnosis only. */
  browserVersion: string | null;
  tabs: SnapshotTab[];
  warnings: SnapshotWarning[];
  /** Tabs that existed but could not be captured at all. */
  skipped: number;
  /**
   * False when the captured tab order could not be confirmed against the AIO
   * browser API. The tabs are all there, but their order is best-effort.
   */
  orderVerified: boolean;
  /**
   * The browser process this snapshot belongs to. A snapshot may only be used to
   * release/restore that exact process (PID + start time), never a recycled PID.
   */
  source: {
    browserPid: number | null;
    browserStarttime: number | null;
    generation: number;
  };
}

/**
 * Current writer schema. Schema 2 adds the full cookies/localStorage/IndexedDB
 * capture; schema 1 snapshots remain readable but never authorise a release,
 * because restoring them would silently log the user out.
 */
export const SNAPSHOT_SCHEMA = 2 as const;
/** Schemas this control plane can still parse (readable, not necessarily safe to stop on). */
export const READABLE_SNAPSHOT_SCHEMAS: readonly number[] = [1, 2];
/** Schemas whose restore is complete enough to release the browser for. */
export const STORAGE_SNAPSHOT_SCHEMA = 2 as const;
/** Every schema that carries the full cookies/localStorage/IndexedDB capture. */
export const STORAGE_SNAPSHOT_SCHEMAS: readonly number[] = [STORAGE_SNAPSHOT_SCHEMA];
