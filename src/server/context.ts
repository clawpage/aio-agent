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

export interface AppContext {
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
  startedAt: number;
  /** Last sandbox setup error, surfaced truthfully in status (never a secret). */
  sandboxSetupError: string | null;
  /** Last observed reachability of the sandbox's own web surfaces. */
  sandboxSurfaces: Record<string, boolean> | null;
}
