import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export type Config = ReturnType<typeof loadConfig>;

function envStr(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Parse an `a,b,c` list, trimming and dropping empties. */
export function parseList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): {
  port: number;
  bind: string;
  dataDir: string;
  dbPath: string;
  ownerSecretPath: string;
  logDir: string;
  primaryHost: string;
  workspaceHost: string;
  allowedHosts: string[];
  primaryOrigins: string[];
  workspaceOrigins: string[];
  loopbackHosts: string[];
  allowInsecureLoopbackCookies: boolean;
  trustCfConnectingIp: boolean;
  proxyConnectTimeoutMs: number;
  sessionTtlMs: number;
  sessionIdleRenewMs: number;
  ticketTtlMs: number;
  loginMaxFailures: number;
  loginWindowMs: number;
  loginLockoutMs: number;
  ownerPassword: string;
  ownerPasswordReset: boolean;
  sandbox: {
    image: string;
    containerName: string;
    hostPort: number;
    workspaceVolume: string;
    codexVolume: string;
    browserVolume: string;
    containerWorkspaceDir: string;
    containerCodexHome: string;
    containerUser: string;
    extraEnv: string[];
    readyTimeoutMs: number;
    autostart: boolean;
    fileOpTimeoutMs: number;
  };
  hostCodex: {
    bin: string;
    home: string;
    tokenRefreshSkewMs: number;
    requestTimeoutMs: number;
  };
  externalBaseUrl: string;
} {
  const port = envInt("PA_PORT", 4891);
  const bind = envStr("PA_BIND", "127.0.0.1");
  const dataDir = envStr("PA_DATA_DIR", path.join(PROJECT_ROOT, "var"));
  const primaryHost = envStr("PA_PRIMARY_HOST", "agent.zymx.tech").toLowerCase();
  const workspaceHost = envStr("PA_WORKSPACE_HOST", "agent-workspace.zymx.tech").toLowerCase();
  const loopbackHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "localhost", "127.0.0.1"];
  const allowedHosts = [
    ...parseList(envStr("PA_ALLOWED_HOSTS", "")).map((h) => h.toLowerCase()),
    primaryHost,
    workspaceHost,
    // A tunnel may forward the bare host without a port only for the loopback test host.
    ...loopbackHosts,
  ];

  const primaryOrigins = [
    ...parseList(envStr("PA_PRIMARY_ORIGINS", "")),
    `https://${primaryHost}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  // The companion origin is deliberately NOT the control-plane loopback host:
  // local development uses 127.0.0.1 for the companion and localhost for the
  // control plane, so cross-origin rules behave like production (where the two
  // sites are different hostnames).
  const workspaceOrigins = [...parseList(envStr("PA_WORKSPACE_ORIGINS", "")), `https://${workspaceHost}`, `http://127.0.0.1:${port}`];

  return {
    port,
    bind,
    dataDir,
    dbPath: envStr("PA_DB_PATH", path.join(dataDir, "personal-agent.sqlite")),
    ownerSecretPath: envStr("PA_OWNER_SECRET_PATH", path.join(dataDir, "owner-secret.txt")),
    logDir: path.join(dataDir, "logs"),
    primaryHost,
    workspaceHost,
    allowedHosts,
    primaryOrigins,
    workspaceOrigins,
    loopbackHosts,
    allowInsecureLoopbackCookies: envStr("PA_ALLOW_INSECURE_LOOPBACK_COOKIES", "1") === "1",
    // Only enable behind the dedicated Cloudflare tunnel; otherwise XFF/CF headers are spoofable.
    trustCfConnectingIp: envStr("PA_TRUST_CF_CONNECTING_IP", "0") === "1",
    proxyConnectTimeoutMs: envInt("PA_PROXY_CONNECT_TIMEOUT_SECONDS", 30) * 1000,
    sessionTtlMs: envInt("PA_SESSION_TTL_HOURS", 720) * 3600_000,
    sessionIdleRenewMs: envInt("PA_SESSION_RENEW_MINUTES", 60) * 60_000,
    ticketTtlMs: envInt("PA_TICKET_TTL_SECONDS", 60) * 1000,
    loginMaxFailures: envInt("PA_LOGIN_MAX_FAILURES", 5),
    loginWindowMs: envInt("PA_LOGIN_WINDOW_MINUTES", 15) * 60_000,
    loginLockoutMs: envInt("PA_LOGIN_LOCKOUT_MINUTES", 15) * 60_000,
    ownerPassword: envStr("PA_OWNER_PASSWORD", ""),
    // Opt-in operator action: rotate the owner password and rewrite the local secret file.
    ownerPasswordReset: envStr("PA_OWNER_PASSWORD_RESET", "0") === "1",
    sandbox: {
      image: envStr("PA_SANDBOX_IMAGE", "ghcr.io/agent-infra/sandbox:1.11.0"),
      containerName: envStr("PA_SANDBOX_CONTAINER", "personal-agent-sandbox"),
      hostPort: envInt("PA_SANDBOX_PORT", 18081),
      workspaceVolume: envStr("PA_SANDBOX_WORKSPACE_VOLUME", "personal-agent-workspace"),
      codexVolume: envStr("PA_SANDBOX_CODEX_VOLUME", "personal-agent-codex"),
      browserVolume: envStr("PA_SANDBOX_BROWSER_VOLUME", "personal-agent-browser"),
      containerWorkspaceDir: "/home/gem/workspace",
      containerCodexHome: "/home/gem/.codex",
      containerUser: envStr("PA_SANDBOX_USER", "gem"),
      // Chrome requires --no-sandbox inside Docker Desktop's Linux VM (no user-namespace support).
      extraEnv: parseList(envStr("PA_SANDBOX_EXTRA_ENV", "BROWSER_NO_SANDBOX=--no-sandbox")),
      readyTimeoutMs: envInt("PA_SANDBOX_READY_TIMEOUT_SECONDS", 180) * 1000,
      autostart: envStr("PA_SANDBOX_AUTOSTART", "1") === "1",
      // Bound for shell-backed file operations (mkdir/delete) before reporting failure.
      fileOpTimeoutMs: envInt("PA_FILE_OP_TIMEOUT_SECONDS", 30) * 1000,
    },
    hostCodex: {
      bin: envStr("PA_HOST_CODEX_BIN", "codex"),
      home: envStr("PA_HOST_CODEX_HOME", path.join(os.homedir(), ".codex")),
      tokenRefreshSkewMs: envInt("PA_HOST_TOKEN_SKEW_HOURS", 6) * 3600_000,
      requestTimeoutMs: envInt("PA_HOST_CODEX_TIMEOUT_SECONDS", 10) * 1000,
    },
    externalBaseUrl: envStr("PA_EXTERNAL_BASE_URL", ""),
  };
}

export function ensureDataDirs(cfg: Config): void {
  for (const dir of [cfg.dataDir, cfg.logDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
