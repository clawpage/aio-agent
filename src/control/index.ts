import http from "node:http";
import path from "node:path";
import {MemberModelGateway} from "./memberModelGateway.js";
import {ShareStore} from "./share.js";
import {Jev} from "./jev.js";
import {DecisionGateway} from "./decision.js";
import {KbGateway} from "./kb.js";
import {ScheduleGateway} from "./scheduleTool.js";
import { ImageGateway, sandboxImageFiles } from "./imageTool.js";
import {UserRuntimes} from "./tenants.js";
import { loadConfig, ensureDataDirs, type Config } from "./config.js";
import { Logger } from "../common/logger.js";
import { openDb, type Db } from "./db.js";
import { UsageLedger } from './usage.js';
import { SessionStore } from "./auth/sessions.js";
import { TicketStore } from "./auth/tickets.js";
import { LoginRateLimiter } from "./auth/ratelimit.js";
import { ensureOwner } from "./auth/owner.js";
import { SandboxContainer } from "./sandbox/container.js";
import type { SandboxNode } from "./sandbox/node.js";
import { SandboxNodes } from "./sandbox/nodes.js";
import { DocumentService } from "./documents/service.js";
import { BrowserRuntime } from "./browser/runtime.js";
import { BrowserService } from "./browser/service.js";
import type { BrowserRuntimeLike } from "./browser/lifecycle.js";
import { HostTokenSource } from "./codex/hostTokens.js";
import { SandboxCodexSession } from "./codex/sandboxCodex.js";
import { AgentManager } from "./codex/manager.js";
import { BridgeModel } from "./bridgeModel.js";
import { ClaudeCodeHarness } from "./claudeCode.js";
import { pruneBeforeSnapshot, TabServer } from "./browser/tabs.js";
import { readAgentSettings } from "./settings.js";
import { ClaudeCodeSession } from "./codex/claudeSession.js";
import { HarnessSession } from "./codex/harnessSession.js";
import { AioClient } from "./aio/client.js";
import { createApp, handleUpgrade } from "./http/server.js";
import { TaskService } from "./tasks/service.js";
import type { AppContext } from "./context.js";
import { SandboxIdle } from "./sandbox/idle.js";
import { PushService, startTaskNotifications } from "./push.js";

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
  identity?: {id:string;username:string;role:string};
  deferAgentInit?: boolean;
  /** The node this runtime's sandbox lives on (members: chosen by the tenant layer). */
  node?: SandboxNode;
  /** The configured sandbox nodes (the owner's runtime picks its node from them). */
  nodes?: SandboxNodes;
  /** Test seams: replace the sandbox-backed collaborators. */
  overrides?: {
    codex?: import("./codex/manager.js").CodexSessionLike;
    container?: SandboxContainer;
    aio?: AioClient;
    documents?: DocumentService;
    browserRuntime?: BrowserRuntimeLike;
  };
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<Bootstrapped> {
  const cfg = opts.config ?? loadConfig();
  ensureDataDirs(cfg);
  const log =
    opts.log ??
    new Logger(process.env.PA_LOG_LEVEL === "debug" ? "debug" : "info", `${cfg.logDir}/personal-agent.log`, true);
  const db = openDb(cfg.dbPath);
  if(!cfg.memberRuntime)cfg.protectedMemberPorts=(db.prepare("SELECT value FROM meta WHERE key LIKE 'sandbox_port:%'").all() as {value:string}[]).map(x=>Number(x.value));

  if (opts.identity) {
    const u = opts.identity;
    db.prepare("INSERT INTO owners (id,username,role,password_hash,password_salt,password_params,created_at) VALUES (?,?,?,'disabled','disabled','{}',?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,role=excluded.role").run(u.id,u.username,u.role,Date.now());
  }

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
  const container = opts.overrides?.container ?? new SandboxContainer(cfg, log, opts.node ?? await ownerNode(cfg, db, opts.nodes));
  const documents = opts.overrides?.documents ?? new DocumentService(cfg, log, container);
  const hostTokens = new HostTokenSource(cfg, log);
  // One bridge instance per process: it owns the single decision about whether
  // the optional OpenCode Go model exists, and holds the key in memory only.
  const bridge = new BridgeModel(cfg, log);
  const claudeCode = new ClaudeCodeHarness(cfg, log);
  const usage = new UsageLedger(db, cfg.runtimeUserId ?? 'owner_1');
  usage.backfill();
  const sandboxCodex = new SandboxCodexSession(cfg, log, container, hostTokens, bridge, 90_000, usage);
  // Without a Claude Code credential the session is the plain Codex one, exactly as before.
  const codex = opts.overrides?.codex ?? (claudeCode.enabled ? new HarnessSession(sandboxCodex, new ClaudeCodeSession(cfg, log, container, claudeCode, usage), () => claudeCode.owns(readAgentSettings(db).model ?? cfg.agent.defaultModel)) : sandboxCodex);
  const browserRuntime = new BrowserRuntime(cfg, log, container);
  // A test seam replaces the container-facing runtime; the state machine itself
  // is always the production one.
  const resolvedBrowserRuntime: BrowserRuntimeLike = opts.overrides?.browserRuntime ?? browserRuntime;
  // Tab-scoped browser tools need the real sandbox; a test seam keeps the legacy tools.
  const tabs = opts.overrides?.browserRuntime || opts.overrides?.container ? null : new TabServer(cfg, log, container, browserRuntime);
  const browser = new BrowserService({
    cfg,
    log,
    // A test override replaces only the container-facing runtime, so the state
    // machine under test is the same one production uses.
    runtime: tabs ? pruneBeforeSnapshot(resolvedBrowserRuntime, tabs) : resolvedBrowserRuntime,
  });
  // The manager protects the browser for the whole of every managed turn, so a
  // lease must exist before this point (a queued turn can start on construction).
  const agent = new AgentManager({ cfg, db, log, codex, hostTokens, browser, bridge, claudeCode, tabs });
  const aio = opts.overrides?.aio ?? new AioClient(log, container);

  const jev = new Jev(cfg, log);
  const tasks = new TaskService(db, cfg, agent, codex, container, jev);
  const ctx: AppContext = {
    jev,
    tasks,
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
    documents,
    browser,
    browserRuntime: resolvedBrowserRuntime,
    tabs,
    startedAt: Date.now(),
    sandboxSetupError: null,
    sandboxSurfaces: null,
  };

  if(!opts.deferAgentInit){await agent.init();tasks.init();}

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
    tasks.close();
    agent.shutdown();
    // Stops only this service's own timers. It never signals the browser: a
    // control-plane restart must leave a running Chromium untouched.
    browser.shutdown();
    hostTokens.close();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };

  return { ctx, db, shutdown };
}

/** The owner's sandbox stays on the first node unless the database records another. */
async function ownerNode(cfg: Config, db: Db, nodes = new SandboxNodes(cfg)): Promise<SandboxNode> {
  return cfg.memberRuntime ? nodes.nodes[0]! : await nodes.assign(db, cfg.runtimeUserId ?? "owner_1", true);
}

/** Bring the sandbox container and Codex session up in the background. */
export async function startSandboxRuntime(ctx: AppContext): Promise<void> {
  const { cfg, log, container, agent } = ctx;
  if (!cfg.sandbox.autostart) {
    log.info("sandbox autostart disabled by configuration");
    return;
  }
  try {
    // A node this control plane cannot drive is refused before anything is asked of it.
    const compat = await container.node.check(0);
    if (!compat.ok) throw new Error(compat.error ?? "沙箱节点不可用");
    const state = await container.ensureRunning();
    log.info("sandbox container ready", { name: state.image, healthy: state.healthy });
    // Sites block a browser whose identity does not add up; best effort, never fatal.
    try {
      // Sites also reject the image's old Chromium build; a newer one replaces it when configured.
      let build: { binary: string; libraryPath: string } | null = null;
      if (cfg.browser.build) {
        try {
          build = await container.ensureBrowserBuild(cfg.browser.build);
        } catch (err) {
          log.warn("browser build not installed; keeping the image browser", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (await container.alignBrowserIdentity(cfg.browser.timezone, build)) log.info("sandbox browser identity aligned", { timezone: cfg.browser.timezone, binary: build?.binary ?? "image" });
    } catch (err) {
      log.warn("sandbox browser identity not aligned", { error: err instanceof Error ? err.message : String(err) });
    }
    // Phone keyboards typed every tap twice through the image's noVNC; best effort, never fatal.
    try {
      if (await container.patchNoVnc()) log.info("sandbox noVNC keyboard patched");
    } catch (err) {
      log.warn("sandbox noVNC keyboard not patched", { error: err instanceof Error ? err.message : String(err) });
    }
    // A tab server from an older version stays attached to every page (an older one
    // left automation traces sites detect); replace it now rather than at the next task.
    void ctx.tabs?.ensure().catch((err) => log.warn("browser tab server not refreshed", { error: String(err) }));
  } catch (err) {
    ctx.sandboxSetupError = err instanceof Error ? err.message : String(err);
    log.error("sandbox container failed to start", { error: ctx.sandboxSetupError });
    return;
  }
  try {
    await agent.ensureSession();
    ctx.sandboxSetupError = null;
    log.info("codex session established");
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

/**
 * Refresh the managed sandbox content (the workspace AGENTS.md template and the
 * document skill) once per startup.
 *
 * `startSandboxRuntime` already seeds, but only when it actually brings the
 * sandbox up. On an already-healthy container it returns early, so a version
 * that adds a new managed skill would never reach the running sandbox. This is
 * deliberately fire-and-forget and failure-tolerant: a sandbox that cannot be
 * reached must not stop the console from serving chat.
 */
export async function refreshSandboxContent(ctx: AppContext): Promise<void> {
  if (!ctx.cfg.sandbox.autostart) return;
  try {
    const state = await ctx.container.inspect();
    if (!state.exists || !state.running) return;
    await ctx.container.seedWorkspace();
    // The managed document scripts (and the published `aio-doc` copy) live in
    // the persistent tool directory, so a start that ships a newer script must
    // sync them into an already-running sandbox too - otherwise it keeps running
    // the previous revision. `ensureScripts` is a cheap digest check that only
    // writes files/chmod; it never runs apt/pip, so this stays off the chat
    // critical path. A sandbox that cannot be reached is logged and ignored.
    try {
      await ctx.documents.ensureScripts();
    } catch (err) {
      ctx.log.warn("sandbox document script refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    ctx.log.warn("sandbox content refresh failed", { error: err instanceof Error ? err.message : String(err) });
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
    // A container stopped (or being started) for idleness is not broken; only wake() brings it back.
    if (stopped || inFlight || ctx.idle?.managing) return;
    inFlight = true;
    try {
      const [ready, state] = await Promise.all([ctx.container.isReady(), ctx.container.inspect()]);
      const needsWork = !ready || !state.running || !ctx.codex.ready;
      if (needsWork || ctx.sandboxSurfaces === null) {
        ctx.log.info("runtime recovery pass", { sandboxReady: ready, running: state.running, codexReady: ctx.codex.ready });
        await startSandboxRuntime(ctx);
      }
      // A released Chromium is not a broken sandbox. `/health` only proves the
      // container's API is alive; when the container is otherwise healthy this
      // read-only probe reconciles the control plane with reality (out-of-band
      // stop, a crash, or a browser released for idleness) without ever waking
      // it. It must never be part of the `needsWork` decision above, or a sleep
      // would trigger a container-wide restart.
      if (ready && ctx.cfg.browser.enabled) {
        try {
          await ctx.browser.observe();
          // A resident browser found released (before an upgrade, or after a crash)
          // is brought back once, restoring its saved logins, and then stays.
          const seen = ctx.browser.status();
          if (!ctx.cfg.browser.releaseWhenIdle && (seen.state === "asleep" || seen.restorePending)) await ctx.browser.wake();
          // Only between tasks and outside a wake/restore, which use those clients themselves.
          const agent = await ctx.agent.status();
          const now = ctx.browser.status();
          const settled = (now.state === "awake" || now.state === "idle") && !now.restorePending;
          if (settled && agent.activeTurns.length === 0 && agent.queuedTurns === 0) {
            const dropped = await ctx.container.dropImageCdpClients();
            if (dropped.length) ctx.log.info("image browser clients disconnected", { dropped });
          }
        } catch (err) {
          ctx.log.debug?.("browser observe probe failed", { error: err instanceof Error ? err.message : String(err) });
        }
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

/** Whole-container idle stop/start for a runtime configured for it (members by default). */
export function startSandboxIdle(ctx: AppContext, intervalMs = 30_000, parked = false): SandboxIdle | null {
  if (!ctx.cfg.sandbox.autostart || !ctx.cfg.sandbox.releaseWhenIdle) return null;
  const idle = new SandboxIdle({ ctx, idleMs: ctx.cfg.sandbox.idleMs, start: startSandboxRuntime, intervalMs, parked });
  ctx.idle = idle;
  ctx.agent.setSandboxGate(() => idle.wake());
  return idle;
}

async function main(): Promise<void> {
  const config=loadConfig();
  config.runtimeUserId="owner_1";
  const nodes = new SandboxNodes(config);
  const { ctx, shutdown } = await bootstrap({config, nodes});
  const account=(sql:string,value:string)=>(ctx.db.prepare(sql).get(value) as {v:string}|undefined)?.v??null;
  ctx.share=new ShareStore({cfg:ctx.cfg,port:ctx.cfg.memberModelPort??4902,
    usernameOf:id=>account("SELECT username AS v FROM owners WHERE id=?",id),
    userIdOf:name=>account("SELECT id AS v FROM owners WHERE username=?",name)});
  // The owner sandbox receives its token when refreshSandboxContent seeds it below.
  ctx.share.provision(ctx.cfg);
  const decision=new DecisionGateway({cfg:ctx.cfg,db:ctx.db,jev:ctx.jev!,log:ctx.log,port:ctx.cfg.memberModelPort??4902});
  decision.provision(ctx.cfg);
  const kb=new KbGateway({cfg:ctx.cfg,log:ctx.log,port:ctx.cfg.memberModelPort??4902,usernameOf:id=>account("SELECT username AS v FROM owners WHERE id=?",id)});
  kb.provision(ctx.cfg);
  // Each account's schedules live in its own runtime: the owner's here, a member's in its runtime.
  const schedule=new ScheduleGateway({port:ctx.cfg.memberModelPort??4902,log:ctx.log,
    tasksFor:async id=>id===ctx.cfg.runtimeUserId?ctx.tasks:(await ctx.runtimeForUser!(id)).tasks});
  schedule.provision(ctx.cfg);
  // Pictures come from the control plane's own ChatGPT login, so only a deployment with one offers them.
  const image=ctx.cfg.hostCodex.enabled?new ImageGateway({port:ctx.cfg.memberModelPort??4902,log:ctx.log,hostTokens:ctx.hostTokens,
    chatgptUrl:ctx.cfg.hostCodex.chatgptUrl,workspace:ctx.cfg.sandbox.containerWorkspaceDir,
    filesFor:async id=>sandboxImageFiles(id===ctx.cfg.runtimeUserId?ctx:await ctx.runtimeForUser!(id))}):undefined;
  image?.provision(ctx.cfg);
  const modelGateway=new MemberModelGateway(ctx.cfg,ctx.log,ctx.share,decision,kb,schedule,ctx.hostTokens,image);
  await modelGateway.start();
  // Phone notifications: one key pair and one subscription store for every account.
  ctx.push=new PushService({db:ctx.db,log:ctx.log,keyFile:path.join(ctx.cfg.dataDir,"vapid.json"),subject:`https://${ctx.cfg.primaryHost}`});
  const ownerNotifications=startTaskNotifications(ctx,ctx.push);
  const users=new UserRuntimes(ctx,bootstrap,modelGateway,nodes);
  ctx.runtimeForUser=id=>users.resolve(id);
  const app = createApp(ctx);
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => handleUpgrade(ctx, req, socket, head));

  await new Promise<void>((resolve) => {
    server.listen(ctx.cfg.port, ctx.cfg.bind, () => resolve());
  });
  ctx.log.info("http server listening", { bind: ctx.cfg.bind, port: ctx.cfg.port });

  for(const user of ctx.db.prepare("SELECT id FROM owners WHERE role='member'").all() as {id:string}[]) {
    void users.resolve(user.id).catch(()=>ctx.log.error("member runtime unavailable",{userId:user.id}));
  }
  const recovery = startRuntimeRecovery(ctx);
  void recovery.tick();
  const idle = startSandboxIdle(ctx);
  // Independent of the health check above, so a new managed skill reaches a
  // sandbox that is already running. Never awaited: chat startup must not wait
  // on the sandbox.
  void refreshSandboxContent(ctx);

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    ctx.log.info("shutting down", { signal });
    recovery.stop();
    idle?.stop();
    ownerNotifications.stop();
    server.close();
    modelGateway.close();
    await users.shutdown();
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
