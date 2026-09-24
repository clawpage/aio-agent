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

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = process.env[name];
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
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
    /** Versioned Codex CLI installed into the persistent CODEX_HOME volume. */
    codexVersion: string;
    codexPrefix: string;
    codexBin: string;
  };
  documents: {
    /** Master switch for sandbox document conversion (preview rasterisation). */
    enabled: boolean;
    /** Directory inside the sandbox holding the managed tool scripts + venv. */
    toolDir: string;
    /** Page cap for one preview render; later pages are reported as truncated. */
    maxPages: number;
    /** Hard bound for one conversion step, enforced inside the container. */
    timeoutMs: number;
    /** In-process render cache budget, in bytes. */
    cacheMaxBytes: number;
    /** Renders allowed to run at once; further requests wait for a slot. */
    maxConcurrent: number;
    /** How long a readiness probe result is reused before re-checking. */
    readinessTtlMs: number;
    /** Longest text file the console will show inline, in bytes. */
    textMaxBytes: number;
  };
  agent: {
    /** Model a turn uses when neither the client nor the conversation picked one. */
    defaultModel: string;
    /** Generate a conversation title from the first turn with an isolated Luna run. */
    autoTitle: boolean;
    /** Model used only for the auxiliary title run; never the main conversation model. */
    titleModel: string;
    /** Reasoning effort for the auxiliary title run (Luna supports low..max, not minimal). */
    titleEffort: string;
    /** Upper bound on a generated title, in Unicode code points. */
    titleMaxChars: number;
    /** Hard timeout for one auxiliary title run. */
    titleTimeoutMs: number;
    /** Upper bound on concurrent main Codex turns across conversations. */
    maxConcurrentTurns: number;
    /** Reasoning summary mode requested for main turns (`none` disables summaries). */
    reasoningSummary: "none" | "auto" | "concise" | "detailed";
  };
  hostCodex: {
    bin: string;
    home: string;
    tokenRefreshSkewMs: number;
    requestTimeoutMs: number;
  };
  /**
   * Optional OpenCode Go / LiteLLM bridge model. `enabled` is auto by default:
   * the model is offered only when a key can actually be read.
   */
  bridge: {
    enabled: string;
    baseUrl: string;
    model: string;
    providerId: string;
    secretsFile: string;
    envKey: string;
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

  // Pinned Codex CLI in the persistent CODEX_HOME volume. One version drives
  // both the install prefix and the binary path so they can never drift apart.
  const sandboxCodexVersion = envStr("PA_SANDBOX_CODEX_VERSION", "0.156.1");
  const sandboxCodexPrefix = envStr("PA_SANDBOX_CODEX_PREFIX", `/home/gem/.codex/tools/codex-${sandboxCodexVersion}`);
  const sandboxCodexBin = envStr(
    "PA_SANDBOX_CODEX_BIN",
    path.posix.join(sandboxCodexPrefix, "node_modules", ".bin", "codex"),
  );

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
      // The pinned AIO image ships an older Codex CLI and must not be upgraded;
      // the agent binary lives in the persistent personal-agent-codex volume
      // instead, so container rebuilds keep it and the version is explicit.
      codexVersion: sandboxCodexVersion,
      codexPrefix: sandboxCodexPrefix,
      codexBin: sandboxCodexBin,
    },
    documents: {
      // Conversion runs entirely inside the sandbox with fixed argv; the control
      // plane never parses a document itself.
      enabled: envStr("PA_DOCUMENTS_ENABLED", "1") === "1",
      // Lives in the persistent CODEX_HOME volume so a container rebuild keeps
      // the managed scripts (the fixed image is never modified).
      toolDir: envStr("PA_DOC_TOOLS_DIR", path.posix.join(sandboxCodexPrefix, "..", "aio-doc")),
      maxPages: Math.min(50, Math.max(1, envInt("PA_DOC_PREVIEW_MAX_PAGES", 12))),
      timeoutMs: Math.max(5_000, envInt("PA_DOC_TIMEOUT_SECONDS", 120) * 1000),
      cacheMaxBytes: Math.max(0, envInt("PA_DOC_CACHE_MAX_MB", 64) * 1024 * 1024),
      maxConcurrent: Math.min(4, Math.max(1, envInt("PA_DOC_MAX_CONCURRENT", 2))),
      readinessTtlMs: Math.max(1_000, envInt("PA_DOC_READINESS_TTL_SECONDS", 60) * 1000),
      textMaxBytes: Math.max(1024, envInt("PA_DOC_TEXT_MAX_KB", 256) * 1024),
    },
    agent: {
      defaultModel: envStr("PA_DEFAULT_MODEL", "gpt-6-sol"),
      // Only the auxiliary title run uses a different model; the main agent stays
      // on PA_DEFAULT_MODEL. Disabling this keeps the sandbox untouched by titles.
      autoTitle: envStr("PA_AUTO_TITLE", "1") === "1",
      titleModel: envStr("PA_TITLE_MODEL", "gpt-6-luna"),
      titleEffort: envStr("PA_TITLE_EFFORT", "low"),
      titleMaxChars: envInt("PA_TITLE_MAX_CHARS", 24),
      titleTimeoutMs: envInt("PA_TITLE_TIMEOUT_SECONDS", 30) * 1000,
      // At most three main turns run at once across different conversations; a
      // fourth conversation waits in FIFO order for a slot to free. One
      // conversation still runs at most one turn at a time. The env value is
      // clamped to 1..3 so operators cannot exceed the reviewed concurrency cap.
      maxConcurrentTurns: Math.min(3, Math.max(1, envInt("PA_MAX_CONCURRENT_TURNS", 3))),
      // Ask Codex for a model-generated reasoning *summary* rather than raw
      // chain-of-thought; `concise` keeps the UI rows short and non-empty only
      // when there is real summary text.
      reasoningSummary: envEnum("PA_REASONING_SUMMARY", ["none", "auto", "concise", "detailed"], "concise"),
    },
    hostCodex: {
      bin: envStr("PA_HOST_CODEX_BIN", "codex"),
      home: envStr("PA_HOST_CODEX_HOME", path.join(os.homedir(), ".codex")),
      tokenRefreshSkewMs: envInt("PA_HOST_TOKEN_SKEW_HOURS", 6) * 3600_000,
      requestTimeoutMs: envInt("PA_HOST_CODEX_TIMEOUT_SECONDS", 10) * 1000,
    },
    // The bridge is a local convenience, never a hard dependency: with no key
    // the model simply does not appear and the ChatGPT path is untouched.
    bridge: {
      enabled: envStr("PA_OPENCODE_GO_ENABLED", "auto"),
      baseUrl: envStr("PA_OPENCODE_GO_BASE_URL", "http://host.docker.internal:4017/v1"),
      model: envStr("PA_OPENCODE_GO_MODEL", "deepseek-v4.1-flash"),
      providerId: envStr("PA_OPENCODE_GO_PROVIDER_ID", "opencode_go"),
      secretsFile: envStr("PA_OPENCODE_GO_SECRETS_FILE", path.join(os.homedir(), ".config", "codex-opencode-go", "secrets.env")),
      envKey: envStr("PA_OPENCODE_GO_ENV_KEY", "LITELLM_MASTER_KEY"),
    },
    externalBaseUrl: envStr("PA_EXTERNAL_BASE_URL", ""),
  };
}

export function ensureDataDirs(cfg: Config): void {
  for (const dir of [cfg.dataDir, cfg.logDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
