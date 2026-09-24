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

  reserveTurn(): () => void {
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

  it("still runs the turn, and records it, when the browser cannot be restored", async () => {
    gate.readyError = "浏览器恢复失败";
    const conv = agent.createConversation({ title: "t" });
    agent.submitTurn({ conversationId: conv.id, text: "hi", clientMessageId: "m1" });
    await tick(60);
    codex.completeTurn(codex.startedTurns[0]!.turnId);
    await tick(80);
    // A text-only turn must not be failed by a browser it never needed...
    expect(codex.startedTurns.length).toBe(1);
    // ...but the browser problem must be visible rather than silently swallowed.
    const events = agent.listEvents(conv.id, 0);
    expect(events.some((e) => e.type === "turn.browser_unavailable")).toBe(true);
    // The lease is still released exactly once despite the failure.
    expect(gate.events.filter((e) => e === "release").length).toBe(1);
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
    expect(refusalReason({ ...base, lastErrorCode: "stop_failed" })).toContain("仍在运行");
    expect(refusalReason({ ...base })).toBeNull();
  });
});
