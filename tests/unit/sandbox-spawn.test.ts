import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeModel } from "../../src/control/bridgeModel.js";
import { Logger } from "../../src/control/logger.js";
import { testConfig } from "../helpers/harness.js";

const SECRET_VALUE = "sk-test-spawn-secret-value-0002";
const spawnCalls: Array<{ command: string; args: string[]; env: Record<string, string> | undefined }> = [];

// Intercept the docker CLI launch so the real argv and child environment can be
// inspected. Nothing is executed.
vi.mock("node:child_process", async (importOriginal) => {
  // Keep the real module's other exports (the container uses `execFile`), and
  // only intercept the spawn that launches the sandbox Codex process.
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options?: { env?: Record<string, string> }) => {
      spawnCalls.push({ command, args, env: options?.env });
      return { stdin: null, stdout: null, stderr: null, on: () => undefined, kill: () => undefined };
    },
  };
});

const { SandboxContainer } = await import("../../src/control/docker/sandbox.js");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pa-spawn-test-"));
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  spawnCalls.length = 0;
  delete process.env.LITELLM_MASTER_KEY;
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete process.env.LITELLM_MASTER_KEY;
});

describe("sandbox Codex launch with the bridge enabled", () => {
  it("defines the provider on the command line and keeps the key out of argv", () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "secrets.env");
    fs.writeFileSync(file, `LITELLM_MASTER_KEY=${SECRET_VALUE}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const cfg = testConfig("/tmp/pa-spawn-bridge", 1, { PA_OPENCODE_GO_SECRETS_FILE: file });
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false));

    container.spawnCodexAppServer(["-c", 'approval_policy="on-request"'], bridge.providerEnv());

    expect(spawnCalls.length).toBe(1);
    const { command, args, env } = spawnCalls[0]!;
    expect(command).toBe("docker");
    const argv = args.join(" ");
    // Docker's own -e only names the variable; the value never reaches argv.
    expect(argv).toContain("-e LITELLM_MASTER_KEY");
    expect(argv).not.toContain(SECRET_VALUE);
    expect(env?.LITELLM_MASTER_KEY).toBe(SECRET_VALUE);
    // The provider itself is defined by the -c overrides the session appends;
    // the launch helper must not have to know about them.
    expect(argv).not.toContain("model_providers");
  });

  it("leaves the ChatGPT-only command line unchanged when no key is available", () => {
    const cfg = testConfig("/tmp/pa-spawn-plain", 1, { PA_OPENCODE_GO_SECRETS_FILE: "/nonexistent/secrets.env" });
    const bridge = new BridgeModel(cfg, new Logger("error", undefined, false));
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false));

    container.spawnCodexAppServer(["-c", 'approval_policy="on-request"'], bridge.providerEnv());

    const { args, env } = spawnCalls[0]!;
    const argv = args.join(" ");
    expect(argv).not.toContain("model_providers");
    expect(argv).not.toContain("-e ");
    expect(argv).not.toContain("LITELLM_MASTER_KEY");
    expect(env?.LITELLM_MASTER_KEY).toBeUndefined();
    // The isolation flags still come last and stay intact.
    expect(args.slice(-8)).toEqual([
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
