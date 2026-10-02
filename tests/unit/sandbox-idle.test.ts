import { describe, expect, it } from "vitest";
import { SandboxIdle } from "../../src/control/docker/idle.js";
import { startRuntimeRecovery } from "../../src/control/index.js";
import { Logger } from "../../src/control/logger.js";
import type { AppContext } from "../../src/control/context.js";

const IDLE = 300_000;

function setup() {
  const clock = { now: 1_000_000 };
  const world = {
    running: true,
    activeTurns: 0,
    queuedTurns: 0,
    approvals: 0,
    activeTask: false,
    leases: { turns: 0, viewers: 0, calls: 0, holds: 0, pins: 0 },
    shell: [] as string[],
    cpu: 1 as number | null,
    sleepVerdict: "asleep",
    restorePending: false,
    calls: [] as string[],
    onSleep: () => {},
  };
  const ctx = {
    cfg: { browser: { enabled: true }, sandbox: { autostart: true } },
    log: new Logger("error", undefined, false),
    agent: {
      status: async () => ({ activeTurns: Array.from({ length: world.activeTurns }, () => ({})), queuedTurns: world.queuedTurns }),
      listPendingRequests: () => Array.from({ length: world.approvals }, () => ({})),
    },
    db: { prepare: () => ({ get: () => (world.activeTask ? { 1: 1 } : undefined) }) },
    browser: {
      leases: () => world.leases,
      sleepNow: async () => {
        world.calls.push("sleep");
        world.onSleep();
        return { verdict: world.sleepVerdict };
      },
      status: () => ({ state: world.sleepVerdict === "asleep" ? "asleep" : "awake", restorePending: world.restorePending }),
    },
    aio: { get: async () => ({ data: { sessions: Object.fromEntries(world.shell.map((status, i) => [`s${i}`, { status }])) } }) },
    container: {
      inspect: async () => ({ exists: true, running: world.running }),
      isReady: async () => world.running,
      cpuPercent: async () => world.cpu,
      stop: async () => {
        world.calls.push("stop");
        world.running = false;
      },
    },
    sandboxSetupError: null,
    sandboxSurfaces: { terminal: true },
  } as unknown as AppContext;
  const idle = new SandboxIdle({
    ctx,
    idleMs: IDLE,
    now: () => clock.now,
    start: async () => {
      world.calls.push("start");
      world.running = true;
    },
  });
  ctx.idle = idle;
  return { clock, world, ctx, idle };
}

describe("whole-container idle stop", () => {
  it("stops the container after five quiet minutes, browser snapshot first", async () => {
    const { clock, world, ctx, idle } = setup();
    await idle.tick();
    expect(world.calls).toEqual([]);
    clock.now += IDLE - 1;
    await idle.tick();
    expect(world.calls).toEqual([]);
    clock.now += 1;
    await idle.tick();
    expect(world.calls).toEqual(["sleep", "stop"]);
    expect(idle.state).toBe("parked");
    expect(ctx.sandboxSurfaces).toBeNull();
  });

  it("counts the console in the foreground as use, for its heartbeat TTL", async () => {
    const { clock, world, idle } = setup();
    clock.now += IDLE;
    idle.foreground();
    clock.now += 59_000;
    await idle.tick();
    expect(world.calls).toEqual([]);
    // The buffer runs from the last heartbeat that was still fresh.
    clock.now += IDLE;
    await idle.tick();
    expect(world.calls).toEqual(["sleep", "stop"]);
  });

  it.each([
    ["turns", (w: ReturnType<typeof setup>["world"]) => { w.activeTurns = 1; }],
    ["queued turns", (w: ReturnType<typeof setup>["world"]) => { w.queuedTurns = 1; }],
    ["approvals", (w: ReturnType<typeof setup>["world"]) => { w.approvals = 1; }],
    ["planning tasks", (w: ReturnType<typeof setup>["world"]) => { w.activeTask = true; }],
    ["browser leases", (w: ReturnType<typeof setup>["world"]) => { w.leases = { ...w.leases, viewers: 1 }; }],
  ])("keeps the container while there are %s", async (_name, busy) => {
    const { clock, world, idle } = setup();
    busy(world);
    clock.now += IDLE * 2;
    await idle.tick();
    expect(world.calls).toEqual([]);
    expect(idle.state).toBe("running");
  });

  it("keeps the container for a proxied request in flight, and counts from its end", async () => {
    const { clock, world, idle } = setup();
    const release = idle.hold();
    clock.now += IDLE * 2;
    await idle.tick();
    expect(world.calls).toEqual([]);
    release();
    clock.now += IDLE - 1;
    await idle.tick();
    expect(world.calls).toEqual([]);
  });

  it.each([
    ["a running shell command", (w: ReturnType<typeof setup>["world"]) => { w.shell = ["completed", "running"]; }],
    ["a command still running past its output timeout", (w: ReturnType<typeof setup>["world"]) => { w.shell = ["no_change_timeout"]; }],
    ["CPU use outside the browser", (w: ReturnType<typeof setup>["world"]) => { w.cpu = 40; }],
    ["an unknown CPU reading", (w: ReturnType<typeof setup>["world"]) => { w.cpu = null; }],
  ])("checks inside the container before stopping: %s keeps it", async (_name, busy) => {
    const { clock, world, idle } = setup();
    busy(world);
    clock.now += IDLE;
    await idle.tick();
    expect(world.calls).toEqual([]);
    // Found busy: the buffer starts over.
    world.shell = [];
    world.cpu = 1;
    clock.now += IDLE - 1;
    await idle.tick();
    expect(world.calls).toEqual([]);
  });

  it("does not stop when the browser could not be snapshotted", async () => {
    const { clock, world, idle } = setup();
    world.sleepVerdict = "error";
    clock.now += IDLE;
    await idle.tick();
    expect(world.calls).toEqual(["sleep"]);
    expect(idle.state).toBe("running");
  });

  it("stops anyway when the browser holds back only for a snapshot still waiting to be restored", async () => {
    const { clock, world, idle } = setup();
    world.sleepVerdict = "blocked";
    world.restorePending = true;
    clock.now += IDLE;
    await idle.tick();
    expect(world.calls).toEqual(["sleep", "stop"]);
    expect(idle.state).toBe("parked");
  });

  it("cancels the stop when someone arrives during the snapshot", async () => {
    const { clock, world, idle } = setup();
    world.onSleep = () => { clock.now += 1; idle.foreground(); };
    clock.now += IDLE;
    await idle.tick();
    expect(world.calls).toEqual(["sleep"]);
    expect(idle.state).toBe("running");
  });

  it("refuses a hidden tab's reconnect while stopped, and starts again for a page load", async () => {
    const { clock, world, idle } = setup();
    clock.now += IDLE;
    await idle.tick();
    expect(await idle.enter(false)).toBe(false);
    expect(world.calls).toEqual(["sleep", "stop"]);
    expect(await idle.enter(true)).toBe(true);
    expect(world.calls).toEqual(["sleep", "stop", "start"]);
    expect(idle.state).toBe("running");
    // Once running, every request is admitted.
    expect(await idle.enter(false)).toBe(true);
  });

  it("starts warming up when the console comes back to the foreground", async () => {
    const { clock, world, idle } = setup();
    clock.now += IDLE;
    await idle.tick();
    idle.foreground();
    await idle.wake();
    expect(world.calls).toEqual(["sleep", "stop", "start"]);
    // Woken use starts a fresh buffer rather than stopping again at once.
    clock.now += 61_000;
    await idle.tick();
    expect(world.calls).toEqual(["sleep", "stop", "start"]);
  });

  it("starts once for concurrent wakes", async () => {
    const { clock, world, idle } = setup();
    clock.now += IDLE;
    await idle.tick();
    await Promise.all([idle.wake(), idle.wake(), idle.enter(true)]);
    expect(world.calls.filter((c) => c === "start")).toHaveLength(1);
  });

  it("keeps the recovery loop from restarting a container stopped for idleness", async () => {
    const { clock, world, ctx, idle } = setup();
    clock.now += IDLE;
    await idle.tick();
    const recovery = startRuntimeRecovery(ctx, 60_000);
    await recovery.tick();
    recovery.stop();
    expect(world.running).toBe(false);
    expect(world.calls).toEqual(["sleep", "stop"]);
  });
});
