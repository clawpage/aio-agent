import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SandboxContainer } from "../../src/control/sandbox/container.js";
import { CODEX_CONFIG_TOML, DOCUMENT_SKILL_DIR, DOCUMENT_SKILL_MD, SHARE_CLI_PY, SHARE_SKILL_MD, WORKSPACE_AGENTS_BEGIN, WORKSPACE_AGENTS_END, WORKSPACE_AGENTS_MD, refreshWorkspaceAgents } from "../../src/control/sandbox/seed.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig, testNode } from "../helpers/harness.js";

describe("sandbox workspace seed", () => {
  it("documents the task, project and scratch layout and the browser tool tasks really have", () => {
    for (const expected of [
      "/home/gem/workspace/tasks/<任务 id>/",
      ".tmp/",
      "/home/gem/workspace/projects/<name>/",
      "/home/gem/workspace/.scratch/",
      "README.md",
      "aio_tabs",
    ]) {
      expect(WORKSPACE_AGENTS_MD, `template must document ${expected}`).toContain(expected);
    }
    // Tasks get aio_tabs only; teaching the whole-browser commands makes them
    // fight over the visible page.
    expect(WORKSPACE_AGENTS_MD).not.toMatch(/aio browser (navigate|screenshot|click)/);
    expect(WORKSPACE_AGENTS_MD).not.toContain("aio_browser");
    expect(WORKSPACE_AGENTS_MD).not.toContain("/home/gem/workspace/screenshot.png");
  });

  it("keeps the managed block current without losing what the person wrote", () => {
    const fresh = refreshWorkspaceAgents(null);
    expect(fresh).toBe(WORKSPACE_AGENTS_MD);
    expect(fresh).toContain("## 我的补充");
    // Already current: nothing to write.
    expect(refreshWorkspaceAgents(fresh)).toBe(fresh);
    // Only the block is replaced; what sits around it stays byte for byte.
    const mine = "## 我的补充\n\n- 回答尽量简短\n";
    const stale = `前言\n${WORKSPACE_AGENTS_BEGIN}\n旧说明：用 aio browser screenshot\n${WORKSPACE_AGENTS_END}\n\n${mine}`;
    const refreshed = refreshWorkspaceAgents(stale);
    expect(refreshed.startsWith("前言\n")).toBe(true);
    expect(refreshed.endsWith(mine)).toBe(true);
    expect(refreshed).not.toContain("旧说明");
    expect(refreshed).toContain("aio_tabs");
    // An untouched old template is replaced whole.
    const pristine = readFileSync(new URL("../fixtures/workspace-agents-v8.md", import.meta.url), "utf8");
    expect(refreshWorkspaceAgents(pristine)).toBe(WORKSPACE_AGENTS_MD);
    expect(refreshWorkspaceAgents(`${pristine}- 我加的一行\n`)).toContain("- 我加的一行");
    // An edited file from before the block existed is kept under it, marked older.
    const edited = "# 我的沙箱\n\n需要浏览器操作时优先用 aio browser\n- 我住在湾区\n";
    const merged = refreshWorkspaceAgents(edited);
    expect(merged.indexOf(WORKSPACE_AGENTS_END)).toBeLessThan(merged.indexOf("- 我住在湾区"));
    expect(merged).toContain("与上面系统说明冲突的地方");
    expect(merged).toContain(edited.trimEnd());
    // ...and the next start leaves it alone apart from the block.
    expect(refreshWorkspaceAgents(merged)).toBe(merged);
  });

  it("enables Codex local memory by default without dropping the MCP registration", () => {
    expect(CODEX_CONFIG_TOML).toContain("[features]");
    expect(CODEX_CONFIG_TOML).toContain("memories = true");
    // The existing MCP registration must survive the new section.
    expect(CODEX_CONFIG_TOML).toContain("[mcp_servers.aio_browser]");
    expect(CODEX_CONFIG_TOML).toContain('url = "http://127.0.0.1:8080/mcp"');
  });

  it("refreshes AGENTS.md's managed block and writes config.toml only when absent", async () => {
    const seed = async (existing: string | null) => {
      const cfg = testConfig("/tmp/pa-seed-test", 1);
      const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
      const isolation = vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
      const calls: Array<{ path: string; content: string; opts: unknown }> = [];
      container.writeFileInSandbox = (async (filePath: string, content: string, opts?: unknown) => {
        calls.push({ path: filePath, content, opts });
      }) as typeof container.writeFileInSandbox;
      container.execInSandbox = (async (argv: string[]) =>
        argv[0] === "cat" && argv[1]!.endsWith("/AGENTS.md")
          ? existing === null ? { code: 1, stdout: "", stderr: "No such file" } : { code: 0, stdout: existing, stderr: "" }
          : { code: 0, stdout: "", stderr: "" }) as typeof container.execInSandbox;
      await container.seedWorkspace();
      expect(isolation).toHaveBeenCalledOnce();
      return calls;
    };
    const calls = await seed(null);
    const agents = calls.find((c) => c.path.endsWith("/AGENTS.md"));
    expect(agents?.opts ?? {}).not.toMatchObject({ onlyIfAbsent: true });
    expect(agents?.content).toBe(WORKSPACE_AGENTS_MD);
    // A file already current is not rewritten.
    expect((await seed(WORKSPACE_AGENTS_MD)).some((c) => c.path.endsWith("/AGENTS.md"))).toBe(false);

    const toml = calls.find((c) => c.path.endsWith("/config.toml"));
    expect(toml?.opts).toMatchObject({ onlyIfAbsent: true });
    expect(toml?.content).toBe(CODEX_CONFIG_TOML);
  });

  it("writes the document skill into the controlled skills directory for existing sandboxes too", async () => {
    const cfg = testConfig("/tmp/pa-skill-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
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

    // Both executors: Codex skills and the Claude Code config directory.
    const skills = calls.filter((c) => c.path.endsWith(`/${DOCUMENT_SKILL_DIR}/SKILL.md`));
    expect(skills.map((c) => c.path)).toEqual([`${cfg.sandbox.containerCodexHome}/${DOCUMENT_SKILL_DIR}/SKILL.md`, `${cfg.claudeCode.configDir}/${DOCUMENT_SKILL_DIR}/SKILL.md`]);
    for (const c of skills) expect(c.content).toBe(DOCUMENT_SKILL_MD);
    const skill = skills[0];
    // Managed, not `onlyIfAbsent`: a tool-path change must reach existing
    // sandboxes. AGENTS.md/config.toml keep the user's own edits, this does not
    // overwrite any other skill.
    expect(skill?.opts ?? {}).not.toMatchObject({ onlyIfAbsent: true });
    expect(execCalls.some((argv) => argv[0] === "mkdir" && argv[1] === "-p" && argv[2].endsWith(DOCUMENT_SKILL_DIR) && argv[3] === `${cfg.claudeCode.configDir}/${DOCUMENT_SKILL_DIR}`)).toBe(
      true,
    );
  });

  it("gives both executors the share skill, the CLI and this runtime's token only when sharing is provisioned", async () => {
    const seed = async (share?: { endpoint: string; token: string }) => {
      const cfg = { ...testConfig("/tmp/pa-share-seed-test", 1), share };
      const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
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
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
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
    const container = new SandboxContainer(testConfig("/tmp/pa-policy-test", 1), new Logger("error", undefined, false), testNode());
    vi.spyOn(container, "writeFileInSandbox").mockResolvedValue();
    vi.spyOn(container, "execInSandbox").mockResolvedValue({ code: 1, stdout: "", stderr: "Existing unmanaged Codex requirements; merge policy explicitly" });
    await expect(container.seedWorkspace()).rejects.toThrow("Cannot enforce sandbox Codex MCP isolation");
  });
});
