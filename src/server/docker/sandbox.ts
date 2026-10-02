import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { TAB_TOOL_TIMEOUT_SEC } from "../browser/tabs.js";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { NOVNC_UI_PATH, patchNoVncUi } from "./novncPatch.js";
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

export interface ContainerState {
  exists: boolean;
  running: boolean;
  healthy: boolean;
  image: string | null;
  startedAt: string | null;
  managedLabel: string | null;
  mounts: Array<{ name: string; source: string; destination: string; type: string }>;
}

export interface DockerRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

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
 * Owns exactly one named sandbox container. Every Docker invocation uses a fixed
 * argument list (never a shell), so no caller can smuggle extra flags or paths.
 */
export class SandboxContainer {
  #cfg: Config;
  #log: Logger;
  #peerPolicy:Promise<void>=Promise.resolve();

  constructor(cfg: Config, log: Logger) {
    this.#cfg = cfg;
    this.#log = log;
  }

  get name(): string {
    return this.#cfg.sandbox.containerName;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#cfg.sandbox.hostPort}`;
  }

  async docker(args: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<DockerRunResult> {
    return await new Promise((resolve, reject) => {
      const child = execFile(
        "docker",
        args,
        { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error("docker CLI not found on PATH"));
            return;
          }
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
      // `-i` is always passed to docker exec, so stdin must always be closed:
      // an open pipe would let a command that reads stdin wait forever. `stdin`
      // itself is only ever control-plane content - this is how a
      // control-plane-owned script reaches a root shell without being written to
      // a sandbox-writable path.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.stdin ?? "");
    });
  }

  async inspect(): Promise<ContainerState> {
    const res = await this.docker(
      [
        "inspect",
        "--format",
        '{{json .State}}|{{.Config.Image}}|{{index .Config.Labels "personal-agent.managed"}}|{{json .Mounts}}',
        this.name,
      ],
      { timeoutMs: 15_000 },
    );
    if (res.code !== 0 || !res.stdout.trim()) {
      return { exists: false, running: false, healthy: false, image: null, startedAt: null, managedLabel: null, mounts: [] };
    }
    const [stateJson, image, managedLabel, mountsJson] = res.stdout.trim().split("|");
    let state: { Status?: string; Health?: { Status?: string }; StartedAt?: string } = {};
    let mounts: Array<{ Name?: string; Source?: string; Destination?: string; Type?: string }> = [];
    try {
      state = JSON.parse(stateJson);
    } catch {
      /* ignore malformed inspect output */
    }
    try {
      mounts = JSON.parse(mountsJson ?? "[]");
    } catch {
      /* ignore malformed mount output */
    }
    return {
      exists: true,
      running: state.Status === "running",
      healthy: state.Health?.Status === "healthy" || (state.Status === "running" && !state.Health),
      image: image ?? null,
      startedAt: state.StartedAt ?? null,
      managedLabel: managedLabel ?? null,
      mounts: mounts.map((m) => ({
        name: m.Name ?? "",
        source: m.Source ?? "",
        destination: m.Destination ?? "",
        type: m.Type ?? "",
      })),
    };
  }

  /**
   * Refuse to reuse a container that merely shares our name. Only a container we
   * created (ownership label), from the pinned image, with the expected volume
   * mounts is accepted; anything else is an operator-visible error.
   */
  assertOwned(state: ContainerState): void {
    if (!state.exists) return;
    const s = this.#cfg.sandbox;
    if (state.managedLabel !== "1") {
      throw new Error(
        `容器名 ${this.name} 已被非本系统创建的容器占用（缺少 personal-agent.managed=1 标签）。请先人工确认并重命名或移除该容器。`,
      );
    }
    if (state.image && state.image !== s.image) {
      throw new Error(`容器 ${this.name} 使用的镜像 ${state.image} 与固定镜像 ${s.image} 不一致，已停止自动接管。`);
    }
    const expected: Array<[string, string]> = [
      [s.workspaceVolume, s.containerWorkspaceDir],
      [s.codexVolume, s.containerCodexHome],
      [s.browserVolume, "/home/gem/.config/browser"],
    ];
    for (const [volume, destination] of expected) {
      // Docker Desktop reports the bind source as an internal /var/lib/docker path,
      // so match on the volume name as well as the source path.
      const found = state.mounts.some(
        (m) => m.destination === destination && (m.name === volume || m.source.endsWith(volume) || m.source.includes(`${volume}/`)),
      );
      if (!found) {
        throw new Error(`容器 ${this.name} 缺少持久卷挂载 ${volume} -> ${destination}，为避免数据丢失已停止接管。`);
      }
    }
  }

  async ensureVolumes(): Promise<void> {
    const { workspaceVolume, codexVolume, browserVolume } = this.#cfg.sandbox;
    for (const vol of [workspaceVolume, codexVolume, browserVolume]) {
      const res = await this.docker(["volume", "create", vol], { timeoutMs: 20_000 });
      if (res.code !== 0) throw new Error(`failed to create volume ${vol}: ${res.stderr.trim()}`);
    }
  }

  async ensureRunning(): Promise<ContainerState> {
    const state = await this.inspect();
    this.assertOwned(state);
    if (!state.exists) {
      await this.create();
    } else if (!state.running) {
      const res = await this.docker(["start", this.name], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`failed to start sandbox: ${res.stderr.trim()}`);
    }
    // Order matters: the image entrypoint creates the `gem` user during startup,
    // so health + user availability must be confirmed before any `docker exec -u gem`.
    await this.waitReady();
    await this.waitUserReady();
    if(this.#cfg.memberRuntime) await this.isolateNetwork();
    else if(this.#cfg.protectedMemberPorts?.length)await this.protectMemberPorts(this.#cfg.protectedMemberPorts);
    await this.#fixOwnership();
    await this.ensureCodexCli();
    await this.seedWorkspace();
    await this.ensurePrograms();
    await this.waitSurfaces();
    return await this.inspect();
  }

  /** Apply policy from a trusted read-only helper, never elevate code inside an agent-writable container. */
  async isolateNetwork():Promise<void> {
    const image="aio-agent-network-guard:1";
    const exists=await this.docker(["image","inspect",image,"--format","{{ index .Config.Labels \"aio.network-guard\" }}"]);
    if(exists.code!==0){
      const build=await this.docker(["build","-t",image,"-"],{stdin:`FROM ${this.#cfg.sandbox.image}\nUSER root\nRUN apt-get update -qq && apt-get install -y -qq iptables && rm -rf /var/lib/apt/lists/*\nLABEL aio.network-guard="1"\nENTRYPOINT ["/bin/sh"]\n`,timeoutMs:180_000});
      if(build.code!==0)throw new Error("Unable to build trusted network guard");
    }else if(exists.stdout.trim()!=="1")throw new Error("Network guard image ownership mismatch");
    const port=this.#cfg.memberModelPort??4902;
    const script=`set -eu
for family in 4 6; do
  if [ "$family" = 4 ]; then
    restore=iptables-restore
    private="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
  else
    restore=ip6tables-restore
    private="::/128 ::1/128 fc00::/7 fe80::/10 ff00::/8"
  fi
  {
    echo '*filter'
    echo ':INPUT ACCEPT [0:0]'
    echo ':FORWARD DROP [0:0]'
    echo ':OUTPUT ACCEPT [0:0]'
    echo ':AIO_MEMBER - [0:0]'
    echo '-A OUTPUT -j AIO_MEMBER'
    echo '-A AIO_MEMBER -o lo -j ACCEPT'
    echo '-A AIO_MEMBER -m conntrack --ctdir REPLY --ctstate ESTABLISHED,RELATED -j ACCEPT'
    if [ "$family" = 4 ]; then
      for ip in $(getent ahostsv4 host.docker.internal | awk '{print $1}' | sort -u); do
        echo "-A AIO_MEMBER -d $ip -p tcp --dport ${port} -j ACCEPT"
      done
    fi
    for ip in $private; do echo "-A AIO_MEMBER -d $ip -j REJECT"; done
    echo COMMIT
  } | $restore
done
`;
    const applied=await this.docker(["run","--rm","-i","--network",`container:${this.name}`,"--read-only","--user","0","--cap-drop","ALL","--cap-add","NET_ADMIN","--security-opt","no-new-privileges",image],{stdin:script,timeoutMs:60_000});
    if(applied.code!==0)throw new Error("Unable to enforce member network isolation");
  }

  /** Prevent owner tools accidentally reaching member APIs through Docker Desktop host forwarding. */
  protectMemberPorts(ports:number[]):Promise<void>{
    if(ports.some(p=>!Number.isInteger(p)||p<1||p>65535))return Promise.reject(new Error("Invalid peer port"));
    this.#cfg.protectedMemberPorts=[...new Set([...(this.#cfg.protectedMemberPorts??[]),...ports])];
    const next=this.#peerPolicy.catch(()=>{}).then(()=>this.#applyPeerPorts(this.#cfg.protectedMemberPorts!));
    this.#peerPolicy=next;return next;
  }
  async #applyPeerPorts(ports:number[]):Promise<void>{
    if(ports.some(p=>!Number.isInteger(p)||p<1||p>65535))throw new Error("Invalid peer port");
    this.#cfg.protectedMemberPorts=[...ports];
    const script=`set -eu
chain=AIO_PEERS_${Math.random().toString(16).slice(2,14)}
iptables -N "$chain"
for ip in 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
  for port in ${ports.join(' ')}; do iptables -A "$chain" -d "$ip" -p tcp --dport "$port" -j REJECT; done
done
iptables -I OUTPUT 1 -j "$chain"
for old in $(iptables -S OUTPUT | awk '$1=="-A" && $3=="-j" && $4 ~ /^AIO_PEERS_/ {print $4}'); do
  if [ "$old" != "$chain" ]; then iptables -D OUTPUT -j "$old"; iptables -F "$old"; iptables -X "$old"; fi
done
# IPv6 host.docker.internal is another route to the same published ports.
chain6=AIO_PEERS_${Math.random().toString(16).slice(2,14)}
ip6tables -N "$chain6"
for port in ${ports.join(' ')}; do ip6tables -A "$chain6" -d fc00::/7 -p tcp --dport "$port" -j REJECT; done
ip6tables -I OUTPUT 1 -j "$chain6"
for old in $(ip6tables -S OUTPUT | awk '$1=="-A" && $3=="-j" && $4 ~ /^AIO_PEERS_/ {print $4}'); do
  if [ "$old" != "$chain6" ]; then ip6tables -D OUTPUT -j "$old"; ip6tables -F "$old"; ip6tables -X "$old"; fi
done
`;
    const applied=await this.docker(["run","--rm","-i","--network",`container:${this.name}`,"--read-only","--user","0","--cap-drop","ALL","--cap-add","NET_ADMIN","--security-opt","no-new-privileges","aio-agent-network-guard:1"],{stdin:script});
    if(applied.code!==0)throw new Error("Unable to restrict cross-account sandbox ports");
  }

  /** Wait until the sandbox user exists inside the container. */
  async waitUserReady(timeoutMs = 60_000): Promise<void> {
    const user = this.#cfg.sandbox.containerUser;
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      const res = await this.docker(["exec", "-u", user, this.name, "id", "-u", user], { timeoutMs: 15_000 });
      if (res.code === 0) return;
      last = res.stderr.trim();
      await delay(1000);
    }
    throw new Error(`sandbox user ${user} not ready after ${Math.round(timeoutMs / 1000)}s: ${last}`);
  }

  async create(): Promise<void> {
    const s = this.#cfg.sandbox;
    await this.ensureVolumes();
    // A fresh named volume is root-owned, and the image starts Chromium at boot, long
    // before #fixOwnership runs; the browser then dies on EACCES with no snapshot to
    // restore. Hand the mount root to the sandbox user before the first boot.
    const owned = await this.docker(["run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "chown", "-v", `${s.browserVolume}:/v`, s.image, "1000:1000", "/v"], { timeoutMs: 60_000 });
    if (owned.code !== 0) throw new Error(`failed to prepare browser volume: ${owned.stderr.trim()}`);
    if (s.networkName) {
      const found = await this.docker(["network", "inspect", s.networkName]);
      if (found.code !== 0) {
        const created = await this.docker(["network", "create", "--label", "personal-agent.managed=1", "--opt", "com.docker.network.bridge.enable_icc=false", s.networkName]);
        if (created.code !== 0) throw new Error("Unable to create isolated sandbox network");
      }
    }
    const args = [
      "run",
      "-d",
      "--name",
      this.name,
      "--restart",
      "unless-stopped",
      // Every sandbox, the owner's included, is capped at 2 GB; members are also limited in CPU and processes.
      "--memory", "2g",
      ...(s.networkName ? ["--network", s.networkName,"--cap-drop","NET_RAW","--cpus","2","--pids-limit","1024"] : []),
      "--label",
      "personal-agent.managed=1",
      "-p",
      `127.0.0.1:${s.hostPort}:8080`,
      "-v",
      `${s.workspaceVolume}:${s.containerWorkspaceDir}`,
      "-v",
      `${s.codexVolume}:${s.containerCodexHome}`,
      "-v",
      `${s.browserVolume}:/home/gem/.config/browser`,
      "-e",
      `WORKSPACE=${s.containerWorkspaceDir}`,
      ...s.extraEnv.flatMap((e) => ["-e", e]),
      s.image,
    ];
    this.#log.info("creating sandbox container", { name: this.name, image: s.image, hostPort: s.hostPort });
    const res = await this.docker(args, { timeoutMs: 180_000 });
    if (res.code !== 0) throw new Error(`failed to create sandbox: ${res.stderr.trim()}`);
  }

  /**
   * Directories the sandbox user must own. Mounting a named volume below
   * ~/.config makes Docker create the parent as root, which used to break
   * code-server (EACCES mkdir '~/.config/code-server'), so the parent itself is
   * included — not just the mounted child.
   */
  static readonly FIXED_OWNERSHIP_DIRS = [
    "/home/gem/workspace",
    "/home/gem/.codex",
    "/home/gem/.config",
    "/home/gem/.config/browser",
    "/home/gem/.config/code-server",
    "/home/gem/.local/share/code-server",
    "/home/gem/.local/share/jupyter",
    "/home/gem/.jupyter",
  ];

  async #fixOwnership(): Promise<void> {
    const dirs = SandboxContainer.FIXED_OWNERSHIP_DIRS;
    const script = `${dirs.map((d) => `mkdir -p ${d}`).join(" && ")} && chown -R 1000:1000 ${dirs.join(" ")}`;
    const res = await this.docker(["exec", "-u", "root", this.name, "bash", "-lc", script], { timeoutMs: 90_000 });
    if (res.code !== 0) {
      throw new Error(`failed to prepare sandbox ownership: ${res.stderr.trim() || res.stdout.trim()}`);
    }
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
    const probe = await this.docker(["exec", "-u", s.containerUser, this.name, s.codexBin, "--version"], { timeoutMs: 30_000 });
    const found = parseCodexVersion(probe.stdout);
    if (probe.code === 0 && found === s.codexVersion) return { version: found, installed: false };

    this.#log.warn("installing pinned sandbox codex cli", {
      wanted: s.codexVersion,
      found: found ?? (probe.stdout.trim() || probe.stderr.trim()),
      prefix: s.codexPrefix,
    });
    const install = await this.docker(
      [
        "exec",
        "-u",
        s.containerUser,
        this.name,
        "npm",
        "install",
        "--prefix",
        s.codexPrefix,
        "--no-audit",
        "--no-fund",
        `@openai/codex@${s.codexVersion}`,
      ],
      { timeoutMs: 600_000 },
    );
    if (install.code !== 0) {
      throw new Error(
        `沙箱 Codex CLI 安装失败（需要 @openai/codex@${s.codexVersion}）：${install.stderr.trim() || install.stdout.trim()}`,
      );
    }
    const verify = await this.docker(["exec", "-u", s.containerUser, this.name, s.codexBin, "--version"], { timeoutMs: 30_000 });
    const installed = parseCodexVersion(verify.stdout);
    if (verify.code !== 0 || installed !== s.codexVersion) {
      throw new Error(
        `沙箱 Codex CLI 安装后校验失败：期望 ${s.codexVersion}，实际 ${installed ?? (verify.stdout.trim() || verify.stderr.trim())}`,
      );
    }
    return { version: s.codexVersion, installed: true };
  }

  /**
   * Make sure the in-container supervisord programs we depend on are running.
   * Only the named programs are touched — never the whole supervisor.
   */
  async ensurePrograms(programs = ["code-server"]): Promise<Record<string, string>> {
    const statuses: Record<string, string> = {};
    for (const program of programs) {
      const res = await this.docker(["exec", "-u", "root", this.name, "supervisorctl", "status", program], {
        timeoutMs: 20_000,
      });
      const line = (res.stdout.trim() || res.stderr.trim()).split("\n")[0] ?? "";
      statuses[program] = line;
      if (/FATAL|STOPPED|EXITED|BACKOFF|STARTING/.test(line)) {
        this.#log.warn("starting sandbox program", { program, status: line });
        await this.docker(["exec", "-u", "root", this.name, "supervisorctl", "start", program], { timeoutMs: 30_000 });
      }
    }
    return statuses;
  }

  /** Reachability of the sandbox's own web surfaces, probed through the published port. */
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
          const res = await fetch(`${this.baseUrl}${path}`, { redirect: "manual", signal: AbortSignal.timeout(6000) });
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

  async waitReady(timeoutMs = this.#cfg.sandbox.readyTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return;
        lastError = `health ${res.status}`;
      } catch (err) {
        lastError = String(err);
      }
      await delay(2000);
    }
    throw new Error(`sandbox not ready after ${Math.round(timeoutMs / 1000)}s: ${lastError}`);
  }

  async isReady(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(4000) });
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
    const res = await this.docker(["exec", "-i", this.name, "python3", "-"], { stdin: workCpuScript(seconds), timeoutMs: (seconds + 20) * 1000 });
    const value = Number(res.stdout.trim());
    return res.code === 0 && res.stdout.trim() !== "" && Number.isFinite(value) ? value : null;
  }

  async stop(): Promise<void> {
    await this.docker(["stop", "--time", "20", this.name], { timeoutMs: 60_000 });
  }

  async restart(): Promise<ContainerState> {
    await this.docker(["restart", "--time", "20", this.name], { timeoutMs: 180_000 });
    await this.waitReady();
    return await this.inspect();
  }

  /** Write a file inside the sandbox by streaming content to stdin (content is never shell-interpolated). */
  async writeFileInSandbox(
    filePath: string,
    content: string,
    opts: { user?: string; onlyIfAbsent?: boolean } = {},
  ): Promise<void> {
    const script = opts.onlyIfAbsent ? '[ -f "$1" ] || cat > "$1"' : 'cat > "$1"';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "docker",
        ["exec", "-i", "-u", opts.user ?? this.#cfg.sandbox.containerUser, this.name, "bash", "-lc", script, "write-file", filePath],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`failed to write ${filePath}: ${stderr.trim()}`)),
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(content);
    });
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
    const envFlags = Object.keys(secretEnv).flatMap((name) => ["-e", name]);
    return spawn(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        s.containerUser,
        ...envFlags,
        this.name,
        "env",
        `CODEX_HOME=${s.containerCodexHome}`,
        s.codexBin,
        "app-server",
        "--listen",
        "stdio://",
        ...extraConfig,
        ...CODEX_ISOLATION_OVERRIDES,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...secretEnv } },
    );
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
    const probe = await this.docker(["exec", "-u", user, this.name, c.bin, "--version"], { timeoutMs: 30_000 });
    if (probe.code !== 0 || !probe.stdout.startsWith(`${c.version} `)) {
      this.#log.warn("installing pinned sandbox claude code cli", { wanted: c.version, prefix: c.prefix });
      const install = await this.docker(
        ["exec", "-u", user, this.name, "npm", "install", "--prefix", c.prefix, "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${c.version}`],
        { timeoutMs: 600_000 },
      );
      if (install.code !== 0) {
        throw new Error(`沙箱 Claude Code CLI 安装失败（需要 @anthropic-ai/claude-code@${c.version}）：${install.stderr.trim() || install.stdout.trim()}`);
      }
      const verify = await this.docker(["exec", "-u", user, this.name, c.bin, "--version"], { timeoutMs: 30_000 });
      if (verify.code !== 0 || !verify.stdout.startsWith(`${c.version} `)) {
        throw new Error(`沙箱 Claude Code CLI 安装后校验失败：期望 ${c.version}，实际 ${verify.stdout.trim() || verify.stderr.trim()}`);
      }
    }
    const memory = claudeCodeUserMemory(this.#cfg.sandbox.containerWorkspaceDir, this.#cfg.sandbox.containerCodexHome);
    const seeded = await this.docker(
      ["exec", "-i", "-u", user, this.name, "sh", "-c", 'mkdir -p "$1" && cat > "$1/CLAUDE.md"', "sh", c.configDir],
      { stdin: memory, timeoutMs: 30_000 },
    );
    if (seeded.code !== 0) throw new Error(`Claude Code 配置目录初始化失败：${seeded.stderr.trim()}`);
  }

  /** Whether the Claude Code session file for this UUID has been written yet. */
  async claudeSessionExists(sessionId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) return false;
    const res = await this.docker(
      ["exec", "-u", this.#cfg.sandbox.containerUser, this.name, "find", path.posix.join(this.#cfg.claudeCode.configDir, "projects"), "-maxdepth", "2", "-name", `${sessionId}.jsonl`],
      { timeoutMs: 30_000 },
    );
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  /** Last resort after an unanswered interrupt: the CLI's argv carries its session UUID. */
  async killClaudeSession(sessionId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) return;
    await this.docker(["exec", "-u", this.#cfg.sandbox.containerUser, this.name, "pkill", "-KILL", "-f", sessionId], { timeoutMs: 15_000 });
  }

  /** One Claude Code print-mode process speaking stream-json over stdio. */
  spawnClaude(args: string[], secretEnv: Record<string, string>): ChildProcess {
    const s = this.#cfg.sandbox;
    const envFlags = Object.keys(secretEnv).flatMap((name) => ["-e", name]);
    return spawn(
      "docker",
      [
        "exec", "-i", "-u", s.containerUser, "-w", s.containerWorkspaceDir, ...envFlags, this.name,
        "env", `CLAUDE_CONFIG_DIR=${this.#cfg.claudeCode.configDir}`, "DISABLE_AUTOUPDATER=1",
        // A browser hand-over waits up to 30 minutes for the person inside one tool call.
        `MCP_TOOL_TIMEOUT=${TAB_TOOL_TIMEOUT_SEC * 1000}`,
        this.#cfg.claudeCode.bin, ...args,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...secretEnv } },
    );
  }

  /** Start a long-running sandbox process detached from this control plane (fixed argv). */
  async execDetached(argv: string[], opts: { user?: string; env?: Record<string, string> } = {}): Promise<DockerRunResult> {
    const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return await this.docker(["exec", "-d", "-u", opts.user ?? this.#cfg.sandbox.containerUser, ...envFlags, this.name, ...argv], { timeoutMs: 30_000 });
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
   * Stop one phone keyboard tap from typing twice on the desktop (see
   * novncPatch). The image stays pinned; its noVNC file is patched in place once
   * per container. True when it changed the file.
   */
  async patchNoVnc(): Promise<boolean> {
    const read = await this.docker(["exec", this.name, "cat", NOVNC_UI_PATH], { timeoutMs: 20_000 });
    if (read.code !== 0) throw new Error(`noVNC not readable: ${read.stderr.trim()}`);
    const patched = patchNoVncUi(read.stdout);
    if (patched === null) throw new Error("noVNC is not the version the keyboard patch knows");
    if (patched === read.stdout) return false;
    const write = await this.docker(
      ["exec", "-i", "-u", "root", this.name, "python3", "-c",
        "import os,sys; p=sys.argv[1]; t=p+'.aio-tmp'; open(t,'wb').write(sys.stdin.buffer.read()); os.chmod(t,0o644); os.replace(t,p)", NOVNC_UI_PATH],
      { stdin: patched, timeoutMs: 20_000 },
    );
    if (write.code !== 0) throw new Error(`noVNC not patched: ${write.stderr.trim()}`);
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
    return await this.docker(
      ["exec", "-i", "-u", opts.user ?? this.#cfg.sandbox.containerUser, this.name, ...argv],
      { timeoutMs: opts.timeoutMs ?? 60_000, stdin: opts.stdin },
    );
  }
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
