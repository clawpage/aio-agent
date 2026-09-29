import { execFile, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import {
  CODEX_CONFIG_TOML,
  CODEX_ISOLATION_MARKER,
  CODEX_ISOLATION_OVERRIDES,
  CODEX_REQUIREMENTS_TOML,
  DOCUMENT_SKILL_DIR,
  DOCUMENT_SKILL_MD,
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
      ...(s.networkName ? ["--network", s.networkName,"--cap-drop","NET_RAW","--memory","2g","--cpus","2","--pids-limit","1024"] : []),
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
    await this.enforceCodexIsolation();
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
    const result = await this.execInSandbox(["python3", "-c", script, CODEX_ISOLATION_MARKER, CODEX_REQUIREMENTS_TOML], { user: "root" });
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
   * Run a one-shot command inside the sandbox (fixed argv, no shell expansion by
   * us). `stdin` is only ever control-plane content, never user input.
   */
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
