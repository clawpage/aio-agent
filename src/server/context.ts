import type { ShareStore } from "./share.js";
import type { Jev } from "./jev.js";
import type { TabServerLike } from "./browser/tabs.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./auth/sessions.js";
import type { TicketStore } from "./auth/tickets.js";
import type { LoginRateLimiter } from "./auth/ratelimit.js";
import type { SandboxContainer } from "./docker/sandbox.js";
import type { HostTokenSource } from "./codex/hostTokens.js";
import type { AgentManager, CodexSessionLike } from "./codex/manager.js";
import type { AioClient } from "./aio/client.js";
import type { DocumentService } from "./documents/service.js";
import type { BrowserService } from "./browser/service.js";
import type { BrowserRuntimeLike } from "./browser/lifecycle.js";

import type { TaskService } from "./tasks/service.js";
import type { SandboxIdle } from "./docker/idle.js";

export interface AppContext {
  runtimeForUser?: (userId: string) => Promise<AppContext>;
  /** Public share pages (root context only). */
  share?: ShareStore;
  /** Jev structured decisions (host-side key; absent without one). */
  jev?: Jev;
  tasks: TaskService;
  /** Whole-container idle stop/start; absent when the runtime keeps its container up. */
  idle?: SandboxIdle;
  cfg: Config;
  db: Db;
  log: Logger;
  sessions: SessionStore;
  tickets: TicketStore;
  limiter: LoginRateLimiter;
  container: SandboxContainer;
  hostTokens: HostTokenSource;
  codex: CodexSessionLike;
  agent: AgentManager;
  aio: AioClient;
  /** Sandbox document preview/conversion (readiness, bounded render, cache). */
  documents: DocumentService;
  /**
   * Sandbox browser lifecycle: decides when Chromium is released and rebuilds it
   * from a snapshot. Only the browser is ever released - never the container.
   */
  browser: BrowserService;
  /**
   * Container-side helper adapter behind `browser` (provisioning + CLI calls).
   * This is the runtime the service actually uses, so a test override is visible
   * here too instead of only inside `browser`.
   */
  browserRuntime: BrowserRuntimeLike;
  /** Tab-scoped browser tools (null in tests without a real sandbox). */
  tabs: TabServerLike | null;
  startedAt: number;
  /** Last sandbox setup error, surfaced truthfully in status (never a secret). */
  sandboxSetupError: string | null;
  /** Last observed reachability of the sandbox's own web surfaces. */
  sandboxSurfaces: Record<string, boolean> | null;
}
