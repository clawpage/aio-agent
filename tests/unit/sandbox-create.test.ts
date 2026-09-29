import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxContainer } from "../../src/server/docker/sandbox.js";
import { Logger } from "../../src/server/logger.js";
import { testConfig } from "../helpers/harness.js";

it("hands the fresh browser volume to the sandbox user before the first boot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-create-test-"));
  try {
    const cfg = testConfig(dir, 18999);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false));
    const calls: string[][] = [];
    vi.spyOn(container, "docker").mockImplementation(async (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    });
    await container.create();
    const chown = calls.findIndex((a) => a[0] === "run" && a.includes("chown"));
    const boot = calls.findIndex((a) => a[0] === "run" && a[1] === "-d");
    expect(chown).toBeGreaterThanOrEqual(0);
    expect(chown).toBeLessThan(boot);
    expect(calls[chown]).toEqual(expect.arrayContaining(["--network", "none", `${cfg.sandbox.browserVolume}:/v`, "1000:1000", "/v"]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
