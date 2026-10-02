/**
 * The wire contract between the control plane and a sandbox node (sandboxd).
 *
 * sandboxd owns Docker on its machine and offers only fixed operations on the
 * sandbox containers it manages: bring one up from a validated spec, inspect,
 * stop, restart, run a command inside it (one-shot or streamed), and proxy HTTP
 * and WebSocket traffic to its web port. It never takes Docker arguments, host
 * paths or mounts from the caller. Every request carries the node token.
 */

/** Shared secret of a node; every request must carry it. */
export const NODE_TOKEN_HEADER = "x-aio-node-token";
/** The protocol range the caller speaks, as `min-max`; a node outside it answers 409. */
export const PROTOCOL_HEADER = "x-aio-protocol";
/** Present on a request that is to be proxied to this sandbox's web port. */
export const SANDBOX_HEADER = "x-aio-sandbox";

/** Everything a node needs to create (or adopt) one account's sandbox container. */
export interface SandboxSpec {
  /** Container name; also how every later call names the sandbox. */
  name: string;
  /** Must be one of the images the node allows. */
  image: string;
  /** Loopback port on the node that publishes the container's web port 8080. */
  hostPort: number;
  /** Named volumes (never host paths) for the workspace, CODEX_HOME and the browser profile. */
  workspaceVolume: string;
  codexVolume: string;
  browserVolume: string;
  containerWorkspaceDir: string;
  containerCodexHome: string;
  containerUser: string;
  /** `NAME=value` entries for the container environment. */
  extraEnv: string[];
  /**
   * A member sandbox runs on its own network with CPU/process caps, and its
   * outbound traffic may reach no private address except the gateway port.
   */
  member?: { networkName: string; gatewayPort: number };
  /** Ports of other accounts' sandboxes this one must not reach (the owner's). */
  peerPorts?: number[];
}

export interface EnsureRequest {
  spec: SandboxSpec;
  /** How long to wait for the container's own health endpoint. */
  readyTimeoutMs: number;
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  healthy: boolean;
  image: string | null;
  startedAt: string | null;
  managedLabel: string | null;
  mounts: Array<{ name: string; source: string; destination: string; type: string }>;
}

/** One command inside a sandbox. `env` values never appear in a process listing. */
export interface ExecRequest {
  argv: string[];
  user: string;
  workdir?: string;
  env?: Record<string, string>;
  /** Text fed to the command's stdin (binary content is sent base64 by the caller). */
  stdin?: string;
  timeoutMs?: number;
  /** Start it and return at once; it keeps running inside the sandbox. */
  detached?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A streamed command over a WebSocket (`/v1/sandboxes/<name>/spawn`). The client
 * opens with a `start` message; stdin goes up as binary frames, stdout and stderr
 * come down as binary frames whose first byte is the channel.
 */
export type SpawnClientMessage =
  | ({ type: "start" } & Omit<ExecRequest, "stdin" | "timeoutMs" | "detached">)
  | { type: "eof" }
  | { type: "kill"; signal?: string };

export type SpawnServerMessage = { type: "exit"; code: number | null; signal: string | null } | { type: "error"; message: string };

export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;

export interface NodeVersion {
  component: "sandbox";
  version: string;
  protocol: number;
}

export interface NodeInfo extends NodeVersion {
  docker: boolean;
  /** Sandboxes this node manages, by container name. */
  sandboxes: Array<{ name: string; running: boolean }>;
  memTotal: number | null;
  memAvailable: number | null;
  cpus: number | null;
}
