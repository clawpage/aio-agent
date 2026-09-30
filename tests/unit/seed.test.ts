import { describe, expect, it, vi } from "vitest";
import { SandboxContainer } from "../../src/server/docker/sandbox.js";
import { CODEX_CONFIG_TOML, DOCUMENT_SKILL_DIR, DOCUMENT_SKILL_MD, SHARE_CLI_PY, SHARE_SKILL_MD, WORKSPACE_AGENTS_MD } from "../../src/server/docker/seed.js";
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
    const isolation = vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
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
    expect(isolation).toHaveBeenCalledOnce();
  });

  it("writes the document skill into the controlled skills directory for existing sandboxes too", async () => {
    const cfg = testConfig("/tmp/pa-skill-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false));
    vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
    const calls: Array<{ path: string; content: string; opts: unknown }> = [];
    container.writeFileInSandbox = (async (filePath: string, content: string, opts?: unknown) => {
      calls.push({ path: filePath, content, opts });
    }) as typeof container.writeFileInSandbox;
    // `cat >` cannot create a missing parent, so the skill directory must be
    // created first or a fresh sandbox would never receive the skill.
    const execCalls: string[][] = [];
    container.execInSandbox = (async (argv: string[]) => {
      execCalls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    }) as typeof container.execInSandbox;

    await container.seedWorkspace();

    const skill = calls.find((c) => c.path.endsWith(`/${DOCUMENT_SKILL_DIR}/SKILL.md`));
    expect(skill).toBeDefined();
    expect(skill?.content).toBe(DOCUMENT_SKILL_MD);
    // Managed, not `onlyIfAbsent`: a tool-path change must reach existing
    // sandboxes. AGENTS.md/config.toml keep the user's own edits, this does not
    // overwrite any other skill.
    expect(skill?.opts ?? {}).not.toMatchObject({ onlyIfAbsent: true });
    expect(execCalls.some((argv) => argv[0] === "mkdir" && argv[1] === "-p" && argv[2].endsWith(DOCUMENT_SKILL_DIR))).toBe(
      true,
    );
  });

  it("gives both executors the share skill, the CLI and this runtime's token only when sharing is provisioned", async () => {
    const seed = async (share?: { endpoint: string; token: string }) => {
      const cfg = { ...testConfig("/tmp/pa-share-seed-test", 1), share };
      const container = new SandboxContainer(cfg, new Logger("error", undefined, false));
      vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
      const calls: Array<{ path: string; content: string }> = [];
      container.writeFileInSandbox = (async (filePath: string, content: string) => {
        calls.push({ path: filePath, content });
      }) as typeof container.writeFileInSandbox;
      const execCalls: string[][] = [];
      container.execInSandbox = (async (argv: string[]) => (execCalls.push(argv), { code: 0, stdout: "", stderr: "" })) as typeof container.execInSandbox;
      await container.seedWorkspace();
      return { cfg, calls, execCalls };
    };
    const none = await seed();
    expect(none.calls.some((c) => c.path.includes("aio-share"))).toBe(false);

    const share = { endpoint: "http://host.docker.internal:4902/share/owner_1", token: "a".repeat(64) };
    const { cfg, calls, execCalls } = await seed(share);
    const skills = calls.filter((c) => c.path.endsWith("/skills/aio-share/SKILL.md"));
    expect(skills.map((c) => c.path).sort()).toEqual([
      `${cfg.claudeCode.configDir}/skills/aio-share/SKILL.md`,
      `${cfg.sandbox.containerCodexHome}/skills/aio-share/SKILL.md`,
    ].sort());
    for (const s of skills) expect(s.content).toBe(SHARE_SKILL_MD);
    expect(calls.find((c) => c.path.endsWith("/tools/aio-share/aio-share.py"))?.content).toBe(SHARE_CLI_PY);
    const config = calls.find((c) => c.path.endsWith("/tools/aio-share/config.json"));
    expect(JSON.parse(config!.content)).toEqual(share);
    expect(execCalls).toContainEqual(["chmod", "600", config!.path]);
  });

  it("does not fail the whole seed when the skill directory cannot be created", async () => {
    // A missing skill is a degradation, not a reason to leave the console
    // without a sandbox: AGENTS.md still names the document tools.
    const cfg = testConfig("/tmp/pa-skill-fail-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false));
    vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
    const written: string[] = [];
    container.writeFileInSandbox = (async (filePath: string) => {
      written.push(filePath);
    }) as typeof container.writeFileInSandbox;
    container.execInSandbox = (async () => ({ code: 1, stdout: "", stderr: "permission denied" })) as typeof container.execInSandbox;

    await expect(container.seedWorkspace()).resolves.toBeUndefined();
    expect(written.some((p) => p.endsWith("/AGENTS.md"))).toBe(true);
    expect(written.some((p) => p.includes(DOCUMENT_SKILL_DIR))).toBe(false);
  });

  it("names the real in-container CLI and never a host tool", () => {
    expect(DOCUMENT_SKILL_MD).toContain("/home/gem/.codex/tools/aio-doc/bin/aio-doc");
    expect(DOCUMENT_SKILL_MD).toContain("/home/gem/.codex/tools/aio-doc/venv/bin/python");
    expect(DOCUMENT_SKILL_MD).toContain("name: aio-documents");
    // No host path, no host skill package, no network service.
    for (const forbidden of ["/Users/", "~/.codex/skills", "npm ", "pip install", "https://"]) {
      expect(DOCUMENT_SKILL_MD, `skill must not reference ${forbidden}`).not.toContain(forbidden);
    }
    // LibreOffice 7.3 rejects the `--` separator; the example must not teach it.
    expect(DOCUMENT_SKILL_MD).not.toMatch(/--convert-to pdf[^\n]*\s--\s/);
  });

  it("fails startup when the managed isolation policy cannot be installed", async () => {
    const container = new SandboxContainer(testConfig("/tmp/pa-policy-test", 1), new Logger("error", undefined, false));
    vi.spyOn(container, "writeFileInSandbox").mockResolvedValue();
    vi.spyOn(container, "execInSandbox").mockResolvedValue({ code: 1, stdout: "", stderr: "Existing unmanaged Codex requirements; merge policy explicitly" });
    await expect(container.seedWorkspace()).rejects.toThrow("Cannot enforce sandbox Codex MCP isolation");
  });
});
