import { execFile, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { CODEX_CONFIG_TOML, WORKSPACE_AGENTS_MD } from "./seed.js";

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
 * Owns exactly one named sandbox container. Every Docker invocation uses a fixed
 * argument list (never a shell), so no caller can smuggle extra flags or paths.
 */
export class SandboxContainer {
  #cfg: Config;
  #log: Logger;

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

  async docker(args: string[], opts: { timeoutMs?: number } = {}): Promise<DockerRunResult> {
    return await new Promise((resolve, reject) => {
      execFile("docker", args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("docker CLI not found on PATH"));
          return;
        }
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
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
    await this.#fixOwnership();
    await this.seedWorkspace();
    await this.ensurePrograms();
    await this.waitSurfaces();
    return await this.inspect();
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
    const args = [
      "run",
      "-d",
      "--name",
      this.name,
      "--restart",
      "unless-stopped",
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
    const script = opts.onlyIfAbsent ? `[ -f ${filePath} ] || cat > ${filePath}` : `cat > ${filePath}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "docker",
        ["exec", "-i", "-u", opts.user ?? this.#cfg.sandbox.containerUser, this.name, "bash", "-lc", script],
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
   * AGENTS.md is refreshed each start; config.toml is only created when absent so
   * the agent's own customisations are preserved.
   */
  async seedWorkspace(): Promise<void> {
    const s = this.#cfg.sandbox;
    await this.writeFileInSandbox(`${s.containerWorkspaceDir}/AGENTS.md`, WORKSPACE_AGENTS_MD);
    await this.writeFileInSandbox(`${s.containerCodexHome}/config.toml`, CODEX_CONFIG_TOML, { onlyIfAbsent: true });
  }

  /** Spawn `docker exec -i` with a fixed prefix for the sandbox Codex process. */
  spawnCodexAppServer(extraConfig: string[] = []): ChildProcess {
    const s = this.#cfg.sandbox;
    return spawn(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        s.containerUser,
        this.name,
        "env",
        `CODEX_HOME=${s.containerCodexHome}`,
        "codex",
        "app-server",
        "--listen",
        "stdio://",
        ...extraConfig,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  }

  /** Run a one-shot command inside the sandbox (fixed argv, no shell expansion by us). */
  async execInSandbox(argv: string[], opts: { timeoutMs?: number; user?: string } = {}): Promise<DockerRunResult> {
    return await this.docker(["exec", "-u", opts.user ?? this.#cfg.sandbox.containerUser, this.name, ...argv], {
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
  }
}
