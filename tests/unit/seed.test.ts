import { describe, expect, it } from "vitest";
import { SandboxContainer } from "../../src/server/docker/sandbox.js";
import { CODEX_CONFIG_TOML, WORKSPACE_AGENTS_MD } from "../../src/server/docker/seed.js";
import { Logger } from "../../src/server/logger.js";
import { testConfig } from "../helpers/harness.js";

describe("sandbox workspace seed", () => {
  it("documents the project and scratch layout so artifacts do not land in the root", () => {
    for (const expected of [
      "/home/gem/workspace/projects/<name>/",
      ".scratch/tmp/<topic>/",
      ".scratch/tests/<topic>/",
      ".scratch/artifacts/<topic>/",
      "README.md",
    ]) {
      expect(WORKSPACE_AGENTS_MD, `template must document ${expected}`).toContain(expected);
    }
    // Screenshot examples must follow the same rule as every other artifact.
    expect(WORKSPACE_AGENTS_MD).not.toContain("/home/gem/workspace/screenshot.png");
    expect(WORKSPACE_AGENTS_MD).not.toContain("/home/gem/workspace/desktop.png");
    // ...and must be copy-pasteable: a concrete topic directory and an explicit
    // mkdir, never a literal `<topic>` placeholder that a shell would treat as a
    // redirection.
    expect(WORKSPACE_AGENTS_MD).toContain("mkdir -p /home/gem/workspace/.scratch/artifacts/example");
    expect(WORKSPACE_AGENTS_MD).not.toContain("artifacts/<topic>/screenshot.png");
    expect(WORKSPACE_AGENTS_MD).not.toContain("artifacts/<topic>/desktop.png");
  });

  it("enables Codex local memory by default without dropping the MCP registration", () => {
    expect(CODEX_CONFIG_TOML).toContain("[features]");
    expect(CODEX_CONFIG_TOML).toContain("memories = true");
    // The existing MCP registration must survive the new section.
    expect(CODEX_CONFIG_TOML).toContain("[mcp_servers.aio_browser]");
    expect(CODEX_CONFIG_TOML).toContain('url = "http://127.0.0.1:8080/mcp"');
  });

  it("writes AGENTS.md and config.toml only when absent so customisations survive", async () => {
    const cfg = testConfig("/tmp/pa-seed-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false));
    const calls: Array<{ path: string; content: string; opts: unknown }> = [];
    container.writeFileInSandbox = (async (filePath: string, content: string, opts?: unknown) => {
      calls.push({ path: filePath, content, opts });
    }) as typeof container.writeFileInSandbox;

    await container.seedWorkspace();

    const agents = calls.find((c) => c.path.endsWith("/AGENTS.md"));
    expect(agents?.opts).toMatchObject({ onlyIfAbsent: true });
    expect(agents?.content).toBe(WORKSPACE_AGENTS_MD);

    const toml = calls.find((c) => c.path.endsWith("/config.toml"));
    expect(toml?.opts).toMatchObject({ onlyIfAbsent: true });
    expect(toml?.content).toBe(CODEX_CONFIG_TOML);
  });
});
