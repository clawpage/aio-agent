import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { BridgeModel } from "../../src/control/bridgeModel.js";
import { SandboxContainer } from "../../src/control/sandbox/container.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig, testNode } from "../helpers/harness.js";

const SECRET_VALUE = "sk-test-spawn-secret-value-0002";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pa-spawn-test-"));
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  delete process.env.AIO_MEMBER_MODEL_TOKEN;
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete process.env.AIO_MEMBER_MODEL_TOKEN;
});

/** The container with its node's streamed commands captured instead of sent. */
function capture(cfg: ReturnType<typeof testConfig>) {
  const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
  const calls: Array<{ name: string; argv: string[]; user: string; env?: Record<string, string> }> = [];
  vi.spyOn(container.node, "spawn").mockImplementation((name, req) => {
    calls.push({ name, ...req });
    return {} as ChildProcess;
  });
  return { container, calls };
}

describe("sandbox Codex launch with the bridge enabled", () => {
  it("defines the provider on the command line and keeps the key out of argv", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "secrets.env");
    fs.writeFileSync(file, `AIO_MEMBER_MODEL_TOKEN=${SECRET_VALUE}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const base = testConfig("/tmp/pa-spawn-bridge", 1);
    const cfg = {
      ...base,
      bridge: { ...base.bridge, enabled: "on", baseUrl: "http://host.docker.internal:4902/u/user_g/v1", models: ["gpt-6.1-sol"], secretsFile: file },
    };
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    const { container, calls } = capture(cfg);

    container.spawnCodexAppServer(["-c", 'approval_policy="on-request"'], bridge.providerEnv());

    expect(calls.length).toBe(1);
    const { name, argv, user, env } = calls[0]!;
    expect(name).toBe(cfg.sandbox.containerName);
    expect(user).toBe(cfg.sandbox.containerUser);
    // The value travels to the node beside argv, never inside it.
    expect(argv.join(" ")).not.toContain(SECRET_VALUE);
    expect(env?.AIO_MEMBER_MODEL_TOKEN).toBe(SECRET_VALUE);
    // The provider itself is defined by the -c overrides the session appends;
    // the launch helper must not have to know about them.
    expect(argv.join(" ")).not.toContain("model_providers");
  });

  it("leaves the ChatGPT-only command line unchanged when no key is available", () => {
    const cfg = testConfig("/tmp/pa-spawn-plain", 1);
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    const { container, calls } = capture(cfg);

    container.spawnCodexAppServer(["-c", 'approval_policy="on-request"'], bridge.providerEnv());

    const { argv, env } = calls[0]!;
    // The agent runs on the deployment's clock, not the image's TZ=Asia/Singapore.
    expect(argv.slice(0, 7)).toEqual(["env", `CODEX_HOME=${cfg.sandbox.containerCodexHome}`, "TZ=America/Los_Angeles", cfg.sandbox.codexBin, "app-server", "--listen", "stdio://"]);
    expect(argv.join(" ")).not.toContain("model_providers");
    expect(env?.AIO_MEMBER_MODEL_TOKEN).toBeUndefined();
    // The isolation flags still come last and stay intact.
    expect(argv.slice(-8)).toEqual([
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.remote_plugin=false",
      "-c",
      "apps._default.enabled=false",
    ]);
  });
});

describe("sandbox clock", () => {
  it("runs Claude Code on the deployment's zone and gives new sandboxes that zone", () => {
    const cfg = testConfig("/tmp/pa-spawn-tz", 1, { PA_BROWSER_TIMEZONE: "America/New_York" });
    const { container, calls } = capture(cfg);
    container.spawnClaude(["-p"], {});
    expect(calls[0]!.argv).toContain("TZ=America/New_York");
    expect(container.spec().extraEnv).toContain("TZ=America/New_York");
    // An operator's own TZ in PA_SANDBOX_EXTRA_ENV wins.
    const own = capture(testConfig("/tmp/pa-spawn-tz2", 1, { PA_SANDBOX_EXTRA_ENV: "BROWSER_NO_SANDBOX=--no-sandbox,TZ=Europe/Paris" }));
    expect(own.container.spec().extraEnv.filter((e) => e.startsWith("TZ="))).toEqual(["TZ=Europe/Paris"]);
  });
});
