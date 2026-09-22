import { describe, expect, it } from "vitest";
import { startRuntimeRecovery } from "../../src/server/index.js";
import { Logger } from "../../src/server/logger.js";
import type { AppContext } from "../../src/server/context.js";

interface Counters {
  ensureRunning: number;
  ensureSession: number;
}

function makeCtx(state: { ready: boolean; running: boolean; codexReady: boolean; fail?: boolean }, counters: Counters): AppContext {
  const container = {
    name: "personal-agent-sandbox",
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
