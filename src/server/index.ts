import http from "node:http";
import { loadConfig, ensureDataDirs, type Config } from "./config.js";
import { Logger } from "./logger.js";
import { openDb, type Db } from "./db.js";
import { SessionStore } from "./auth/sessions.js";
import { TicketStore } from "./auth/tickets.js";
import { LoginRateLimiter } from "./auth/ratelimit.js";
import { ensureOwner } from "./auth/owner.js";
import { SandboxContainer } from "./docker/sandbox.js";
import { HostTokenSource } from "./codex/hostTokens.js";
import { SandboxCodexSession } from "./codex/sandboxCodex.js";
import { AgentManager } from "./codex/manager.js";
import { AioClient } from "./aio/client.js";
import { createApp, handleUpgrade } from "./http/server.js";
import type { AppContext } from "./context.js";

export interface Bootstrapped {
  ctx: AppContext;
  db: Db;
  shutdown: () => Promise<void>;
}

export interface BootstrapOptions {
  config?: Config;
  log?: Logger;
  /** Skip owner creation (used by tests that pre-seed the DB). */
  skipOwner?: boolean;
  /** Test seams: replace the sandbox-backed collaborators. */
  overrides?: {
    codex?: import("./codex/manager.js").CodexSessionLike;
    container?: SandboxContainer;
    aio?: AioClient;
  };
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<Bootstrapped> {
  const cfg = opts.config ?? loadConfig();
  ensureDataDirs(cfg);
  const log =
    opts.log ??
    new Logger(process.env.PA_LOG_LEVEL === "debug" ? "debug" : "info", `${cfg.logDir}/personal-agent.log`, true);
  const db = openDb(cfg.dbPath);

  if (!opts.skipOwner) {
    const result = await ensureOwner(db, {
      password: cfg.ownerPassword,
      secretPath: cfg.ownerSecretPath,
      log,
      reset: cfg.ownerPasswordReset,
    });
    if (result.generatedSecretPath) {
      log.warn("owner secret written to the local file (0600); read it there, it is never logged", {
        path: result.generatedSecretPath,
        reset: Boolean(result.reset),
      });
    }
  }

  const sessions = new SessionStore(db, cfg.sessionTtlMs, cfg.sessionIdleRenewMs);
  const tickets = new TicketStore(db, cfg.ticketTtlMs);
  const limiter = new LoginRateLimiter(db, {
    maxFailures: cfg.loginMaxFailures,
    windowMs: cfg.loginWindowMs,
    lockoutMs: cfg.loginLockoutMs,
  });
  const container = opts.overrides?.container ?? new SandboxContainer(cfg, log);
  const hostTokens = new HostTokenSource(cfg, log);
  const codex = opts.overrides?.codex ?? new SandboxCodexSession(cfg, log, container, hostTokens);
  const agent = new AgentManager({ cfg, db, log, codex, hostTokens });
  const aio = opts.overrides?.aio ?? new AioClient(cfg, log);

  const ctx: AppContext = {
    cfg,
    db,
    log,
    sessions,
    tickets,
    limiter,
    container,
    hostTokens,
    codex,
    agent,
    aio,
    startedAt: Date.now(),
    sandboxSetupError: null,
    sandboxSurfaces: null,
  };

  await agent.init();

  const maintenance = setInterval(() => {
    try {
      sessions.purgeExpired();
      tickets.purge();
    } catch (err) {
      log.warn("maintenance failed", { error: String(err) });
    }
  }, 10 * 60_000);
  maintenance.unref?.();

  const shutdown = async (): Promise<void> => {
    clearInterval(maintenance);
    agent.shutdown();
    hostTokens.close();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };

  return { ctx, db, shutdown };
}

/** Bring the sandbox container and Codex session up in the background. */
export async function startSandboxRuntime(ctx: AppContext): Promise<void> {
  const { cfg, log, container, agent } = ctx;
  if (!cfg.sandbox.autostart) {
    log.info("sandbox autostart disabled by configuration");
    return;
  }
  try {
    const state = await container.ensureRunning();
    log.info("sandbox container ready", { name: state.image, healthy: state.healthy });
  } catch (err) {
    ctx.sandboxSetupError = err instanceof Error ? err.message : String(err);
    log.error("sandbox container failed to start", { error: ctx.sandboxSetupError });
    return;
  }
  try {
    await agent.ensureSession();
    ctx.sandboxSetupError = null;
    log.info("codex session established");
    // Catch up titles for conversations that predate the auto-title feature. This
    // runs in the background and never blocks the main turn queue.
    agent.scheduleTitleBackfill();
    try {
      ctx.sandboxSurfaces = await container.surfaces();
    } catch (err) {
      log.warn("surface probe failed", { error: String(err) });
    }
  } catch (err) {
    ctx.sandboxSetupError = err instanceof Error ? err.message : String(err);
    log.error("codex session failed to start", { error: ctx.sandboxSetupError });
    return;
  }
}

export interface RuntimeRecovery {
  stop(): void;
  /** Run one recovery pass immediately (used by tests and manual checks). */
  tick(): Promise<void>;
}

/**
 * Bounded, non-overlapping background recovery for the sandbox container and the
 * Codex session. Without it, a Mac that boots before Docker is ready would stay
 * permanently offline. Only this service's own container and Codex process are
 * touched; every pass is skipped while a previous one is still running, and the
 * loop stops with the process.
 */
export function startRuntimeRecovery(ctx: AppContext, intervalMs = 30_000): RuntimeRecovery {
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const [ready, state] = await Promise.all([ctx.container.isReady(), ctx.container.inspect()]);
      const needsWork = !ready || !state.running || !ctx.codex.ready;
      if (needsWork || ctx.sandboxSurfaces === null) {
        ctx.log.info("runtime recovery pass", { sandboxReady: ready, running: state.running, codexReady: ctx.codex.ready });
        await startSandboxRuntime(ctx);
      }
    } catch (err) {
      ctx.log.warn("runtime recovery pass failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function main(): Promise<void> {
  const { ctx, shutdown } = await bootstrap();
  const app = createApp(ctx);
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => handleUpgrade(ctx, req, socket, head));

  await new Promise<void>((resolve) => {
    server.listen(ctx.cfg.port, ctx.cfg.bind, () => resolve());
  });
  ctx.log.info("http server listening", { bind: ctx.cfg.bind, port: ctx.cfg.port });

  const recovery = startRuntimeRecovery(ctx);
  void recovery.tick();

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    ctx.log.info("shutting down", { signal });
    recovery.stop();
    server.close();
    await shutdown();
    setTimeout(() => process.exit(0), 200).unref?.();
  };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    ctx.log.error("unhandled rejection", { error: String(reason) });
  });
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: "error", msg: "fatal startup error", error: String(err) }));
    process.exit(1);
  });
}
