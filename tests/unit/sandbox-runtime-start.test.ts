import { expect, it, vi } from "vitest";
import { startSandboxRuntime } from "../../src/server/index.js";
import type { AppContext } from "../../src/server/context.js";
import { Logger } from "../../src/server/logger.js";
import { testConfig } from "../helpers/harness.js";

it("replaces an outdated tab server as soon as the sandbox is up, not at the next task", async () => {
  const cfg = testConfig("/tmp/pa-runtime-start", 1, { PA_SANDBOX_AUTOSTART: "1" });
  const ensure = vi.fn(async () => undefined);
  const ctx = {
    cfg, log: new Logger("error", undefined, false), sandboxSetupError: null, sandboxSurfaces: null,
    container: { ensureRunning: async () => ({ image: "img", healthy: true }), alignBrowserIdentity: async () => false, surfaces: async () => ({}) },
    agent: { ensureSession: async () => undefined },
    tabs: { ensure },
  } as unknown as AppContext;
  await startSandboxRuntime(ctx);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(ctx.sandboxSetupError).toBeNull();
});
