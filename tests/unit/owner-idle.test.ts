import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initOwnerRuntime } from "../../src/control/index.js";
import { SandboxContainer } from "../../src/control/sandbox/container.js";
import type { SandboxNode } from "../../src/control/sandbox/node.js";
import type { AppContext } from "../../src/control/context.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig } from "../helpers/harness.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const config = (extra: Record<string, string> = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-idle-"));
  dirs.push(dir);
  return testConfig(dir, 18080, extra);
};

describe("owner sandbox idle stopping", () => {
  const owner = (state: { exists: boolean; running: boolean }, releaseWhenIdle = true) => {
    const calls: string[] = [];
    const cfg = config();
    const ctx = {
      cfg: { ...cfg, browser: { ...cfg.browser, enabled: false }, sandbox: { ...cfg.sandbox, autostart: true, releaseWhenIdle } },
      log: new Logger("error", undefined, false),
      container: { inspect: async () => { calls.push("inspect"); return state; } },
      agent: { init: async (o?: { cold?: boolean }) => { calls.push(o?.cold ? "agent.init cold" : "agent.init"); }, setSandboxGate: () => { calls.push("gate"); } },
      tasks: { init: () => { calls.push("tasks.init"); } },
    } as unknown as AppContext;
    return { ctx, calls };
  };

  it("is on by default", () => {
    expect(config().sandbox.releaseWhenIdle).toBe(true);
    expect(config({ PA_SANDBOX_RELEASE_IDLE: "0" }).sandbox.releaseWhenIdle).toBe(false);
  });

  it("leaves a container found stopped asleep at start, gated before queued work resumes", async () => {
    const asleep = owner({ exists: true, running: false });
    const idle = await initOwnerRuntime(asleep.ctx);
    expect(asleep.calls).toEqual(["inspect", "gate", "agent.init cold", "tasks.init"]);
    expect(idle?.state).toBe("parked");
    idle?.stop();
  });

  it("starts as before when the container is running, missing, or idle stopping is off", async () => {
    for (const state of [{ exists: true, running: true }, { exists: false, running: false }]) {
      const up = owner(state);
      expect(await initOwnerRuntime(up.ctx)).toBeNull();
      expect(up.calls).toEqual(["inspect", "agent.init", "tasks.init"]);
    }
    const resident = owner({ exists: true, running: false }, false);
    expect(await initOwnerRuntime(resident.ctx)).toBeNull();
    expect(resident.calls).toEqual(["agent.init", "tasks.init"]);
  });

  it("records member ports while stopped and applies them when the container next starts", async () => {
    const state = { exists: true, running: false };
    const applied: number[][] = [];
    const ensured: (number[] | undefined)[] = [];
    const node = {
      inspect: async () => state,
      peerPorts: async (_name: string, ports: number[]) => { applied.push([...ports]); },
      ensure: async (_name: string, req: { spec: { peerPorts?: number[] } }) => {
        ensured.push(req.spec.peerPorts);
        state.running = true;
        // A member created while the owner is starting: recorded after the spec was taken.
        await container.protectMemberPorts([18083]);
      },
    } as unknown as SandboxNode;
    const container = new SandboxContainer(config(), new Logger("error", undefined, false), node);
    Object.assign(container, { ensureCodexCli: async () => {}, seedWorkspace: async () => {}, waitSurfaces: async () => {} });
    await container.protectMemberPorts([18081, 18082]);
    expect(applied).toEqual([]);
    await container.ensureRunning();
    expect(ensured).toEqual([[18081, 18082]]);
    // Applied inside the running container by the call itself, and once more after start covering all three.
    expect(applied).toEqual([[18081, 18082, 18083], [18081, 18082, 18083]]);
    await container.protectMemberPorts([18084]);
    expect(applied.at(-1)).toEqual([18081, 18082, 18083, 18084]);
  });
});
