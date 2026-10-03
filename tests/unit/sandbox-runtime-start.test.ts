import { expect, it, vi } from "vitest";
import { startSandboxRuntime } from "../../src/control/index.js";
import type { AppContext } from "../../src/control/context.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig } from "../helpers/harness.js";

it("replaces an outdated tab server as soon as the sandbox is up, not at the next task", async () => {
  const cfg = testConfig("/tmp/pa-runtime-start", 1, { PA_SANDBOX_AUTOSTART: "1" });
  const ensure = vi.fn(async () => undefined);
  const ctx = {
    cfg, log: new Logger("error", undefined, false), sandboxSetupError: null, sandboxSurfaces: null,
    container: { node: { check: async () => ({ ok: true }) }, ensureRunning: async () => ({ image: "img", healthy: true }), alignBrowserIdentity: async () => false, surfaces: async () => ({}) },
    agent: { ensureSession: async () => undefined },
    tabs: { ensure },
    documents: { ensureProvisioned: async () => undefined },
  } as unknown as AppContext;
  await startSandboxRuntime(ctx);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(ctx.sandboxSetupError).toBeNull();
});

it("checks the document tools on every start, without waiting for them or failing with them", async () => {
  const cfg = testConfig("/tmp/pa-runtime-start", 1, { PA_SANDBOX_AUTOSTART: "1" });
  let release: (err: Error) => void = () => undefined;
  const ensureProvisioned = vi.fn(() => new Promise<void>((_, reject) => { release = reject; }));
  const order: string[] = [];
  const ctx = {
    cfg, log: new Logger("error", undefined, false), sandboxSetupError: null, sandboxSurfaces: null,
    container: { node: { check: async () => ({ ok: true }) }, ensureRunning: async () => { order.push("container"); return { image: "img", healthy: true }; }, alignBrowserIdentity: async () => false, surfaces: async () => ({}) },
    agent: { ensureSession: async () => { order.push("session"); } },
    documents: { ensureProvisioned: () => { order.push("documents"); return ensureProvisioned(); } },
  } as unknown as AppContext;
  // The install is still running when the start returns, session established.
  await startSandboxRuntime(ctx);
  expect(order).toEqual(["container", "documents", "session"]);
  expect(ctx.sandboxSetupError).toBeNull();
  release(new Error("apt-get update failed"));
  await new Promise((r) => setTimeout(r, 5));
  expect(ctx.sandboxSetupError).toBeNull();
  await startSandboxRuntime(ctx);
  expect(ensureProvisioned).toHaveBeenCalledTimes(2);
});
