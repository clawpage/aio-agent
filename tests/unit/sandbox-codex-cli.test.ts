import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxContainer } from "../../src/control/sandbox/container.js";
import type { SandboxNode } from "../../src/control/sandbox/node.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig } from "../helpers/harness.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** `installed`: the version already in the volume; "pinned" for the configured one. */
function setup(installed: string | null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-cli-"));
  dirs.push(dir);
  const cfg = testConfig(dir, 18080);
  const execs: { argv: string[]; user: string }[] = [];
  let version = installed === "pinned" ? cfg.sandbox.codexVersion : installed;
  const node = {
    exec: async (_name: string, req: { argv: string[]; user: string }) => {
      execs.push({ argv: req.argv, user: req.user });
      if (req.argv[0] === "npm") version = cfg.sandbox.codexVersion;
      if (req.argv[1] === "--version") return version ? { code: 0, stdout: `codex-cli ${version}\n`, stderr: "" } : { code: 127, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as SandboxNode;
  return { cfg, execs, container: new SandboxContainer(cfg, new Logger("error", undefined, false), node) };
}

describe("the pinned sandbox Codex CLI", () => {
  it("is what `codex` runs in the agent's shells, whether it was already there or just installed", async () => {
    for (const installed of [null, "0.1.0"]) {
      const { cfg, execs, container } = setup(installed);
      expect((await container.ensureCodexCli()).installed).toBe(true);
      expect(execs.at(-1)).toEqual({ argv: ["ln", "-sfn", cfg.sandbox.codexBin, "/opt/gem/bin/codex"], user: "root" });
    }
    const { cfg, execs, container } = setup("pinned");
    expect((await container.ensureCodexCli()).installed).toBe(false);
    expect(execs.map((e) => e.argv[0])).toEqual([cfg.sandbox.codexBin, "ln"]);
  });
});
