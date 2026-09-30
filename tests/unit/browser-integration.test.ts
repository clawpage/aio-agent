import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, type Db } from "../../src/server/db.js";
import { Logger } from "../../src/server/logger.js";
import { AgentManager, type BrowserGateLike } from "../../src/server/codex/manager.js";
import { FakeCodex, testConfig } from "../helpers/harness.js";
import type { HostTokenSource } from "../../src/server/codex/hostTokens.js";
import { shouldProtectBrowser } from "../../src/server/http/proxy.js";
import { isBrowserBoundPath, isStaticAssetPath } from "../../src/server/browser/service.js";
import { BrowserViewerController } from "../../src/web/src/browserViewer.js";
import {
  describeOccupancy,
  idleCountdownText,
  needsRestore,
  refusalReason,
  statusTone,
} from "../../src/web/src/browserStatusView.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * A browser gate that records the exact order of reserve/ready/release, so the
 * "reserve before any await, release in the turn's finally" contract can be
 * asserted rather than assumed.
 */
class RecordingGate implements BrowserGateLike {
  events: string[] = [];
  /** Held open so a test can observe the in-flight turn state. */
  readyGate: Promise<void> | null = null;
  readyError: string | null = null;
  /** Set to reject the reserve itself, as a broken runtime would. */
  reserveError: string | null = null;
  /** A manually controlled ready() wait. */
  #readyRelease: (() => void) | null = null;

  reserveTurn(): () => void {
    if (this.reserveError) throw new Error(this.reserveError);
    this.events.push("reserve");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.events.push("release");
    };
  }

  async ready(): Promise<void> {
    this.events.push("ready");
    if (this.readyGate) await this.readyGate;
    if (this.readyError) throw new Error(this.readyError);
  }

  /** Block the next ready() call until releaseReady() is called. */
  holdReady(): void {
    this.readyGate = new Promise<void>((resolve) => {
      this.#readyRelease = resolve;
    });
  }

  releaseReady(): void {
    this.readyGate = null;
    this.#readyRelease?.();
    this.#readyRelease = null;
  }
}

function makeManager(gate: BrowserGateLike | null, extraEnv: Record<string, string> = {}): { agent: AgentManager; codex: FakeCodex; db: Db } {
  const codex = new FakeCodex();
  const cfg = testConfig("/tmp/pa-browser-integration", 1, extraEnv);
  const db = openDb(":memory:");
  const hostTokens = { status: async () => ({ ok: true, authMethod: "chatgpt", email: null, planType: null, expiresAt: null, error: null }) } as unknown as HostTokenSource;
  const agent = new AgentManager({ cfg, db, log: new Logger("error", undefined, false), codex, hostTokens, browser: gate });
  return { agent, codex, db };
}

describe("AgentManager browser lease", () => {
  let agent: AgentManager;
  let codex: FakeCodex;
  let db: Db;
  let gate: RecordingGate;

  beforeEach(async () => {
    gate = new RecordingGate();
    ({ agent, codex, db } = makeManager(gate));
    await agent.init();
  });

  afterEach(() => {
    agent.shutdown();
    db.close();
  });

  it("executes a non-browser task even when browser recovery is broken", async () => {
    gate.readyError = "浏览器恢复失败";
    const conv = agent.createConversation({title:"普通问候"});
    const {turn} = agent.submitTurn({conversationId:conv.id,text:"hi",clientMessageId:"no-browser",requiresBrowser:false});
    await tick(80);
    expect(turn.browser_required).toBe(0);
    expect(gate.events).not.toContain("ready");
    expect(codex.startedTurns).toHaveLength(1);
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(db.prepare("SELECT status FROM turns WHERE id=?").get(turn.id)?.status).toBe("completed");
    expect(gate.events.filter(e=>e==="release")).toHaveLength(1);
  });

  it("gates newly requested browser work before steering a previously independent task", async () => {
    const steers: unknown[] = [];
    Object.assign(codex, {steerTurn: async (p:unknown)=>{steers.push(p);}});
    const conv = agent.createConversation({title:"任务"});
    const {turn} = agent.submitTurn({conversationId:conv.id,text:"整理文字",clientMessageId:"upgrade-browser",requiresBrowser:false});
    await tick(80);
    gate.readyError="恢复失败";
    expect(await agent.appendTurnInput(conv.id,turn.id,"再看网页",[],true)).toBe("browser_unavailable");
    expect(steers).toHaveLength(0);
    expect(db.prepare("SELECT status,browser_required FROM turns WHERE id=?").get(turn.id)).toMatchObject({status:"running",browser_required:0});
    gate.readyError=null;
    expect(await agent.appendTurnInput(conv.id,turn.id,"再看网页",[],true)).toBe("accepted");
    expect(steers).toHaveLength(1);
    expect(db.prepare("SELECT browser_required FROM turns WHERE id=?").get(turn.id)?.browser_required).toBe(1);
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(50);
  });

  it("reserves the browser before the turn starts and releases it after", async () => {
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(60);
    expect(gate.events[0]).toBe("reserve");
    expect(gate.events).toContain("ready");
    // Completing the turn is what ends the lease.
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(gate.events).toContain("release");
    expect(gate.events.indexOf("reserve")).toBeLessThan(gate.events.indexOf("ready"));
    expect(gate.events.indexOf("ready")).toBeLessThan(gate.events.indexOf("release"));
  });

  it("holds the lease for the whole turn, not just the start", async () => {
    const conv = agent.createConversation({ title: "t" });
    // Hold the turn open: it stays "running" until the test releases it, which is
    // exactly the window a browser tool would be called in.
    codex.holdTurn("thread_1");
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(60);
    expect(gate.events).toContain("ready");
    expect(gate.events).not.toContain("release");
    codex.releaseTurn("thread_1");
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(gate.events).toContain("release");
  });

  it("releases the lease when the turn throws, including a startup failure", async () => {
    const conv = agent.createConversation({ title: "t" });
    codex.failStart = true;
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(80);
    expect(gate.events).toContain("reserve");
    expect(gate.events).toContain("release");
  });

  it("does not dispatch the turn when the browser cannot be restored", async () => {
    // The sandbox MCP reaches the browser without passing the companion proxy, so
    // the proxy gate cannot protect a turn that started anyway. A failed restore
    // must therefore stop the turn from being dispatched at all, and say so.
    gate.readyError = "浏览器恢复失败";
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(80);
    expect(codex.startedTurns.length).toBe(0);
    const events = agent.listEvents(conv.id, 0);
    expect(events.some((e) => e.type === "turn.browser_unavailable")).toBe(true);
    // The failed turn is terminal, and the lease is released exactly once.
    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
    expect(gate.events.filter((e) => e === "release").length).toBe(1);
  });

  it("does not dispatch a turn the user already stopped while the browser restored", async () => {
    // A stop that lands during the restore wait must be honoured *before* the
    // first side-effecting request, not by interrupting a turn already running.
    gate.holdReady();
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(30);
    expect(gate.events).toContain("ready");
    await agent.interrupt(conv.id);
    gate.releaseReady();
    await tick(80);
    expect(codex.startedTurns.length).toBe(0);
    const events = agent.listEvents(conv.id, 0);
    // The turn is terminal (interrupted/failed) without ever reaching Codex.
    expect(
      events.some(
        (e) =>
          e.type === "turn.failed" ||
          (e.type === "turn.finished" && (e.payload as { status?: string })?.status === "interrupted"),
      ),
    ).toBe(true);
    expect(gate.events.filter((e) => e === "release").length).toBe(1);
  });

  it("releases the slot when reserving the browser lease itself throws", async () => {
    // A throwing reserve must not leak an activeTurns slot: the next turn has to
    // be able to run.
    gate.reserveError = "reserve exploded";
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(80);
    const events = agent.listEvents(conv.id, 0);
    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
    gate.reserveError = null;
    agent.submitTurn({ conversationId: conv.id, text: "again", clientMessageId: "m2" });
    await tick(80);
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    expect(codex.startedTurns.length).toBe(1);
  });

  it("does not reserve anything when no browser gate is configured", async () => {
    const plain = makeManager(null);
    await plain.agent.init();
    const conv = plain.agent.createConversation({ title: "t" });
    plain.agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(60);
    expect(plain.codex.startedTurns.length).toBe(1);
    plain.agent.shutdown();
    plain.db.close();
  });
});

describe("proxy browser-bound path classification", () => {
  it("protects real browser/CDP/VNC traffic", () => {
    for (const path of [
      "/api/v1/browser/tabs",
      "/v1/browser/tabs",
      "/browser",
      "/browser-ui",
      "/cdp",
      "/json/list",
      "/json/version",
      "/vnc/vnc.html",
      "/websockify",
      // The workspace VNC panel opens the raw websocket at path `ws`; without it
      // a directly-opened VNC stream is not protected and can be released while
      // the user is watching.
      "/ws",
      // Companion-domain screenshot/input operations.
      "/v1/display",
      "/v1/display/screenshot",
    ]) {
      expect(isBrowserBoundPath(path), path).toBe(true);
      expect(shouldProtectBrowser(path), path).toBe(true);
    }
  });

  it("never protects terminal, file, editor, notebook or API traffic", () => {
    for (const path of [
      "/terminal",
      "/v1/shell/exec",
      "/api/files/list",
      "/code-server/",
      "/jupyter/lab",
      "/health",
      "/",
      // Terminal/Jupyter websockets share the `ws` vocabulary but are not the
      // browser: `/v1/shell/ws` must stay unprotected.
      "/v1/shell/ws",
      "/api/v1/shell/ws",
    ]) {
      expect(isBrowserBoundPath(path), path).toBe(false);
      expect(shouldProtectBrowser(path), path).toBe(false);
    }
  });

  it("does not let an iframe's static assets hold the browser awake", () => {
    // A browser panel legitimately loads its own bundle: those requests must not
    // each hold a lease or a long-lived page would keep the browser up forever.
    for (const path of ["/browser-ui/main.js", "/browser-ui/style.css", "/vnc/app.js", "/json/logo.png"]) {
      expect(isBrowserBoundPath(path), path).toBe(true);
      expect(isStaticAssetPath(path), path).toBe(true);
      expect(shouldProtectBrowser(path), path).toBe(false);
    }
  });

  it("ignores a missing or malformed url", () => {
    expect(shouldProtectBrowser(undefined)).toBe(false);
    expect(shouldProtectBrowser("")).toBe(false);
  });
});

describe("BrowserViewerController", () => {
  /** A transport that records heartbeats and can reject them on demand. */
  function transport() {
    const heartbeats: Array<{ id: string; generation: number }> = [];
    const releases: string[] = [];
    let staleBelow = 0;
    let failNext = false;
    return {
      heartbeats,
      releases,
      setStaleBelow: (g: number) => {
        staleBelow = g;
      },
      failOnce: () => {
        failNext = true;
      },
      transport: {
        heartbeat: async (id: string, generation: number) => {
          heartbeats.push({ id, generation });
          if (failNext) {
            failNext = false;
            return { kind: "error" as const, message: "网络错误" };
          }
          if (generation <= staleBelow) return { kind: "stale" as const };
          return { kind: "ok" as const, generation };
        },
        release: async (id: string) => {
          releases.push(id);
        },
      },
    };
  }

  it("claims only while the document is visible", async () => {
    const t = transport();
    let visible: "visible" | "hidden" = "hidden";
    const controller = new BrowserViewerController({
      transport: t.transport,
      heartbeatMs: 0,
      visibilityState: () => visible,
    });
    expect(await controller.claim()).toBe(0);
    expect(t.heartbeats.length).toBe(0);
    visible = "visible";
    expect(await controller.claim()).toBeGreaterThan(0);
    expect(t.heartbeats.length).toBe(1);
  });

  it("makes a late heartbeat unable to resurrect a released lease", async () => {
    const t = transport();
    const controller = new BrowserViewerController({ transport: t.transport, heartbeatMs: 0, visibilityState: () => "visible" });
    const generation = await controller.claim();
    expect(controller.held).toBe(true);
    await controller.release();
    expect(controller.held).toBe(false);
    expect(controller.isCurrent(generation)).toBe(false);
    // A heartbeat that started before the release and lands after it is rejected.
    expect(controller.isCurrent(controller.generation)).toBe(false);
  });

  it("gives each window its own id and generation", async () => {
    const t = transport();
    const a = new BrowserViewerController({ transport: t.transport, heartbeatMs: 0, visibilityState: () => "visible" });
    const b = new BrowserViewerController({ transport: t.transport, heartbeatMs: 0, visibilityState: () => "visible" });
    expect(a.id).not.toBe(b.id);
    await Promise.all([a.claim(), b.claim()]);
    expect(new Set(t.heartbeats.map((h) => h.id)).size).toBe(2);
  });

  it("moves past a server tombstone once instead of looping", async () => {
    const t = transport();
    t.setStaleBelow(1);
    const controller = new BrowserViewerController({ transport: t.transport, heartbeatMs: 0, visibilityState: () => "visible" });
    const generation = await controller.claim();
    expect(generation).toBeGreaterThan(0);
    expect(controller.held).toBe(true);
    expect(t.heartbeats.length).toBe(2);
  });

  it("does not report holding a lease when the heartbeat fails", async () => {
    const t = transport();
    t.failOnce();
    const controller = new BrowserViewerController({ transport: t.transport, heartbeatMs: 0, visibilityState: () => "visible" });
    expect(await controller.claim()).toBe(0);
    expect(controller.held).toBe(false);
  });

  it("dispose releases the lease and never throws without one", async () => {
    const t = transport();
    const controller = new BrowserViewerController({ transport: t.transport, heartbeatMs: 0, visibilityState: () => "visible" });
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
    await controller.claim();
    expect(t.releases.length).toBe(0);
  });

  it("does not send releases for an unopened panel or repeat an already released lease", async () => {
    const t = transport();
    const controller = new BrowserViewerController({ transport: t.transport, heartbeatMs: 0, visibilityState: () => "visible" });
    await controller.release();
    await controller.release();
    expect(t.releases).toHaveLength(0);
    await controller.claim();
    await controller.release();
    await controller.release();
    controller.dispose();
    expect(t.releases).toHaveLength(1);
  });

  it("still releases a first heartbeat while its reply is pending", async () => {
    let finish!: (value: {kind: "ok"; generation: number}) => void;
    const releases: number[] = [];
    const controller = new BrowserViewerController({ heartbeatMs: 0, visibilityState: () => "visible", transport: {
      heartbeat: () => new Promise(resolve => { finish = resolve; }),
      release: async (_id, generation) => { releases.push(generation); },
    } });
    const claim = controller.claim();
    const generation = controller.generation;
    await controller.release();
    finish({kind: "ok", generation});
    expect(await claim).toBe(0);
    expect(releases).toEqual([generation]);
    expect(controller.held).toBe(false);
  });
});

describe("browser status view derivation", () => {
  const base = {
    enabled: true,
    state: "awake",
    stateLabel: "浏览器已就绪",
    idleDeadline: null,
    idleRemainingMs: null,
    idleMinutes: null,
    since: 0,
    epoch: 1,
    leases: { turns: 0, viewers: 0, calls: 0, holds: 0, pins: 0 },
    viewers: 0,
    holds: 0,
    pins: [],
    held: false,
    browserRunning: true,
    snapshotAt: null,
    restoredSnapshotAt: null,
    restorePending: false,
    lastError: null,
    lastErrorCode: null,
    lastSnapshotWarnings: [],
    unrestoredTabCount: null,
  };

  it("never asks to restore a sleeping browser while it is held", () => {
    expect(needsRestore({ ...base })).toBe(false);
    expect(needsRestore({ ...base, state: "asleep" })).toBe(true);
    expect(needsRestore({ ...base, state: "restoring" })).toBe(true);
    expect(needsRestore({ ...base, state: "snapshotting" })).toBe(true);
    // Unknown attribution alone must not block the panel: the proxy can still try.
    expect(needsRestore({ ...base, browserRunning: null })).toBe(false);
    expect(needsRestore({ ...base, enabled: false, state: "asleep" })).toBe(false);
  });

  it("names every occupancy reason", () => {
    expect(describeOccupancy({ ...base, leases: { ...base.leases, turns: 2, viewers: 1 } })).toContain("任务 2");
    expect(describeOccupancy({ ...base, leases: { ...base.leases, turns: 2, viewers: 1 } })).toContain("观看 1");
    expect(describeOccupancy({ ...base, leases: { ...base.leases, calls: 3 } })).toContain("进行中的浏览器请求 3");
    expect(describeOccupancy({ ...base, leases: { ...base.leases, pins: 1 } })).toContain("手动保留 1");
    expect(describeOccupancy({ ...base })).toContain("没有占用");
    expect(describeOccupancy({ ...base, enabled: false })).toContain("已关闭");
    // A resident browser with nothing holding it is not waiting to be released.
    expect(describeOccupancy({ ...base, resident: true })).toBe("常驻，登录状态一直保留");
  });

  it("formats the idle countdown and clamps at zero", () => {
    expect(idleCountdownText({ ...base, idleRemainingMs: 65_000 })).toBe("1:05");
    expect(idleCountdownText({ ...base, idleRemainingMs: 0 })).toBe("即将释放");
    expect(idleCountdownText({ ...base, idleRemainingMs: null })).toBeNull();
    expect(idleCountdownText({ ...base, enabled: false, idleRemainingMs: 65_000 })).toBeNull();
  });

  it("tones each state and explains a refusal without leaking a url", () => {
    expect(statusTone(null)).toBe("off");
    expect(statusTone({ ...base })).toBe("ok");
    expect(statusTone({ ...base, state: "idle" })).toBe("warn");
    expect(statusTone({ ...base, state: "restoring" })).toBe("busy");
    expect(statusTone({ ...base, state: "error" })).toBe("error");
    const blocked = refusalReason({ ...base, lastErrorCode: "snapshot_blocked", unrestoredTabCount: 2 });
    expect(blocked).toContain("2 个页面");
    expect(refusalReason({ ...base, lastErrorCode: "snapshot_blocked", lastError: "页面有未提交的输入，已保留浏览器" })).toContain("未提交的输入");
    expect(refusalReason({ ...base, lastErrorCode: "stop_failed" })).toContain("仍在运行");
    expect(refusalReason({ ...base })).toBeNull();
  });
});

it('ignores a stale held heartbeat after release and rejoin', async () => {
  let call=0;
  let finish!: (value: {kind:'stale'})=>void;
  const viewer=new BrowserViewerController({
    id:'race', visibilityState:()=> 'visible',
    transport:{heartbeat:async()=>{call++; if(call===2)return new Promise(resolve=>{finish=resolve});return {kind:'ok',generation:call}},release:async()=>{}},
  });
  await viewer.claim();
  const old=viewer.claim();
  await viewer.release();
  const current=await viewer.claim();
  finish({kind:'stale'}); await old;
  expect(viewer.isCurrent(current)).toBe(true);
  await viewer.dispose();
});
