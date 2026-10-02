import { describe, expect, it } from "vitest";
import { startRuntimeRecovery } from "../../src/control/index.js";
import { Logger } from "../../src/common/logger.js";
import type { AppContext } from "../../src/control/context.js";

interface Counters {
  ensureRunning: number;
  ensureSession: number;
}

function makeCtx(state: { ready: boolean; running: boolean; codexReady: boolean; fail?: boolean }, counters: Counters): AppContext {
  const container = {
    name: "personal-agent-sandbox",
    node: { check: async () => ({ ok: true, version: "test", protocol: 1, error: null }) },
    isReady: async () => state.ready,
    inspect: async () => ({
      exists: true,
      running: state.running,
      healthy: state.ready,
      image: "img",
      startedAt: null,
      managedLabel: "1",
      mounts: [],
    }),
    ensureRunning: async () => {
      counters.ensureRunning += 1;
      if (state.fail) throw new Error("docker not ready yet");
      state.ready = true;
      state.running = true;
      return { exists: true, running: true, healthy: true };
    },
    surfaces: async () => ({ terminal: true, codeServer: true, jupyter: true }),
  };
  const agent = {
    ensureSession: async () => {
      counters.ensureSession += 1;
      state.codexReady = true;
    },
  };
  const codex = { ready: state.codexReady };
  return {
    cfg: { sandbox: { autostart: true } },
    log: new Logger("error", undefined, false),
    container,
    agent,
    codex,
    sandboxSetupError: null,
    sandboxSurfaces: { terminal: true, codeServer: true, jupyter: true },
  } as unknown as AppContext;
}

describe("runtime recovery loop", () => {
  it("keeps retrying while the sandbox is unavailable", async () => {
    const state = { ready: false, running: false, codexReady: false, fail: true };
    const counters = { ensureRunning: 0, ensureSession: 0 };
    const ctx = makeCtx(state, counters);
    const recovery = startRuntimeRecovery(ctx, 60_000);
    await recovery.tick();
    await recovery.tick();
    expect(counters.ensureRunning).toBe(2);
    expect(counters.ensureSession).toBe(0);
    recovery.stop();
  });

  it("takes over once the dependency becomes available", async () => {
    const state = { ready: false, running: false, codexReady: false, fail: true };
    const counters = { ensureRunning: 0, ensureSession: 0 };
    const ctx = makeCtx(state, counters);
    const recovery = startRuntimeRecovery(ctx, 60_000);
    await recovery.tick();
    state.fail = false;
    await recovery.tick();
    expect(counters.ensureSession).toBe(1);
    expect(state.codexReady).toBe(true);
    recovery.stop();
  });

  it("does not perform a pass when everything is healthy", async () => {
    const state = { ready: true, running: true, codexReady: true };
    const counters = { ensureRunning: 0, ensureSession: 0 };
    const ctx = makeCtx(state, counters);
    const recovery = startRuntimeRecovery(ctx, 60_000);
    await recovery.tick();
    expect(counters.ensureRunning).toBe(0);
    recovery.stop();
  });

  it("never overlaps two passes", async () => {
    const state = { ready: false, running: false, codexReady: false };
    const counters = { ensureRunning: 0, ensureSession: 0 };
    const ctx = makeCtx(state, counters);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (ctx.container as unknown as { ensureRunning: () => Promise<unknown> }).ensureRunning = async () => {
      counters.ensureRunning += 1;
      await gate;
      return {};
    };
    const recovery = startRuntimeRecovery(ctx, 60_000);
    const first = recovery.tick();
    const second = recovery.tick(); // must be skipped while the first is in flight
    release();
    await Promise.all([first, second]);
    expect(counters.ensureRunning).toBe(1);
    recovery.stop();
  });

  it("stops retrying after stop()", async () => {
    const state = { ready: false, running: false, codexReady: false, fail: true };
    const counters = { ensureRunning: 0, ensureSession: 0 };
    const ctx = makeCtx(state, counters);
    const recovery = startRuntimeRecovery(ctx, 60_000);
    await recovery.tick();
    recovery.stop();
    await recovery.tick();
    expect(counters.ensureRunning).toBe(1);
  });
});

describe("resident browser", () => {
  const withBrowser = (releaseWhenIdle: boolean, status: { state: string; restorePending: boolean }) => {
    const woke: number[] = [];
    const ctx = makeCtx({ ready: true, running: true, codexReady: true }, { ensureRunning: 0, ensureSession: 0 });
    Object.assign(ctx, {
      cfg: { sandbox: { autostart: true }, browser: { enabled: true, releaseWhenIdle } },
      browser: { observe: async () => undefined, status: () => status, wake: async () => void woke.push(1) },
    });
    return { ctx, woke };
  };

  it("brings a released browser back once, so each account keeps one live browser with its logins", async () => {
    const { ctx, woke } = withBrowser(false, { state: "asleep", restorePending: true });
    const recovery = startRuntimeRecovery(ctx, 60_000);
    await recovery.tick();
    expect(woke).toHaveLength(1);
    recovery.stop();
  });

  it("leaves a running browser alone, and a released one when idle release was asked for", async () => {
    for (const [release, state] of [[false, "idle"], [true, "asleep"]] as const) {
      const { ctx, woke } = withBrowser(release, { state, restorePending: state === "asleep" });
      const recovery = startRuntimeRecovery(ctx, 60_000);
      await recovery.tick();
      expect(woke).toHaveLength(0);
      recovery.stop();
    }
  });
});

describe("image browser clients", () => {
  it("are disconnected only between tasks and outside a wake or restore", async () => {
    let drops = 0;
    let activeTurns: unknown[] = [];
    let queuedTurns = 0;
    let browserState = "awake";
    const ctx = makeCtx({ ready: true, running: true, codexReady: true }, { ensureRunning: 0, ensureSession: 0 }) as unknown as Record<string, any>;
    ctx.cfg = { sandbox: { autostart: true }, browser: { enabled: true, releaseWhenIdle: false } };
    ctx.container.dropImageCdpClients = async () => (drops++, ["python-server"]);
    ctx.agent.status = async () => ({ activeTurns, queuedTurns });
    ctx.browser = { observe: async () => undefined, wake: async () => undefined, status: () => ({ state: browserState, restorePending: false }) };
    const recovery = startRuntimeRecovery(ctx as unknown as AppContext, 60_000);
    await recovery.tick();
    expect(drops).toBe(1);
    activeTurns = [{ conversationId: "c" }];
    await recovery.tick();
    activeTurns = [];
    queuedTurns = 1;
    await recovery.tick();
    queuedTurns = 0;
    browserState = "restoring";
    await recovery.tick();
    expect(drops).toBe(1);
    recovery.stop();
  });
});
