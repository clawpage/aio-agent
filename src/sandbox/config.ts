import path from "node:path";

export interface SandboxdConfig {
  port: number;
  bind: string;
  /** Private file holding `AIO_SANDBOX_NODE_TOKEN` (the environment variable wins). */
  tokenFile: string;
  /** Images a sandbox may run; anything else is refused. */
  images: string[];
  /**
   * How this process reaches the ports sandboxes publish on the node's loopback:
   * `127.0.0.1` on the host itself, `host.docker.internal` from a container on
   * Docker Desktop.
   */
  containerHost: string;
  /** Give new sandboxes `host.docker.internal` (Linux Docker lacks it; Docker Desktop has it). */
  addHostGateway: boolean;
  logDir: string | null;
  /**
   * Forward sandboxes' gateway traffic (models, share, decisions, knowledge base)
   * to a control plane on another machine. Off when the control plane runs on
   * this machine and publishes the gateway port itself.
   */
  gateway: { upstream: string; bind: string; port: number } | null;
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadSandboxdConfig(): SandboxdConfig {
  const upstream = env("PA_SANDBOXD_GATEWAY_UPSTREAM");
  const dataDir = env("PA_SANDBOXD_DATA_DIR");
  return {
    port: Number.parseInt(env("PA_SANDBOXD_PORT", "4894"), 10),
    bind: env("PA_SANDBOXD_BIND", "127.0.0.1"),
    tokenFile: env("PA_SANDBOXD_TOKEN_FILE", dataDir ? path.join(dataDir, "node-token.env") : ""),
    images: env("PA_SANDBOXD_IMAGES", env("PA_SANDBOX_IMAGE", "ghcr.io/agent-infra/sandbox:1.11.0")).split(",").map((s) => s.trim()).filter(Boolean),
    containerHost: env("PA_SANDBOXD_CONTAINER_HOST", "127.0.0.1"),
    addHostGateway: env("PA_SANDBOXD_ADD_HOST_GATEWAY", "0") === "1",
    logDir: dataDir ? path.join(dataDir, "logs") : null,
    gateway: upstream
      ? { upstream, bind: env("PA_SANDBOXD_GATEWAY_BIND", "127.0.0.1"), port: Number.parseInt(env("PA_SANDBOXD_GATEWAY_PORT", "4902"), 10) }
      : null,
  };
}

export const NODE_TOKEN_KEY = "AIO_SANDBOX_NODE_TOKEN";
