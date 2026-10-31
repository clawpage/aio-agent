import { CLAWPAGE_SDK_JS } from "../../src/control/sandbox/clawpageSdk.js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SandboxContainer } from "../../src/control/sandbox/container.js";
import { CODEX_CONFIG_TOML, DOCUMENT_SKILL_DIR, DOCUMENT_SKILL_MD, GRAPHIC_RENDER_PY, GRAPHIC_SKILL_MD, MAIL_BINARIES, MARKET_CLI_PY, MARKET_SKILL_MD, PHOTO_CLI_PY, PHOTO_REFERENCES, PHOTO_SKILL_MD, MAIL_INSTALL_SH, MAIL_RO_SH, MAIL_SETUP_PY, MAIL_SKILL_MD, SHARE_CLI_PY, SHARE_SKILL_MD, WORKSPACE_AGENTS_BEGIN, WORKSPACE_AGENTS_END, WORKSPACE_AGENTS_MD, refreshWorkspaceAgents } from "../../src/control/sandbox/seed.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig, testNode } from "../helpers/harness.js";

describe("sandbox workspace seed", () => {
  it("documents the task, project and scratch layout and the browser tool tasks really have", () => {
    for (const expected of [
      "/home/gem/workspace/tasks/<task id>/",
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
    expect(merged).toContain("where it conflicts with the system notes above");
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
    expect(none.calls.some((c) => c.path.includes("aio-share") || c.path.includes("clawpages"))).toBe(false);
    expect(none.execCalls.some((argv) => argv.includes("--missing"))).toBe(false);

    const share = { endpoint: "http://host.docker.internal:4902/share/owner_1", token: "a".repeat(64) };
    const { cfg, calls, execCalls } = await seed(share);
    const skills = calls.filter((c) => c.path.endsWith("/skills/clawpages/SKILL.md"));
    expect(skills.map((c) => c.path).sort()).toEqual([
      `${cfg.claudeCode.configDir}/skills/clawpages/SKILL.md`,
      `${cfg.sandbox.containerCodexHome}/skills/clawpages/SKILL.md`,
    ].sort());
    for (const s of skills) expect(s.content).toBe(SHARE_SKILL_MD);
    expect(SHARE_SKILL_MD).toMatch(/^---\nname: clawpages\n/);
    // The publish check's TABLE_NOT_FOUND is also a private table: the page changes, the table's permission never loosens for the check.
    const check = SHARE_SKILL_MD.slice(SHARE_SKILL_MD.indexOf("also prints a **check**"));
    expect(check).toMatch(/if it does, the table is private, which visitors cannot see: change the page to read that table only when `cp\.owner`/);
    expect(check).toContain("**Never loosen a private table's permission just to pass the check.**");
    // The skill's earlier name goes, so the executor never sees both.
    expect(execCalls).toContainEqual(["rm", "-rf", `${cfg.sandbox.containerCodexHome}/skills/aio-share`, `${cfg.claudeCode.configDir}/skills/aio-share`]);
    expect(calls.some((c) => c.path.includes("/skills/aio-share/"))).toBe(false);
    expect(calls.find((c) => c.path.endsWith("/tools/aio-share/aio-share.py"))?.content).toBe(SHARE_CLI_PY);
    expect(calls.find((c) => c.path.endsWith("/tools/aio-share/clawpage-sdk.js"))?.content).toBe(CLAWPAGE_SDK_JS);
    // Pages without a cover get one in the background once the tools are in place.
    expect(execCalls).toContainEqual(["bash", "-c", 'nohup python3 "$1" cover --missing >/tmp/aio-share-cover.log 2>&1 </dev/null &', "covers", `${cfg.sandbox.containerCodexHome}/tools/aio-share/aio-share.py`]);
    const config = calls.find((c) => c.path.endsWith("/tools/aio-share/config.json"));
    expect(JSON.parse(config!.content)).toEqual(share);
    expect(execCalls).toContainEqual(["chmod", "600", config!.path]);
  });

  it("gives both executors the HTML-to-PNG skill and its renderer on every sandbox", async () => {
    const cfg = testConfig("/tmp/pa-graphic-seed-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
    const calls: Array<{ path: string; content: string }> = [];
    container.writeFileInSandbox = (async (filePath: string, content: string) => {
      calls.push({ path: filePath, content });
    }) as typeof container.writeFileInSandbox;
    container.execInSandbox = (async () => ({ code: 0, stdout: "", stderr: "" })) as typeof container.execInSandbox;
    await container.seedWorkspace();
    const skills = calls.filter((c) => c.path.endsWith("/skills/aio-graphic/SKILL.md"));
    expect(skills.map((c) => c.path).sort()).toEqual([
      `${cfg.claudeCode.configDir}/skills/aio-graphic/SKILL.md`,
      `${cfg.sandbox.containerCodexHome}/skills/aio-graphic/SKILL.md`,
    ].sort());
    for (const s of skills) expect(s.content).toBe(GRAPHIC_SKILL_MD);
    expect(calls.find((c) => c.path === `${cfg.sandbox.containerCodexHome}/tools/aio-graphic/aio-render.py`)?.content).toBe(GRAPHIC_RENDER_PY);
    // The skill names the renderer at the path it is written to, and keeps text edits away from image_generate.
    expect(GRAPHIC_SKILL_MD).toContain("python3 /home/gem/.codex/tools/aio-graphic/aio-render.py");
    expect(GRAPHIC_SKILL_MD).toMatch(/^---\nname: aio-graphic\ndescription: /);
    expect(GRAPHIC_SKILL_MD).toContain("never use image_generate to change its text");
  });

  it("gives both executors the market data skill and its CLI on every sandbox, without installing anything at start", async () => {
    const cfg = testConfig("/tmp/pa-market-seed-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
    const calls: Array<{ path: string; content: string }> = [];
    container.writeFileInSandbox = (async (filePath: string, content: string) => {
      calls.push({ path: filePath, content });
    }) as typeof container.writeFileInSandbox;
    const execs: string[][] = [];
    container.execInSandbox = (async (argv: string[]) => (execs.push(argv), { code: 0, stdout: "", stderr: "" })) as typeof container.execInSandbox;
    await container.seedWorkspace();
    const skills = calls.filter((c) => c.path.endsWith("/skills/aio-market/SKILL.md"));
    expect(skills.map((c) => c.path).sort()).toEqual([
      `${cfg.claudeCode.configDir}/skills/aio-market/SKILL.md`,
      `${cfg.sandbox.containerCodexHome}/skills/aio-market/SKILL.md`,
    ].sort());
    for (const s of skills) expect(s.content).toBe(MARKET_SKILL_MD);
    expect(calls.find((c) => c.path === `${cfg.sandbox.containerCodexHome}/tools/aio-market/aio-market.py`)?.content).toBe(MARKET_CLI_PY);
    // The libraries are installed by the CLI on first use, never on the sandbox start path.
    expect(execs.some((argv) => argv.join(" ").includes("pip"))).toBe(false);
    expect(MARKET_SKILL_MD).toMatch(/^---\nname: aio-market\ndescription: /);
    expect(MARKET_SKILL_MD).toContain("python3 /home/gem/.codex/tools/aio-market/aio-market.py");
    // The venv the skill points at is the one the CLI creates beside itself, with pinned libraries.
    expect(MARKET_SKILL_MD).toContain("/home/gem/.codex/tools/aio-market/venv/bin/python");
    expect(MARKET_CLI_PY).toContain('VENV = os.path.join(HERE, "venv")');
    expect(MARKET_CLI_PY).toMatch(/REQUIREMENTS = \["yfinance==[\d.]+", "akshare==[\d.]+"\]/);
    // history --chart hands the executor a ready chart block, and the skill tells it to use one instead of an image.
    expect(MARKET_CLI_PY).toContain('h.add_argument("--chart"');
    expect(MARKET_CLI_PY).toContain('"type": "candlestick"');
    expect(MARKET_SKILL_MD).toContain("history --chart");
  });

  it("gives both executors the photo retouching skill and its CLI, never installing anything at start", async () => {
    const cfg = testConfig("/tmp/pa-photo-seed-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
    const calls: Array<{ path: string; content: string }> = [];
    container.writeFileInSandbox = (async (filePath: string, content: string) => {
      calls.push({ path: filePath, content });
    }) as typeof container.writeFileInSandbox;
    const execs: string[][] = [];
    container.execInSandbox = (async (argv: string[]) => (execs.push(argv), { code: 0, stdout: "", stderr: "" })) as typeof container.execInSandbox;
    await container.seedWorkspace();
    const skills = calls.filter((c) => c.path.endsWith("/skills/aio-photo/SKILL.md"));
    expect(skills.map((c) => c.path).sort()).toEqual([
      `${cfg.claudeCode.configDir}/skills/aio-photo/SKILL.md`,
      `${cfg.sandbox.containerCodexHome}/skills/aio-photo/SKILL.md`,
    ].sort());
    for (const s of skills) expect(s.content).toBe(PHOTO_SKILL_MD);
    expect(calls.find((c) => c.path === `${cfg.sandbox.containerCodexHome}/tools/aio-photo/aio-photo.py`)?.content).toBe(PHOTO_CLI_PY);
    expect(execs.some((argv) => argv.join(" ").includes("pip"))).toBe(false);
    expect(PHOTO_SKILL_MD).toMatch(/^---\nname: aio-photo\ndescription: /);
    expect(PHOTO_SKILL_MD).toContain("python3 /home/gem/.codex/tools/aio-photo/aio-photo.py retouch");
    expect(PHOTO_SKILL_MD).toContain("python3 /home/gem/.codex/tools/aio-photo/aio-photo.py check");
    // The lessons of a real failure: never redraw, always from the original, no other photo as reference, redo on resend, check first.
    expect(PHOTO_SKILL_MD).toContain("Start from the original every time");
    expect(PHOTO_SKILL_MD).toContain("Never use another photo, or another photo's result, as a reference");
    expect(PHOTO_SKILL_MD).toContain("Never copy or resend earlier results");
    expect(PHOTO_SKILL_MD).toContain("Deliver only when `ok` is true");
    // A full-size photo delivered as PNG (24.7 MB) could not be shown in the conversation.
    expect(PHOTO_SKILL_MD).toContain("never deliver a full-size photo as PNG");
    // Pinned libraries that still install on the sandbox's Python 3.10, OpenCV 4 for the face detector, its model by hash.
    expect(PHOTO_CLI_PY).toMatch(/REQUIREMENTS = \["rembg==2\.0\.69", "onnxruntime==1\.23\.2", "opencv-python-headless==4\.[\d.]+"\]/);
    expect(PHOTO_CLI_PY).toMatch(/FACE_MODEL_SHA256 = "[0-9a-f]{64}"/);
    expect(PHOTO_CLI_PY).toContain('"people": "u2net_human_seg"');
    // Every account develops with the same LightCraft release, checked by hash for both processors.
    expect(PHOTO_CLI_PY).toContain('LIGHTCRAFT_VERSION = "0.14.0"');
    expect(PHOTO_CLI_PY).toMatch(/"x86_64": "[0-9a-f]{64}",\s+"aarch64": "[0-9a-f]{64}"/);
    const flat = PHOTO_SKILL_MD.replace(/\s+/g, " ");
    expect(flat).toContain("**Every photo is developed with LightCraft**");
    expect(flat).toContain("do not install or call another copy, and do not adjust light or color with your own scripts");
    expect(PHOTO_CLI_PY).toContain('r.add_argument("--engine", choices=["lightcraft", "basic"], default="lightcraft"');
    // Results go back as a before/after comparison, the original always on the before side.
    expect(PHOTO_SKILL_MD).toContain("```compare");
    expect(PHOTO_SKILL_MD).toContain("`before` is always the original");
    expect(PHOTO_SKILL_MD).toContain("--soften 0..1");
    // The reference files go next to SKILL.md for both executors, and SKILL.md says when to read each one.
    const names = Object.keys(PHOTO_REFERENCES).sort();
    expect(names).toEqual(["background-compositing.md", "id-photos.md", "lightcraft-controls.md", "local-retouch.md", "looks-and-grading.md",
      "scene-playbook.md", "sources.md", "workflow-and-quality.md"]);
    for (const dir of [cfg.sandbox.containerCodexHome, cfg.claudeCode.configDir]) {
      for (const name of names) {
        expect(calls.find((c) => c.path === `${dir}/skills/aio-photo/references/${name}`)?.content).toBe(PHOTO_REFERENCES[name]);
        expect(PHOTO_SKILL_MD).toContain(`\`${name}\``);
      }
    }
    expect(execs.some((argv) => argv[0] === "mkdir" && argv.some((a) => a.endsWith("skills/aio-photo/references")))).toBe(true);
    // Model-facing text is English; relative links between references resolve.
    for (const [name, text] of Object.entries(PHOTO_REFERENCES)) {
      expect(text, name).toMatch(/^# [A-Z]/);
      for (const link of text.matchAll(/\]\(([a-z-]+\.md)\)/g)) expect(names, `${name} links ${link[1]}`).toContain(link[1]);
    }
    // Every option the skill names exists in the CLI.
    for (const option of ["--local", "--heal", "--blemishes", "--wb-pick", "--crop", "--id-photo", "--manual"]) {
      expect(PHOTO_SKILL_MD).toContain(option);
      expect(PHOTO_CLI_PY).toContain(`"${option}"`);
    }
  });

  it("installs the photo tools through the CLI's own setup, with time for a fresh install", async () => {
    const cfg = testConfig("/tmp/pa-photo-libs-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    const execs: Array<{ argv: string[]; timeoutMs?: number }> = [];
    let stdout = JSON.stringify({ ok: true, installed: true });
    container.execInSandbox = (async (argv: string[], opts?: { timeoutMs?: number }) => (execs.push({ argv, timeoutMs: opts?.timeoutMs }), { code: 0, stdout, stderr: "" })) as typeof container.execInSandbox;
    expect(await container.ensurePhotoLibraries()).toBe(true);
    expect(execs[0].argv).toEqual(["python3", `${cfg.sandbox.containerCodexHome}/tools/aio-photo/aio-photo.py`, "setup"]);
    expect(execs[0].timeoutMs).toBeGreaterThanOrEqual(900_000);
    stdout = JSON.stringify({ ok: true, installed: false });
    expect(await container.ensurePhotoLibraries()).toBe(false);
    container.execInSandbox = (async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "pip failed" }), stderr: "" })) as typeof container.execInSandbox;
    await expect(container.ensurePhotoLibraries()).rejects.toThrow("pip failed");
  });

  it("installs the market data libraries through the CLI's own setup and reports whether it installed them", async () => {
    const cfg = testConfig("/tmp/pa-market-libs-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    const execs: Array<{ argv: string[]; timeoutMs?: number }> = [];
    let stdout = JSON.stringify({ ok: true, installed: true });
    container.execInSandbox = (async (argv: string[], opts?: { timeoutMs?: number }) => (execs.push({ argv, timeoutMs: opts?.timeoutMs }), { code: 0, stdout, stderr: "" })) as typeof container.execInSandbox;
    expect(await container.ensureMarketLibraries()).toBe(true);
    expect(execs[0].argv).toEqual(["python3", `${cfg.sandbox.containerCodexHome}/tools/aio-market/aio-market.py`, "setup"]);
    // pip in a fresh sandbox takes about a minute; the call must not time out first.
    expect(execs[0].timeoutMs).toBeGreaterThanOrEqual(600_000);
    stdout = JSON.stringify({ ok: true, installed: false });
    expect(await container.ensureMarketLibraries()).toBe(false);
    container.execInSandbox = (async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "pip failed" }), stderr: "" })) as typeof container.execInSandbox;
    await expect(container.ensureMarketLibraries()).rejects.toThrow("pip failed");
    // An installed venv is answered from its stamp; importing the libraries is only for --verify or a fresh install.
    expect(MARKET_CLI_PY).toContain("if installed or args.verify:");
  });

  it("gives every sandbox the mail skill, its scripts and the pinned himalaya/ortie on PATH", async () => {
    const cfg = testConfig("/tmp/pa-mail-seed-test", 1);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    vi.spyOn(container, "enforceCodexIsolation").mockResolvedValue();
    const calls: Array<{ path: string; content: string }> = [];
    container.writeFileInSandbox = (async (filePath: string, content: string) => {
      calls.push({ path: filePath, content });
    }) as typeof container.writeFileInSandbox;
    const execs: Array<{ argv: string[]; user?: string }> = [];
    container.execInSandbox = (async (argv: string[], opts?: { user?: string }) => (execs.push({ argv, user: opts?.user }), { code: 0, stdout: "", stderr: "" })) as typeof container.execInSandbox;
    await container.seedWorkspace();

    const toolDir = `${cfg.sandbox.containerCodexHome}/tools/himalaya-email`;
    const skills = calls.filter((c) => c.path.endsWith("/skills/himalaya-email/SKILL.md"));
    expect(skills.map((c) => c.path).sort()).toEqual([`${cfg.claudeCode.configDir}/skills/himalaya-email/SKILL.md`, `${cfg.sandbox.containerCodexHome}/skills/himalaya-email/SKILL.md`].sort());
    for (const c of skills) expect(c.content).toBe(MAIL_SKILL_MD);
    expect(calls.find((c) => c.path === `${toolDir}/mail-ro`)?.content).toBe(MAIL_RO_SH);
    expect(calls.find((c) => c.path === `${toolDir}/setup_accounts.py`)?.content).toBe(MAIL_SETUP_PY);
    // Installed as the sandbox user into the volume, then linked onto PATH as root.
    expect(execs).toContainEqual({ argv: ["sh", "-c", MAIL_INSTALL_SH, "mail-install", toolDir], user: undefined });
    const link = execs.find((e) => e.user === "root" && e.argv.join(" ").includes("/usr/local/bin/himalaya"));
    expect(link?.argv[2]).toBe(`ln -sfn ${toolDir}/bin/himalaya /usr/local/bin/himalaya && ln -sfn ${toolDir}/bin/ortie /usr/local/bin/ortie`);

    // A failed download degrades the mail skill only, never the sandbox.
    container.execInSandbox = (async (argv: string[]) => ({ code: argv[0] === "sh" && argv[3] === "mail-install" ? 1 : 0, stdout: "", stderr: "curl: (6)" })) as typeof container.execInSandbox;
    await expect(container.seedWorkspace()).resolves.toBeUndefined();
  });

  it("pins each mail binary by version and checksum and keeps OAuth app values out of the repository", () => {
    for (const b of MAIL_BINARIES) {
      expect(MAIL_INSTALL_SH).toContain(`/releases/download/v${b.version}/${b.name}.$arch-linux.tgz`);
      for (const sha of Object.values(b.sha256)) expect(MAIL_INSTALL_SH).toContain(sha);
    }
    expect(MAIL_INSTALL_SH).toContain("sha256sum -c");
    // Deployment configuration, read from oauth-clients.json at setup time.
    expect(MAIL_SETUP_PY).toContain("oauth-clients.json");
    expect(MAIL_SETUP_PY).not.toMatch(/apps\.googleusercontent\.com|client-secret\.raw = "/);
    // Sending is allowed only after the user confirms a preview.
    expect(MAIL_SKILL_MD).toContain("you must confirm before sending");
    expect(MAIL_SKILL_MD).toContain("--send");
    expect(MAIL_RO_SH).toContain("is not a read-only command; refused");
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
