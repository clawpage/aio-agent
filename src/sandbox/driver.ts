import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../common/logger.js";
import type { ContainerState, ExecRequest, ExecResult, SandboxSpec } from "../common/protocol.js";
import type { SandboxdConfig } from "./config.js";
import type { DockerCli } from "./docker.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const USER = /^(?:[a-z_][a-z0-9_-]{0,31}|\d{1,6})$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTAINER_PATH = /^\/[^\0\n]*$/;
const GUARD_IMAGE = "aio-agent-network-guard:1";

/** Why a spec is refused, or null. Only named volumes and allowed images ever reach `docker run`. */
export function specError(spec: SandboxSpec, images: string[]): string | null {
  if (!spec || typeof spec !== "object") return "缺少沙箱参数";
  for (const key of ["name", "workspaceVolume", "codexVolume", "browserVolume"] as const) {
    // A name that starts with a letter or digit and has no slash is a named volume, never a host path.
    if (typeof spec[key] !== "string" || !NAME.test(spec[key])) return `沙箱参数 ${key} 不合法`;
  }
  if (!images.includes(spec.image)) return `镜像 ${String(spec.image)} 不在本节点允许的列表里`;
  if (!Number.isInteger(spec.hostPort) || spec.hostPort < 1024 || spec.hostPort > 65535) return "沙箱端口不合法";
  if (typeof spec.containerUser !== "string" || !USER.test(spec.containerUser)) return "沙箱用户不合法";
  for (const key of ["containerWorkspaceDir", "containerCodexHome"] as const) {
    if (typeof spec[key] !== "string" || !CONTAINER_PATH.test(spec[key])) return `沙箱参数 ${key} 不合法`;
  }
  if (!Array.isArray(spec.extraEnv) || spec.extraEnv.some((e) => typeof e !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=[^\0\n]*$/.test(e))) return "沙箱环境变量不合法";
  if (spec.member) {
    if (!NAME.test(String(spec.member.networkName))) return "沙箱网络名不合法";
    if (!validPort(spec.member.gatewayPort)) return "网关端口不合法";
  }
  if (spec.peerPorts !== undefined && (!Array.isArray(spec.peerPorts) || !spec.peerPorts.every(validPort))) return "端口列表不合法";
  return null;
}

/** Why a command is refused, or null. The command itself runs inside the sandbox, never on the node. */
export function execError(req: Pick<ExecRequest, "argv" | "user" | "workdir" | "env">): string | null {
  if (!Array.isArray(req.argv) || !req.argv.length || req.argv.some((a) => typeof a !== "string" || a.includes("\0"))) return "命令不合法";
  if (typeof req.user !== "string" || !USER.test(req.user)) return "沙箱用户不合法";
  if (req.workdir !== undefined && (typeof req.workdir !== "string" || !CONTAINER_PATH.test(req.workdir))) return "工作目录不合法";
  if (req.env !== undefined && (typeof req.env !== "object" || Object.entries(req.env).some(([k, v]) => !ENV_KEY.test(k) || typeof v !== "string" || v.includes("\0")))) return "环境变量不合法";
  return null;
}

function validPort(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;
}

/** `-e NAME` flags for values passed through the docker CLI's own environment. */
function envFlags(env: Record<string, string> = {}): string[] {
  return Object.keys(env).flatMap((name) => ["-e", name]);
}

/**
 * The Docker side of every sandbox on this node. Each operation is a fixed
 * argument list over a validated spec: container names, named volumes, the
 * allowed image and the published port are the only inputs that vary.
 */
export class SandboxDriver {
  #cfg: SandboxdConfig;
  #log: Logger;
  #docker: DockerCli;
  #specs = new Map<string, SandboxSpec>();
  #ports = new Map<string, number>();
  #managed = new Map<string, number>();
  #peerPolicy = new Map<string, Promise<void>>();
  #peers = new Map<string, number[]>();

  constructor(cfg: SandboxdConfig, log: Logger, docker: DockerCli) {
    this.#cfg = cfg;
    this.#log = log.child("driver");
    this.#docker = docker;
  }

  async inspect(name: string): Promise<ContainerState> {
    if (!NAME.test(name)) throw new Error("沙箱名不合法");
    const res = await this.#docker.run(
      ["inspect", "--format", '{{json .State}}|{{.Config.Image}}|{{index .Config.Labels "personal-agent.managed"}}|{{json .Mounts}}', name],
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
      /* malformed inspect output */
    }
    try {
      mounts = JSON.parse(mountsJson ?? "[]");
    } catch {
      /* malformed mount output */
    }
    return {
      exists: true,
      running: state.Status === "running",
      healthy: state.Health?.Status === "healthy" || (state.Status === "running" && !state.Health),
      image: image ?? null,
      startedAt: state.StartedAt ?? null,
      managedLabel: managedLabel ?? null,
      mounts: mounts.map((m) => ({ name: m.Name ?? "", source: m.Source ?? "", destination: m.Destination ?? "", type: m.Type ?? "" })),
    };
  }

  /**
   * Refuse to reuse a container that merely shares the name: only one this
   * system created (ownership label), from the spec's image, with the expected
   * volume mounts is accepted.
   */
  assertOwned(state: ContainerState, spec: SandboxSpec): void {
    if (!state.exists) return;
    if (state.managedLabel !== "1") {
      throw new Error(`容器名 ${spec.name} 已被非本系统创建的容器占用（缺少 personal-agent.managed=1 标签）。请先人工确认并重命名或移除该容器。`);
    }
    if (state.image && state.image !== spec.image) {
      throw new Error(`容器 ${spec.name} 使用的镜像 ${state.image} 与固定镜像 ${spec.image} 不一致，已停止自动接管。`);
    }
    const expected: Array<[string, string]> = [
      [spec.workspaceVolume, spec.containerWorkspaceDir],
      [spec.codexVolume, spec.containerCodexHome],
      [spec.browserVolume, "/home/gem/.config/browser"],
    ];
    for (const [volume, destination] of expected) {
      // Docker Desktop reports the source as an internal /var/lib/docker path, so match the name too.
      const found = state.mounts.some((m) => m.destination === destination && (m.name === volume || m.source.endsWith(volume) || m.source.includes(`${volume}/`)));
      if (!found) throw new Error(`容器 ${spec.name} 缺少持久卷挂载 ${volume} -> ${destination}，为避免数据丢失已停止接管。`);
    }
  }

  /** Create or start the container and bring it to the point where the control plane can provision it. */
  async ensure(spec: SandboxSpec, readyTimeoutMs: number): Promise<ContainerState> {
    const refused = specError(spec, this.#cfg.images);
    if (refused) throw new Error(refused);
    const state = await this.inspect(spec.name);
    this.assertOwned(state, spec);
    this.#specs.set(spec.name, spec);
    this.#ports.set(spec.name, spec.hostPort);
    if (!state.exists) {
      await this.#create(spec);
    } else if (!state.running) {
      const res = await this.#docker.run(["start", spec.name], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`failed to start sandbox: ${res.stderr.trim()}`);
    }
    // The image entrypoint creates the sandbox user during startup, so health and
    // the user come before any `docker exec -u <user>`.
    await this.#waitReady(spec, readyTimeoutMs);
    await this.#waitUserReady(spec);
    if (spec.member) await this.#isolateNetwork(spec);
    else if (spec.peerPorts?.length) await this.peerPorts(spec.name, spec.peerPorts);
    await this.#fixOwnership(spec);
    await this.#ensurePrograms(spec);
    this.#managed.set(spec.name, Date.now());
    return await this.inspect(spec.name);
  }

  async stop(name: string): Promise<void> {
    await this.#assertManaged(name);
    await this.#docker.run(["stop", "--time", "20", name], { timeoutMs: 60_000 });
  }

  async restart(name: string, readyTimeoutMs: number): Promise<ContainerState> {
    await this.#assertManaged(name);
    await this.#docker.run(["restart", "--time", "20", name], { timeoutMs: 180_000 });
    const port = await this.port(name);
    await this.#waitHealth(port, readyTimeoutMs);
    return await this.inspect(name);
  }

  async exec(name: string, req: ExecRequest): Promise<ExecResult> {
    const refused = execError(req);
    if (refused) throw new Error(refused);
    await this.#assertManaged(name);
    const flags = [...(req.detached ? ["-d"] : ["-i"]), "-u", req.user, ...(req.workdir ? ["-w", req.workdir] : []), ...envFlags(req.env)];
    return await this.#docker.run(["exec", ...flags, name, ...req.argv], { timeoutMs: req.detached ? 30_000 : req.timeoutMs ?? 60_000, stdin: req.stdin, env: req.env });
  }

  async spawn(name: string, req: Omit<ExecRequest, "stdin" | "timeoutMs" | "detached">): Promise<ChildProcess> {
    const refused = execError(req);
    if (refused) throw new Error(refused);
    await this.#assertManaged(name);
    return this.#docker.spawn(["exec", "-i", "-u", req.user, ...(req.workdir ? ["-w", req.workdir] : []), ...envFlags(req.env), name, ...req.argv], req.env);
  }

  /** Where the node reaches this sandbox's web port. */
  async target(name: string): Promise<{ host: string; port: number }> {
    await this.#assertManaged(name);
    return { host: this.#cfg.containerHost, port: await this.port(name) };
  }

  /** The node port publishing the sandbox's port 8080 (from its spec, else from Docker). */
  async port(name: string): Promise<number> {
    const known = this.#ports.get(name);
    if (known) return known;
    const res = await this.#docker.run(["inspect", "--format", '{{(index (index .HostConfig.PortBindings "8080/tcp") 0).HostPort}}', name], { timeoutMs: 15_000 });
    const port = Number(res.stdout.trim());
    if (res.code !== 0 || !validPort(port)) throw new Error(`沙箱 ${name} 没有发布网页端口`);
    this.#ports.set(name, port);
    return port;
  }

  /** Every managed sandbox on this node, with the machine's size. */
  async info(): Promise<{ docker: boolean; sandboxes: Array<{ name: string; running: boolean }>; memTotal: number | null; cpus: number | null }> {
    const [info, list] = await Promise.all([
      this.#docker.run(["info", "--format", "{{.MemTotal}}|{{.NCPU}}"], { timeoutMs: 15_000 }).catch(() => null),
      this.#docker.run(["ps", "-a", "--filter", "label=personal-agent.managed=1", "--format", "{{.Names}}|{{.State}}"], { timeoutMs: 15_000 }).catch(() => null),
    ]);
    const [mem, cpus] = (info?.code === 0 ? info.stdout.trim() : "").split("|").map(Number);
    const sandboxes = (list?.code === 0 ? list.stdout.trim().split("\n") : [])
      .filter(Boolean)
      .map((line) => {
        const [name = "", state = ""] = line.split("|");
        return { name, running: state === "running" };
      });
    return { docker: info?.code === 0, sandboxes, memTotal: Number.isFinite(mem) && mem ? mem : null, cpus: Number.isFinite(cpus) && cpus ? cpus : null };
  }

  /** Ports of other accounts' sandboxes this one must not reach; the set only grows. */
  peerPorts(name: string, ports: number[]): Promise<void> {
    if (!NAME.test(name) || !Array.isArray(ports) || !ports.every(validPort)) return Promise.reject(new Error("端口列表不合法"));
    const merged = [...new Set([...(this.#peers.get(name) ?? []), ...ports])];
    this.#peers.set(name, merged);
    const next = (this.#peerPolicy.get(name) ?? Promise.resolve()).catch(() => undefined).then(() => this.#applyPeerPorts(name, merged));
    this.#peerPolicy.set(name, next);
    return next;
  }

  async #assertManaged(name: string): Promise<void> {
    if (!NAME.test(name)) throw new Error("沙箱名不合法");
    const seen = this.#managed.get(name);
    if (seen && Date.now() - seen < 60_000) return;
    const state = await this.inspect(name);
    if (!state.exists) throw new Error(`沙箱 ${name} 不存在`);
    if (state.managedLabel !== "1") throw new Error(`容器 ${name} 不是本系统管理的沙箱`);
    this.#managed.set(name, Date.now());
  }

  async #create(spec: SandboxSpec): Promise<void> {
    for (const vol of [spec.workspaceVolume, spec.codexVolume, spec.browserVolume]) {
      const res = await this.#docker.run(["volume", "create", vol], { timeoutMs: 20_000 });
      if (res.code !== 0) throw new Error(`failed to create volume ${vol}: ${res.stderr.trim()}`);
    }
    // A fresh named volume is root-owned and the image starts Chromium at boot, long
    // before ownership is fixed; hand the mount root to the sandbox user first.
    const owned = await this.#docker.run(["run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "chown", "-v", `${spec.browserVolume}:/v`, spec.image, "1000:1000", "/v"], { timeoutMs: 60_000 });
    if (owned.code !== 0) throw new Error(`failed to prepare browser volume: ${owned.stderr.trim()}`);
    if (spec.member) {
      const found = await this.#docker.run(["network", "inspect", spec.member.networkName]);
      if (found.code !== 0) {
        const created = await this.#docker.run(["network", "create", "--label", "personal-agent.managed=1", "--opt", "com.docker.network.bridge.enable_icc=false", spec.member.networkName]);
        if (created.code !== 0) throw new Error("Unable to create isolated sandbox network");
      }
    }
    const args = [
      "run",
      "-d",
      "--name",
      spec.name,
      "--restart",
      "unless-stopped",
      // Every sandbox, the owner's included, is capped at 2 GB; members are also limited in CPU and processes.
      "--memory",
      "2g",
      ...(spec.member ? ["--network", spec.member.networkName, "--cap-drop", "NET_RAW", "--cpus", "2", "--pids-limit", "1024"] : []),
      ...(this.#cfg.addHostGateway ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "--label",
      "personal-agent.managed=1",
      "-p",
      `127.0.0.1:${spec.hostPort}:8080`,
      "-v",
      `${spec.workspaceVolume}:${spec.containerWorkspaceDir}`,
      "-v",
      `${spec.codexVolume}:${spec.containerCodexHome}`,
      "-v",
      `${spec.browserVolume}:/home/gem/.config/browser`,
      "-e",
      `WORKSPACE=${spec.containerWorkspaceDir}`,
      ...spec.extraEnv.flatMap((e) => ["-e", e]),
      spec.image,
    ];
    this.#log.info("creating sandbox container", { name: spec.name, image: spec.image, hostPort: spec.hostPort });
    const res = await this.#docker.run(args, { timeoutMs: 180_000 });
    if (res.code !== 0) throw new Error(`failed to create sandbox: ${res.stderr.trim()}`);
  }

  async #waitReady(spec: SandboxSpec, timeoutMs: number): Promise<void> {
    await this.#waitHealth(spec.hostPort, timeoutMs);
  }

  async #waitHealth(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${this.#cfg.containerHost}:${port}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return;
        lastError = `health ${res.status}`;
      } catch (err) {
        lastError = String(err);
      }
      await delay(2000);
    }
    throw new Error(`sandbox not ready after ${Math.round(timeoutMs / 1000)}s: ${lastError}`);
  }

  async #waitUserReady(spec: SandboxSpec, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      const res = await this.#docker.run(["exec", "-u", spec.containerUser, spec.name, "id", "-u", spec.containerUser], { timeoutMs: 15_000 });
      if (res.code === 0) return;
      last = res.stderr.trim();
      await delay(1000);
    }
    throw new Error(`sandbox user ${spec.containerUser} not ready after ${Math.round(timeoutMs / 1000)}s: ${last}`);
  }

  /** Apply policy from a trusted read-only helper; never elevate code inside an agent-writable container. */
  async #isolateNetwork(spec: SandboxSpec): Promise<void> {
    await this.#guardImage(spec.image);
    const port = spec.member!.gatewayPort;
    const script = `set -eu
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
    const applied = await this.#guard(spec.name, script, 60_000);
    if (applied.code !== 0) throw new Error("Unable to enforce member network isolation");
  }

  /** Prevent the owner's tools reaching member APIs through Docker Desktop host forwarding. */
  async #applyPeerPorts(name: string, ports: number[]): Promise<void> {
    const script = `set -eu
chain=AIO_PEERS_${Math.random().toString(16).slice(2, 14)}
iptables -N "$chain"
for ip in 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
  for port in ${ports.join(" ")}; do iptables -A "$chain" -d "$ip" -p tcp --dport "$port" -j REJECT; done
done
iptables -I OUTPUT 1 -j "$chain"
for old in $(iptables -S OUTPUT | awk '$1=="-A" && $3=="-j" && $4 ~ /^AIO_PEERS_/ {print $4}'); do
  if [ "$old" != "$chain" ]; then iptables -D OUTPUT -j "$old"; iptables -F "$old"; iptables -X "$old"; fi
done
# IPv6 host.docker.internal is another route to the same published ports.
chain6=AIO_PEERS_${Math.random().toString(16).slice(2, 14)}
ip6tables -N "$chain6"
for port in ${ports.join(" ")}; do ip6tables -A "$chain6" -d fc00::/7 -p tcp --dport "$port" -j REJECT; done
ip6tables -I OUTPUT 1 -j "$chain6"
for old in $(ip6tables -S OUTPUT | awk '$1=="-A" && $3=="-j" && $4 ~ /^AIO_PEERS_/ {print $4}'); do
  if [ "$old" != "$chain6" ]; then ip6tables -D OUTPUT -j "$old"; ip6tables -F "$old"; ip6tables -X "$old"; fi
done
`;
    const applied = await this.#guard(name, script);
    if (applied.code !== 0) throw new Error("Unable to restrict cross-account sandbox ports");
  }

  async #guardImage(base: string): Promise<void> {
    const exists = await this.#docker.run(["image", "inspect", GUARD_IMAGE, "--format", '{{ index .Config.Labels "aio.network-guard" }}']);
    if (exists.code !== 0) {
      const build = await this.#docker.run(["build", "-t", GUARD_IMAGE, "-"], {
        stdin: `FROM ${base}\nUSER root\nRUN apt-get update -qq && apt-get install -y -qq iptables && rm -rf /var/lib/apt/lists/*\nLABEL aio.network-guard="1"\nENTRYPOINT ["/bin/sh"]\n`,
        timeoutMs: 180_000,
      });
      if (build.code !== 0) throw new Error("Unable to build trusted network guard");
    } else if (exists.stdout.trim() !== "1") throw new Error("Network guard image ownership mismatch");
  }

  #guard(name: string, script: string, timeoutMs?: number): Promise<ExecResult> {
    return this.#docker.run(
      ["run", "--rm", "-i", "--network", `container:${name}`, "--read-only", "--user", "0", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges", GUARD_IMAGE],
      { stdin: script, ...(timeoutMs ? { timeoutMs } : {}) },
    );
  }

  /**
   * Directories the sandbox user must own. Mounting a named volume below
   * ~/.config makes Docker create the parent as root, which used to break
   * code-server, so the parent itself is included, not just the mounted child.
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

  async #fixOwnership(spec: SandboxSpec): Promise<void> {
    const dirs = SandboxDriver.FIXED_OWNERSHIP_DIRS;
    const script = `${dirs.map((d) => `mkdir -p ${d}`).join(" && ")} && chown -R 1000:1000 ${dirs.join(" ")}`;
    const res = await this.#docker.run(["exec", "-u", "root", spec.name, "bash", "-lc", script], { timeoutMs: 90_000 });
    if (res.code !== 0) throw new Error(`failed to prepare sandbox ownership: ${res.stderr.trim() || res.stdout.trim()}`);
  }

  /** Make sure the in-container supervisord programs we depend on run; only those are touched. */
  async #ensurePrograms(spec: SandboxSpec, programs = ["code-server"]): Promise<void> {
    for (const program of programs) {
      const res = await this.#docker.run(["exec", "-u", "root", spec.name, "supervisorctl", "status", program], { timeoutMs: 20_000 });
      const line = (res.stdout.trim() || res.stderr.trim()).split("\n")[0] ?? "";
      if (/FATAL|STOPPED|EXITED|BACKOFF|STARTING/.test(line)) {
        this.#log.warn("starting sandbox program", { program, status: line });
        await this.#docker.run(["exec", "-u", "root", spec.name, "supervisorctl", "start", program], { timeoutMs: 30_000 });
      }
    }
  }
}
