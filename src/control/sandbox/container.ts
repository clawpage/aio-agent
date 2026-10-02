import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { TAB_TOOL_TIMEOUT_SEC } from "../browser/tabs.js";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import type { ContainerState, ExecRequest, ExecResult, SandboxSpec } from "../../common/protocol.js";
import type { SandboxNode, SandboxUpstream } from "./node.js";
import { NOVNC_HTML_PATH, NOVNC_RFB_PATH, NOVNC_UI_PATH, patchNoVncHtml, patchNoVncRfb, patchNoVncUi } from "./novncPatch.js";
import {
  CODEX_CONFIG_TOML,
  CODEX_ISOLATION_MARKER,
  CODEX_ISOLATION_OVERRIDES,
  claudeCodeUserMemory,
  codexRequirementsToml,
  DOCUMENT_SKILL_DIR,
  DOCUMENT_SKILL_MD,
  SHARE_CLI_PY,
  SHARE_SKILL_DIR,
  SHARE_SKILL_MD,
  SHARE_TOOL_DIR,
  WORKSPACE_AGENTS_MD,
} from "./seed.js";

export type { ContainerState };
/** One finished command inside the sandbox. */
export type DockerRunResult = ExecResult;

/**
 * Version reported by `<codexBin> --version`, e.g. `codex-cli 0.156.1`.
 * Parsed and compared exactly: a substring check would accept `0.156.10` as
 * `0.156.1` and silently run the wrong binary.
 */
/** The image's own browser entry point, restored when no newer build is in use. */
export const IMAGE_BROWSER = "/usr/local/bin/browser";

export function parseCodexVersion(output: string): string | null {
  const match = /codex-cli\s+(\S+)/.exec(output);
  return match ? match[1] : null;
}

/**
 * One account's sandbox container, as the control plane sees it. The container
 * itself lives on a sandbox node (sandboxd), which owns Docker there; this class
 * turns the control plane's needs into the node's fixed operations and keeps
 * everything that is about the agent runtime (CLIs, skills, policies, browser
 * set-up) on this side.
 */
export class SandboxContainer {
  #cfg: Config;
  #log: Logger;
  #node: SandboxNode;

  constructor(cfg: Config, log: Logger, node: SandboxNode) {
    this.#cfg = cfg;
    this.#log = log;
    this.#node = node;
  }

  get name(): string {
    return this.#cfg.sandbox.containerName;
  }

  /** The node this sandbox lives on. */
  get node(): SandboxNode {
    return this.#node;
  }

  /** What the node needs to create or adopt this container. */
  spec(): SandboxSpec {
    const s = this.#cfg.sandbox;
    const member = this.#cfg.memberRuntime && s.networkName ? { networkName: s.networkName, gatewayPort: this.#cfg.memberModelPort ?? 4902 } : undefined;
    return {
      name: this.name,
      image: s.image,
      hostPort: s.hostPort,
      workspaceVolume: s.workspaceVolume,
      codexVolume: s.codexVolume,
      browserVolume: s.browserVolume,
      containerWorkspaceDir: s.containerWorkspaceDir,
      containerCodexHome: s.containerCodexHome,
      containerUser: s.containerUser,
      extraEnv: s.extraEnv,
      ...(member ? { member } : this.#cfg.protectedMemberPorts?.length ? { peerPorts: this.#cfg.protectedMemberPorts } : {}),
    };
  }

  async inspect(): Promise<ContainerState> {
    return await this.#node.inspect(this.name);
  }

  async ensureRunning(): Promise<ContainerState> {
    // The node creates or starts the container, waits for it, isolates its network
    // and fixes ownership; the agent runtime inside is provisioned from here.
    await this.#node.ensure(this.name, { spec: this.spec(), readyTimeoutMs: this.#cfg.sandbox.readyTimeoutMs });
    await this.ensureCodexCli();
    await this.seedWorkspace();
    await this.waitSurfaces();
    return await this.inspect();
  }

  /** Prevent the owner's tools reaching member APIs through Docker Desktop host forwarding. */
  protectMemberPorts(ports:number[]):Promise<void>{
    if(ports.some(p=>!Number.isInteger(p)||p<1||p>65535))return Promise.reject(new Error("Invalid peer port"));
    this.#cfg.protectedMemberPorts=[...new Set([...(this.#cfg.protectedMemberPorts??[]),...ports])];
    return this.#node.peerPorts(this.name,this.#cfg.protectedMemberPorts);
  }

  /** Reachability of the sandbox's own web surfaces, probed through the node. */
  async surfaces(): Promise<Record<string, boolean>> {
    const targets: Record<string, string> = {
      terminal: "/terminal",
      browserUi: "/browser-ui",
      desktop: "/vnc/vnc.html",
      codeServer: "/code-server/",
      jupyter: "/jupyter/lab",
    };
    const out: Record<string, boolean> = {};
    await Promise.all(
      Object.entries(targets).map(async ([name, path]) => {
        try {
          const res = await this.fetch(path, { redirect: "manual", signal: AbortSignal.timeout(6000) });
          await res.body?.cancel();
          out[name] = res.status < 500;
        } catch {
          out[name] = false;
        }
      }),
    );
    return out;
  }

  /** Wait until the core surfaces answer; editor readiness is part of real health. */
  async waitSurfaces(timeoutMs = 120_000): Promise<Record<string, boolean>> {
    const required = ["terminal", "codeServer", "jupyter"];
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, boolean> = {};
    for (;;) {
      last = await this.surfaces();
      if (required.every((name) => last[name])) return last;
      if (Date.now() > deadline) {
        this.#log.warn("some sandbox surfaces are not ready", { surfaces: last });
        return last;
      }
      await delay(3000);
    }
  }

  async isReady(): Promise<boolean> {
    try {
      const res = await this.fetch("/health", { signal: AbortSignal.timeout(4000) });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Average CPU use over `seconds` of everything in the container except the
   * browser (percent of one core), or null when unknown. Chromium is left out:
   * its own rendering is not anyone's work, and a browser that was never released
   * would otherwise always count. Reaped children's time is included, so a build
   * of many short processes still shows.
   */
  async cpuPercent(seconds = 10): Promise<number | null> {
    const res = await this.execInSandbox(["python3", "-"], { user: "root", stdin: workCpuScript(seconds), timeoutMs: (seconds + 20) * 1000 }).catch(() => null);
    const value = Number(res?.stdout.trim());
    return res?.code === 0 && res.stdout.trim() !== "" && Number.isFinite(value) ? value : null;
  }

  async stop(): Promise<void> {
    await this.#node.stop(this.name);
  }

  async restart(): Promise<ContainerState> {
    return await this.#node.restart(this.name, this.#cfg.sandbox.readyTimeoutMs);
  }

  /** `fetch` against the sandbox's web port (its AIO API and surfaces). */
  async fetch(pathname: string, init: RequestInit = {}): Promise<Response> {
    return await this.#node.fetch(this.name, pathname, init);
  }

  /** Where raw HTTP/WebSocket proxying of this sandbox's web port goes. */
  upstream(): SandboxUpstream {
    return this.#node.upstream(this.name);
  }

  /** Write a file inside the sandbox by streaming content to stdin (content is never shell-interpolated). */
  async writeFileInSandbox(
    filePath: string,
    content: string,
    opts: { user?: string; onlyIfAbsent?: boolean } = {},
  ): Promise<void> {
    const script = opts.onlyIfAbsent ? '[ -f "$1" ] || cat > "$1"' : 'cat > "$1"';
    const res = await this.execInSandbox(["bash", "-lc", script, "write-file", filePath], { user: opts.user, stdin: content, timeoutMs: 120_000 });
    if (res.code !== 0) throw new Error(`failed to write ${filePath}: ${res.stderr.trim()}`);
  }

  /**
   * Ensure the pinned Codex CLI exists in the persistent volume.
   *
   * The AIO image keeps its own (older) Codex on PATH; the agent must run the
   * versioned binary in the personal-agent-codex volume instead. If it is
   * missing (fresh volume, container rebuild) or has the wrong version it is
   * installed once from npm. Failure is raised, never silently downgraded: a
   * stale binary would make the configured default model unusable.
   */
  async ensureCodexCli(): Promise<{ version: string; installed: boolean }> {
    const s = this.#cfg.sandbox;
    const probe = await this.execInSandbox([s.codexBin, "--version"], { timeoutMs: 30_000 });
    const found = parseCodexVersion(probe.stdout);
    if (probe.code === 0 && found === s.codexVersion) return { version: found, installed: false };

    this.#log.warn("installing pinned sandbox codex cli", {
      wanted: s.codexVersion,
      found: found ?? (probe.stdout.trim() || probe.stderr.trim()),
      prefix: s.codexPrefix,
    });
    const install = await this.execInSandbox(["npm", "install", "--prefix", s.codexPrefix, "--no-audit", "--no-fund", `@openai/codex@${s.codexVersion}`], { timeoutMs: 600_000 });
    if (install.code !== 0) {
      throw new Error(
        `沙箱 Codex CLI 安装失败（需要 @openai/codex@${s.codexVersion}）：${install.stderr.trim() || install.stdout.trim()}`,
      );
    }
    const verify = await this.execInSandbox([s.codexBin, "--version"], { timeoutMs: 30_000 });
    const installed = parseCodexVersion(verify.stdout);
    if (verify.code !== 0 || installed !== s.codexVersion) {
      throw new Error(
        `沙箱 Codex CLI 安装后校验失败：期望 ${s.codexVersion}，实际 ${installed ?? (verify.stdout.trim() || verify.stderr.trim())}`,
      );
    }
    return { version: s.codexVersion, installed: true };
  }

  /**
   * Seed the persistent workspace with agent-facing instructions and register the
   * sandbox MCP server so the agent can drive the real browser, not only shells.
   * AGENTS.md and config.toml are created only when absent. The separate system
   * MCP isolation policy is enforced on every startup, including old sandboxes.
   */
  async seedWorkspace(): Promise<void> {
    const s = this.#cfg.sandbox;
    await this.writeFileInSandbox(`${s.containerWorkspaceDir}/AGENTS.md`, WORKSPACE_AGENTS_MD, { onlyIfAbsent: true });
    await this.writeFileInSandbox(`${s.containerCodexHome}/config.toml`, CODEX_CONFIG_TOML, { onlyIfAbsent: true });
    // The document skill is managed, not `onlyIfAbsent`: it must reach existing
    // sandboxes too, and it writes to exactly one skill directory so no user
    // skill or instruction is ever touched. Its directory is created first -
    // `cat >` cannot create a missing parent, so on a fresh sandbox the write
    // would otherwise fail and take the whole startup path down with it.
    const skillDir = `${s.containerCodexHome}/${DOCUMENT_SKILL_DIR}`;
    const mkdir = await this.execInSandbox(["mkdir", "-p", skillDir], { timeoutMs: 15_000 });
    if (mkdir.code !== 0) {
      // A missing skill must never block the sandbox: the agent can still be
      // told about the tools through AGENTS.md.
      this.#log.warn("could not create the sandbox document skill directory", {
        error: (mkdir.stderr || mkdir.stdout).trim().slice(0, 200),
      });
    } else {
      await this.writeFileInSandbox(`${skillDir}/SKILL.md`, DOCUMENT_SKILL_MD);
    }
    await this.seedShare();
    await this.enforceCodexIsolation();
  }

  /**
   * The share skill for both executors (Codex skills and the Claude Code config
   * directory) plus the CLI and this runtime's publish token. Like the document
   * skill, a failure is logged and never blocks the sandbox.
   */
  async seedShare(): Promise<void> {
    const s = this.#cfg.sandbox;
    const share = this.#cfg.share;
    if (!share) return;
    const toolDir = `${s.containerCodexHome}/${SHARE_TOOL_DIR}`;
    const skillDirs = [`${s.containerCodexHome}/${SHARE_SKILL_DIR}`, `${this.#cfg.claudeCode.configDir}/${SHARE_SKILL_DIR}`];
    try {
      const mkdir = await this.execInSandbox(["mkdir", "-p", toolDir, ...skillDirs], { timeoutMs: 15_000 });
      if (mkdir.code !== 0) throw new Error((mkdir.stderr || mkdir.stdout).trim().slice(0, 200));
      await this.writeFileInSandbox(`${toolDir}/aio-share.py`, SHARE_CLI_PY);
      await this.writeFileInSandbox(`${toolDir}/config.json`, JSON.stringify(share));
      await this.execInSandbox(["chmod", "600", `${toolDir}/config.json`], { timeoutMs: 15_000 });
      for (const dir of skillDirs) await this.writeFileInSandbox(`${dir}/SKILL.md`, SHARE_SKILL_MD);
    } catch (err) {
      this.#log.warn("could not seed the sandbox share skill", { error: String(err).slice(0, 200) });
    }
  }

  /** A separate managed policy avoids rewriting the user's persistent config. */
  async enforceCodexIsolation(): Promise<void> {
    const script = `import os, pathlib, sys, tempfile
directory = pathlib.Path('/etc/codex')
target = directory / 'requirements.toml'
if directory.is_symlink() or target.is_symlink():
    raise SystemExit('Refusing symlink at Codex policy path')
directory.mkdir(mode=0o755, parents=True, exist_ok=True)
if target.exists() and not target.read_text().startswith(sys.argv[1] + '\\n'):
    raise SystemExit('Existing unmanaged Codex requirements; merge policy explicitly')
os.chown(directory, 0, 0)
os.chmod(directory, 0o755)
with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as f:
    temporary = f.name
    f.write(sys.argv[2])
try:
    os.chmod(temporary, 0o644)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
`;
    const result = await this.execInSandbox(["python3", "-c", script, CODEX_ISOLATION_MARKER, codexRequirementsToml(this.#cfg)], { user: "root" });
    if (result.code !== 0) throw new Error(`Cannot enforce sandbox Codex MCP isolation: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  /**
   * Spawn `docker exec -i` with a fixed prefix for the sandbox Codex process.
   *
   * `secretEnv` values are passed through the docker CLI's own environment and
   * referenced by name only (`-e NAME`), so a key never appears in argv or in a
   * host process listing. The isolation flags keep their exact order and
   * semantics; `secretEnv` never changes them.
   */
  spawnCodexAppServer(extraConfig: string[] = [], secretEnv: Record<string, string> = {}): ChildProcess {
    const s = this.#cfg.sandbox;
    return this.spawnInSandbox({
      argv: ["env", `CODEX_HOME=${s.containerCodexHome}`, s.codexBin, "app-server", "--listen", "stdio://", ...extraConfig, ...CODEX_ISOLATION_OVERRIDES],
      env: secretEnv,
    });
  }

  /**
   * Ensure the pinned Claude Code CLI exists in the persistent volume, and that
   * its config dir imports the workspace AGENTS.md (Codex reads that file
   * natively; Claude Code reads CLAUDE.md) and the long-term memory Codex keeps.
   * Never silently runs another version.
   */
  async ensureClaudeCli(): Promise<void> {
    const c = this.#cfg.claudeCode;
    const user = this.#cfg.sandbox.containerUser;
    const probe = await this.execInSandbox([c.bin, "--version"], { user, timeoutMs: 30_000 });
    if (probe.code !== 0 || !probe.stdout.startsWith(`${c.version} `)) {
      this.#log.warn("installing pinned sandbox claude code cli", { wanted: c.version, prefix: c.prefix });
      const install = await this.execInSandbox(["npm", "install", "--prefix", c.prefix, "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${c.version}`], { user, timeoutMs: 600_000 });
      if (install.code !== 0) {
        throw new Error(`沙箱 Claude Code CLI 安装失败（需要 @anthropic-ai/claude-code@${c.version}）：${install.stderr.trim() || install.stdout.trim()}`);
      }
      const verify = await this.execInSandbox([c.bin, "--version"], { user, timeoutMs: 30_000 });
      if (verify.code !== 0 || !verify.stdout.startsWith(`${c.version} `)) {
        throw new Error(`沙箱 Claude Code CLI 安装后校验失败：期望 ${c.version}，实际 ${verify.stdout.trim() || verify.stderr.trim()}`);
      }
    }
    const memory = claudeCodeUserMemory(this.#cfg.sandbox.containerWorkspaceDir, this.#cfg.sandbox.containerCodexHome);
    const seeded = await this.execInSandbox(["sh", "-c", 'mkdir -p "$1" && cat > "$1/CLAUDE.md"', "sh", c.configDir], { user, stdin: memory, timeoutMs: 30_000 });
    if (seeded.code !== 0) throw new Error(`Claude Code 配置目录初始化失败：${seeded.stderr.trim()}`);
  }

  /** Whether the Claude Code session file for this UUID has been written yet. */
  async claudeSessionExists(sessionId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) return false;
    const res = await this.execInSandbox(["find", path.posix.join(this.#cfg.claudeCode.configDir, "projects"), "-maxdepth", "2", "-name", `${sessionId}.jsonl`], { timeoutMs: 30_000 });
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  /** Last resort after an unanswered interrupt: the CLI's argv carries its session UUID. */
  async killClaudeSession(sessionId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) return;
    await this.execInSandbox(["pkill", "-KILL", "-f", sessionId], { timeoutMs: 15_000 });
  }

  /** One Claude Code print-mode process speaking stream-json over stdio. */
  spawnClaude(args: string[], secretEnv: Record<string, string>): ChildProcess {
    return this.spawnInSandbox({
      argv: [
        "env", `CLAUDE_CONFIG_DIR=${this.#cfg.claudeCode.configDir}`, "DISABLE_AUTOUPDATER=1",
        // A browser hand-over waits up to 30 minutes for the person inside one tool call.
        `MCP_TOOL_TIMEOUT=${TAB_TOOL_TIMEOUT_SEC * 1000}`,
        this.#cfg.claudeCode.bin, ...args,
      ],
      workdir: this.#cfg.sandbox.containerWorkspaceDir,
      env: secretEnv,
    });
  }

  /**
   * A long-lived command inside the sandbox speaking over stdio. `env` values
   * travel to the node separately from argv and never appear in a process listing.
   */
  spawnInSandbox(req: { argv: string[]; user?: string; workdir?: string; env?: Record<string, string> }): ChildProcess {
    return this.#node.spawn(this.name, { argv: req.argv, user: req.user ?? this.#cfg.sandbox.containerUser, ...(req.workdir ? { workdir: req.workdir } : {}), env: req.env ?? {} });
  }

  /** Start a long-running sandbox process detached from this control plane (fixed argv). */
  async execDetached(argv: string[], opts: { user?: string; env?: Record<string, string> } = {}): Promise<DockerRunResult> {
    return await this.#node.exec(this.name, { argv, user: opts.user ?? this.#cfg.sandbox.containerUser, env: opts.env ?? {}, detached: true }).catch(failed);
  }

  /**
   * Run a one-shot command inside the sandbox (fixed argv, no shell expansion by
   * us). `stdin` is only ever control-plane content, never user input.
   */
  /**
   * Disconnect the image's own browser clients from Chromium. python-server's
   * browser API and mcp-server-browser attach with unpatched Playwright/Puppeteer
   * the first time they are used (the browser wake path does so) and never let
   * go; while attached, sites detect every page of the browser as automated.
   * Both reconnect on their next use. python-server also serves the terminal (a
   * long-lived websocket that its session list does not show), so it is
   * restarted only with no connection to it and no shell command running.
   * Returns what restarted.
   */
  async dropImageCdpClients(): Promise<string[]> {
    const script = `set -u
tabs=$(pgrep -fc "^node $1/tab-server.cjs" || true)
driver=$(ps -eo args | grep -c "[p]laywright/driver/node .*run-driver" || true)
conns=$(ss -tnH state established "( dport = :9222 )" | wc -l)
if [ $((conns - tabs - driver)) -gt 0 ]; then supervisorctl restart mcp-server-browser >/dev/null 2>&1 && echo mcp-server-browser; fi
if [ "$driver" -gt 0 ]; then
  busy=$(curl -s -m 5 http://127.0.0.1:8091/v1/shell/sessions | python3 -c 'import json,sys; s=json.load(sys.stdin)["data"]["sessions"].values(); print(sum(1 for v in s if v.get("status") != "completed" or v.get("current_command")))' 2>/dev/null || echo unknown)
  clients=$(ss -tnH state established "( sport = :8091 )" | wc -l)
  if [ "$busy" = 0 ] && [ "$clients" = 0 ]; then supervisorctl restart python-server >/dev/null 2>&1 && echo python-server; fi
fi`;
    const res = await this.execInSandbox(["sh", "-c", script, "sh", this.#cfg.browser.toolDir], { timeoutMs: 60_000, user: "root" });
    return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Unpack the configured Chromium packages into the root-managed tool directory,
   * once: a present build answers immediately. Every download must match its
   * pinned SHA-256, and the tree is built beside the target before replacing it;
   * builds from other configurations are removed once no process runs from them
   * (deleting a running browser's files hangs it). Returns the browser and the
   * library directory it needs, or null on another CPU architecture.
   */
  async ensureBrowserBuild(build: { packages: Array<{ url: string; sha256: string }>; arch: string }): Promise<{ binary: string; libraryPath: string } | null> {
    if (!build.packages.length || build.packages.some((p) => !/^[a-f0-9]{64}$/.test(p.sha256) || !/^https:\/\//.test(p.url))) {
      throw new Error("Invalid browser build package list");
    }
    const id = createHash("sha256").update(build.packages.map((p) => p.sha256).join(",")).digest("hex").slice(0, 12);
    const dir = path.posix.join(this.#cfg.browser.toolDir, `chromium-${id}`);
    const script = `set -eu
arch=$1 dir=$2; shift 2
[ "$(uname -m)" = "$arch" ] || { echo other-arch; exit 0; }
if [ ! -x "$dir/root/usr/lib/chromium/chromium" ]; then
  tmp=$(mktemp -d "$dir.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
  while [ $# -gt 0 ]; do
    curl -fsSL --retry 2 -o "$tmp/pkg.deb" "$1"
    echo "$2  $tmp/pkg.deb" | sha256sum -c - >/dev/null
    dpkg-deb -x "$tmp/pkg.deb" "$tmp/root"
    rm -f "$tmp/pkg.deb"; shift 2
  done
  chmod -R a+rX "$tmp"; rm -rf "$dir"; mv "$tmp" "$dir"
fi
# A build the running browser still uses goes on a later start, once the browser has moved off it.
for old in "$(dirname "$dir")"/chromium-*; do
  [ "$old" = "$dir" ] || grep -qsF "$old/" /proc/[0-9]*/cmdline || rm -rf "$old"
done
LD_LIBRARY_PATH="$dir/root/usr/lib/aarch64-linux-gnu" "$dir/root/usr/lib/chromium/chromium" --version >/dev/null
echo "$dir"`;
    const args = build.packages.flatMap((p) => [p.url, p.sha256]);
    const res = await this.execInSandbox(["sh", "-c", script, "sh", build.arch, dir, ...args], { user: "root", timeoutMs: 600_000 });
    const out = res.stdout.trim().split("\n").pop() ?? "";
    if (res.code !== 0 || !out) throw new Error(`Cannot install the browser build: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
    if (out === "other-arch") return null;
    return { binary: `${out}/root/usr/lib/chromium/chromium`, libraryPath: `${out}/root/usr/lib/aarch64-linux-gnu` };
  }

  /**
   * Make the sandbox Chromium present itself consistently, so sites do not take it
   * for a bot: the image spoofs a Mac user agent on a Linux browser (the page reads
   * `Linux x86_64` and the client hints disagree with the UA), pins a Singapore time
   * zone behind a US address, turns the GPU off so WebGL is missing, and runs with
   * site isolation off, which stalls Cloudflare's challenge. The image
   * rewrites the browser config on every container start, so this runs whenever the
   * sandbox comes up: it keeps Chromium's own (Linux) user agent, uses `timezone`,
   * enables WebGL (software rendering, left to ANGLE's own choice: forcing SwiftShader
   * also stalls Cloudflare), restores site isolation and sends the TLS extension
   * current Chrome sends; a running Chromium that still carries the
   * old identity is stopped gracefully and the image's supervisor starts it again
   * with the new config. `build` is the browser to run (a newer build from
   * `ensureBrowserBuild`, or null for the image's own); before a running profile first moves
   * to another binary it is archived to `backupPath`, since a newer Chromium
   * upgrades the profile in a way the old one cannot open. Returns true when
   * Chromium was restarted.
   */
  /**
   * Make the desktop work from a phone (see novncPatch): one keyboard tap types
   * one key, and a long press holds the left button. The image stays pinned; its
   * noVNC files are patched in place once per container. True when a file changed.
   */
  async patchNoVnc(): Promise<boolean> {
    // Imported modules first, then the files that load them under their new URLs.
    const rfb = await this.#patchFile(NOVNC_RFB_PATH, patchNoVncRfb);
    const ui = await this.#patchFile(NOVNC_UI_PATH, patchNoVncUi);
    const page = await this.#patchFile(NOVNC_HTML_PATH, patchNoVncHtml);
    return rfb || ui || page;
  }

  /** Rewrite one root-owned file in the container through `patch`; true when it changed. */
  async #patchFile(file: string, patch: (source: string) => string | null): Promise<boolean> {
    const read = await this.execInSandbox(["cat", file], { user: "root", timeoutMs: 20_000 });
    if (read.code !== 0) throw new Error(`${file} not readable: ${read.stderr.trim()}`);
    const patched = patch(read.stdout);
    if (patched === null) throw new Error(`${file} is not the version the keyboard patch knows`);
    if (patched === read.stdout) return false;
    const write = await this.execInSandbox(
      ["python3", "-c", "import os,sys; p=sys.argv[1]; t=p+'.aio-tmp'; open(t,'wb').write(sys.stdin.buffer.read()); os.chmod(t,0o644); os.replace(t,p)", file],
      { user: "root", stdin: patched, timeoutMs: 20_000 },
    );
    if (write.code !== 0) throw new Error(`${file} not patched: ${write.stderr.trim()}`);
    return true;
  }

  async alignBrowserIdentity(
    timezone: string,
    build: { binary: string; libraryPath: string } | null = null,
    backupPath = path.posix.join(this.#cfg.sandbox.containerCodexHome, "aio-browser", "profile-before-browser-change.tgz"),
  ): Promise<boolean> {
    const script = `
import json, os, signal, sys, tarfile
path = '/var/run/gem/browser-supervisor.json'
if not os.path.exists(path): print('absent'); raise SystemExit(0)
config = json.load(open(path))
browser = config.get('browser') or {}
tz, binary, libs, backup = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
# Cloudflare's challenge stalls with ANGLE forced onto SwiftShader or with site isolation off.
DROP = ('--disable-gpu', '--use-angle=swiftshader', '--disable-site-isolation-trials')
# The TLS extension current Chrome on Linux sends; without it eBay refuses the handshake.
PAD = 'AddTLSServerHandshakePadding'
old = list(browser.get('args') or [])
old_binary = browser.get('binary')
args, zoned, featured = [], False, False
for a in old:
    if a.startswith('--user-agent=') or a in DROP: continue
    if a.startswith('--time-zone-for-testing='):
        if zoned: continue
        a, zoned = '--time-zone-for-testing=' + tz, True
    if a.startswith('--enable-features='):
        feats = [f for f in a.split('=', 1)[1].split(',') if f]
        if PAD not in feats: feats.append(PAD)
        a, featured = '--enable-features=' + ','.join(feats), True
    args.append(a)
if not zoned: args.append('--time-zone-for-testing=' + tz)
if not featured: args.append('--enable-features=' + PAD)
for flag in ('--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'):
    if flag not in args: args.append(flag)
env = dict(browser.get('env') or {})
env['TZ'] = tz
if libs: env['LD_LIBRARY_PATH'] = libs
else: env.pop('LD_LIBRARY_PATH', None)
if args != old or env != (browser.get('env') or {}) or old_binary != binary:
    browser['args'] = args
    browser['env'] = env
    browser['binary'] = binary
    config['browser'] = browser
    with open(path + '.tmp', 'w') as f: json.dump(config, f, indent=2)
    os.chmod(path + '.tmp', 0o644)
    os.replace(path + '.tmp', path)
# Chrome-branded builds read managed policies from their own directory.
try:
    if not os.path.lexists('/etc/opt/chrome/policies') and os.path.isdir('/etc/chromium/policies'):
        os.makedirs('/etc/opt/chrome', exist_ok=True)
        os.symlink('/etc/chromium/policies', '/etc/opt/chrome/policies')
except OSError:
    pass
# Restart only a running Chromium that still carries the old identity or binary.
profile = browser.get('user_data_dir')
want = os.path.realpath(binary)
stale, moving = [], False
for pid in (os.listdir('/proc') if os.path.isdir('/proc') else []):
    if not pid.isdigit(): continue
    try: raw = open('/proc/%s/cmdline' % pid, 'rb').read()
    except OSError: continue
    # Chromium may rewrite its argv into one space-joined string.
    cmd = [x for x in raw.split(b'\\0') if x]
    if len(cmd) == 1: cmd = cmd[0].split(b' ')
    if not cmd or os.path.basename(cmd[0]) not in (b'chrome', b'chromium') or any(x.startswith(b'--type=') for x in cmd): continue
    if not profile or ('--user-data-dir=' + profile).encode() not in cmd: continue
    other = os.path.realpath(cmd[0].decode()) != want
    moving = moving or other
    padded = any(x.startswith(b'--enable-features=') and PAD.encode() in x.split(b'=', 1)[1].split(b',') for x in cmd)
    if other or not padded or any(x.startswith(b'--user-agent=') or x.decode() in DROP for x in cmd) or (b'--time-zone-for-testing=' + tz.encode()) not in cmd:
        stale.append(int(pid))
if moving and not os.path.exists(backup):
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    skip = ('Singleton', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache')
    with tarfile.open(backup + '.tmp', 'w:gz') as tar:
        tar.add(profile, arcname='browser', filter=lambda t: None if os.path.basename(t.name).startswith(skip) else t)
    os.chmod(backup + '.tmp', 0o600)
    os.replace(backup + '.tmp', backup)
for pid in stale: os.kill(pid, signal.SIGTERM)
print('restarted' if stale else 'same')
`;
    const result = await this.execInSandbox(["python3", "-c", script, timezone, build?.binary ?? IMAGE_BROWSER, build?.libraryPath ?? "", backupPath], { user: "root", timeoutMs: 120_000 });
    if (result.code !== 0) throw new Error(`Cannot align the sandbox browser: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout.trim() === "restarted";
  }

  async execInSandbox(
    argv: string[],
    opts: { timeoutMs?: number; user?: string; stdin?: string } = {},
  ): Promise<DockerRunResult> {
    const req: ExecRequest = { argv, user: opts.user ?? this.#cfg.sandbox.containerUser, timeoutMs: opts.timeoutMs ?? 60_000 };
    if (opts.stdin !== undefined) req.stdin = opts.stdin;
    return await this.#node.exec(this.name, req).catch(failed);
  }
}

/**
 * A command the node could not run (unreachable, refused, timed out) reads like
 * one that failed, as `docker exec` did when the daemon was down: callers check
 * the code and report it.
 */
function failed(err: unknown): DockerRunResult {
  return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
}

/** Python run inside the sandbox by `cpuPercent`; reads /proc only. */
function workCpuScript(seconds: number): string {
  return `import os, time
def snap():
    out = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or pid == str(os.getpid()):
            continue
        try:
            raw = open("/proc/%s/stat" % pid).read()
        except OSError:
            continue
        if raw[raw.index("(") + 1:raw.rindex(")")].startswith("chrom"):
            continue
        f = raw[raw.rindex(")") + 2:].split()
        out[pid] = sum(int(x) for x in f[11:15])
    return out
a = snap()
time.sleep(${seconds})
b = snap()
used = sum(v - a.get(p, 0) for p, v in b.items() if v >= a.get(p, 0))
print(used / os.sysconf("SC_CLK_TCK") / ${seconds} * 100)
`;
}
