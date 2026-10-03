import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { Logger } from "../../src/common/logger.js";
import type { ExecResult, SandboxSpec } from "../../src/common/protocol.js";
import { execError, SandboxDriver, specError } from "../../src/sandbox/driver.js";
import type { DockerCli } from "../../src/sandbox/docker.js";
import { loadSandboxdConfig, type SandboxdConfig } from "../../src/sandbox/config.js";

const IMAGE = "ghcr.io/agent-infra/sandbox:1.11.0";

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    name: "aio-user-abc",
    image: IMAGE,
    hostPort: 18082,
    workspaceVolume: "aio-user-abc-workspace",
    codexVolume: "aio-user-abc-codex",
    browserVolume: "aio-user-abc-browser",
    containerWorkspaceDir: "/home/gem/workspace",
    containerCodexHome: "/home/gem/.codex",
    containerUser: "gem",
    extraEnv: ["BROWSER_NO_SANDBOX=--no-sandbox"],
    ...over,
  };
}

function config(over: Partial<SandboxdConfig> = {}): SandboxdConfig {
  return { port: 0, bind: "127.0.0.1", tokenFile: "", images: [IMAGE], containerHost: "127.0.0.1", addHostGateway: false, memory: "2g", logDir: null, gateway: null, ...over };
}

/** Records every docker call and answers like a container that does not exist yet. */
class FakeDocker {
  calls: Array<{ args: string[]; stdin?: string; env?: Record<string, string> }> = [];
  spawned: Array<{ args: string[]; env: Record<string, string> }> = [];
  created = false;
  managed = true;
  async run(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    this.calls.push({ args, stdin: opts.stdin, env: opts.env });
    if (args[0] === "inspect" && args.includes("--format") && args[2]!.startsWith("{{json .State}}")) {
      if (!this.created) return { code: 1, stdout: "", stderr: "No such container" };
      const mounts = [
        { Name: "aio-user-abc-workspace", Destination: "/home/gem/workspace" },
        { Name: "aio-user-abc-codex", Destination: "/home/gem/.codex" },
        { Name: "aio-user-abc-browser", Destination: "/home/gem/.config/browser" },
      ];
      return { code: 0, stdout: `{"Status":"running"}|${IMAGE}|${this.managed ? "1" : ""}|${JSON.stringify(mounts)}`, stderr: "" };
    }
    if (args[0] === "run" && args[1] === "-d") this.created = true;
    if (args[0] === "image") return { code: 0, stdout: "1", stderr: "" };
    if (args.includes("supervisorctl")) return { code: 0, stdout: "code-server RUNNING", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  spawn(args: string[], env: Record<string, string> = {}): ChildProcess {
    this.spawned.push({ args, env });
    return {} as ChildProcess;
  }
}

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A stand-in for the container's own health endpoint on its published port. */
async function healthServer(): Promise<number> {
  const server = http.createServer((_req, res) => res.writeHead(200).end("ok"));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const log = new Logger("error", undefined, false);

describe("sandbox node driver", () => {
  it("creates a member sandbox: browser volume handed over first, own network, caps, only named volumes", async () => {
    const docker = new FakeDocker();
    const driver = new SandboxDriver(config(), log, docker as unknown as DockerCli);
    const port = await healthServer();
    const state = await driver.ensure(spec({ hostPort: port, member: { networkName: "aio-user-abc", gatewayPort: 4902 } }), 10_000);
    expect(state).toMatchObject({ exists: true, running: true, managedLabel: "1" });
    const chown = docker.calls.findIndex((c) => c.args[0] === "run" && c.args.includes("chown"));
    const boot = docker.calls.findIndex((c) => c.args[0] === "run" && c.args[1] === "-d");
    expect(chown).toBeGreaterThanOrEqual(0);
    expect(chown).toBeLessThan(boot);
    expect(docker.calls[chown]!.args).toEqual(expect.arrayContaining(["--network", "none", "aio-user-abc-browser:/v", "1000:1000", "/v"]));
    const run = docker.calls[boot]!.args;
    expect(run[run.indexOf("--memory") + 1]).toBe("2g");
    expect(run).toEqual(expect.arrayContaining(["--network", "aio-user-abc", "--cpus", "2", "--pids-limit", "1024", "-p", `127.0.0.1:${port}:8080`]));
    // Every -v is one of the three named volumes; there is no way to name a host path.
    const volumes = run.flatMap((a, i) => (a === "-v" ? [run[i + 1]!] : []));
    expect(volumes.map((v) => v.split(":")[0])).toEqual(["aio-user-abc-workspace", "aio-user-abc-codex", "aio-user-abc-browser"]);
    expect(run).not.toContain("--add-host");
    // The member's outbound guard runs from the trusted helper image, sharing only its network.
    expect(docker.calls.some((c) => c.args.includes("container:aio-user-abc") && c.stdin?.includes("--dport 4902"))).toBe(true);
  });

  it("caps the owner's sandbox at 2 GB without member limits and guards the given peer ports", async () => {
    const docker = new FakeDocker();
    const driver = new SandboxDriver(config({ addHostGateway: true }), log, docker as unknown as DockerCli);
    const port = await healthServer();
    await driver.ensure(spec({ name: "personal-agent-sandbox", hostPort: port, peerPorts: [18082, 18083] }), 10_000);
    const run = docker.calls.find((c) => c.args[0] === "run" && c.args[1] === "-d")!.args;
    expect(run[run.indexOf("--memory") + 1]).toBe("2g");
    expect(run).not.toContain("--cpus");
    expect(run).toEqual(expect.arrayContaining(["--add-host", "host.docker.internal:host-gateway"]));
    expect(docker.calls.some((c) => c.args.includes("container:personal-agent-sandbox") && c.stdin?.includes("18082 18083"))).toBe(true);
  });

  it("gives new sandboxes the node's own memory cap", async () => {
    const docker = new FakeDocker();
    const driver = new SandboxDriver(config({ memory: "4g" }), log, docker as unknown as DockerCli);
    const port = await healthServer();
    await driver.ensure(spec({ hostPort: port, member: { networkName: "aio-user-abc", gatewayPort: 4902 } }), 10_000);
    const run = docker.calls.find((c) => c.args[0] === "run" && c.args[1] === "-d")!.args;
    expect(run[run.indexOf("--memory") + 1]).toBe("4g");
  });

  it("reads the node's memory cap, 2 GB by default, and refuses a malformed one", () => {
    const saved = process.env.PA_SANDBOXD_MEMORY;
    try {
      delete process.env.PA_SANDBOXD_MEMORY;
      expect(loadSandboxdConfig().memory).toBe("2g");
      process.env.PA_SANDBOXD_MEMORY = "4g";
      expect(loadSandboxdConfig().memory).toBe("4g");
      process.env.PA_SANDBOXD_MEMORY = "4 GB";
      expect(() => loadSandboxdConfig()).toThrow(/PA_SANDBOXD_MEMORY/);
    } finally {
      if (saved === undefined) delete process.env.PA_SANDBOXD_MEMORY;
      else process.env.PA_SANDBOXD_MEMORY = saved;
    }
  });

  it("refuses specs that could reach the host, and commands it cannot pass through intact", () => {
    expect(specError(spec(), [IMAGE])).toBeNull();
    expect(specError(spec({ image: "alpine:latest" }), [IMAGE])).toContain("不在本节点允许");
    expect(specError(spec({ workspaceVolume: "/Users/me" }), [IMAGE])).toContain("workspaceVolume");
    expect(specError(spec({ codexVolume: "./here" }), [IMAGE])).toContain("codexVolume");
    expect(specError(spec({ name: "x;rm" }), [IMAGE])).toContain("name");
    expect(specError(spec({ extraEnv: ["A=1\nB=2"] }), [IMAGE])).toContain("环境变量");
    expect(specError(spec({ hostPort: 80 }), [IMAGE])).toContain("端口");
    expect(execError({ argv: ["id"], user: "gem" })).toBeNull();
    expect(execError({ argv: [], user: "gem" })).toContain("命令");
    expect(execError({ argv: ["id"], user: "gem --privileged" })).toContain("用户");
    expect(execError({ argv: ["id"], user: "root", env: { "A B": "1" } })).toContain("环境变量");
  });

  it("refuses to adopt a container this system did not create", async () => {
    const docker = new FakeDocker();
    docker.created = true;
    docker.managed = false;
    const driver = new SandboxDriver(config(), log, docker as unknown as DockerCli);
    await expect(driver.ensure(spec(), 1000)).rejects.toThrow("personal-agent.managed=1");
    await expect(driver.exec("aio-user-abc", { argv: ["id"], user: "gem" })).rejects.toThrow("不是本系统管理的沙箱");
  });

  it("passes secret values to docker exec by name only", async () => {
    const docker = new FakeDocker();
    docker.created = true;
    const driver = new SandboxDriver(config(), log, docker as unknown as DockerCli);
    await driver.exec("aio-user-abc", { argv: ["printenv", "KEY"], user: "gem", env: { KEY: "s3cret-value" }, stdin: "in" });
    const exec = docker.calls.at(-1)!;
    expect(exec.args).toEqual(["exec", "-i", "-u", "gem", "-e", "KEY", "aio-user-abc", "printenv", "KEY"]);
    expect(exec.env).toEqual({ KEY: "s3cret-value" });
    expect(exec.stdin).toBe("in");
    await driver.spawn("aio-user-abc", { argv: ["codex", "app-server"], user: "gem", workdir: "/home/gem/workspace", env: { LITELLM_MASTER_KEY: "k-123" } });
    expect(docker.spawned[0]!.args).toEqual(["exec", "-i", "-u", "gem", "-w", "/home/gem/workspace", "-e", "LITELLM_MASTER_KEY", "aio-user-abc", "codex", "app-server"]);
    expect(docker.spawned[0]!.args.join(" ")).not.toContain("k-123");
    expect(docker.spawned[0]!.env).toEqual({ LITELLM_MASTER_KEY: "k-123" });
  });
});
