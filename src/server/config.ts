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

/**
 * Bridged OpenCode Go model ids, in picker order.
 *
 * `PA_OPENCODE_GO_MODELS` is the multi-model list; the older single-model
 * `PA_OPENCODE_GO_MODEL` still wins when it is set, so an existing deployment
 * that pinned one model keeps exactly that one.
 */
function bridgeModelIds(): string[] {
  const single = envStr("PA_OPENCODE_GO_MODEL", "");
  if (single) return [single];
  return parseList(envStr("PA_OPENCODE_GO_MODELS", "deepseek-v4.1-flash,mimo-v2.6-pro"));
}

export function loadConfig(): {
  protectedMemberPorts?: number[];
  runtimeUserId?: string;
  memberRuntime?: boolean;
  /** The one model a member runtime runs; set by the tenant layer, never by the member. */
  memberModel?: string;
  memberModelPort?: number;
  /** Publish capability handed to this runtime's sandbox (`aio-share`); set by the share store. */
  share?: { endpoint: string; token: string };
  port: number;
  bind: string;
  dataDir: string;
  dbPath: string;
  ownerSecretPath: string;
  logDir: string;
  primaryHost: string;
  legacyPrimaryHost?: string;
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
    networkName?: string;
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
   * Only the sandbox Chromium is ever put to sleep. The container, Codex,
   * terminal, code-server and Jupyter are never stopped by this feature - the
   * control plane only releases the browser's own process memory and rebuilds
   * the tabs from a snapshot when the browser is next needed.
   */
  browser: {
    /** Master switch; when off the browser lifecycle is a no-op (always awake). */
    enabled: boolean;
    /**
     * Whether a browser nobody holds is released at all. Off by default: each
     * account keeps one resident browser so its logins stay valid.
     */
    releaseWhenIdle: boolean;
    /**
     * The same for member runtimes, on by default: their browsers are used now and
     * then, and a released one comes back from its snapshot (logins included) on
     * the next use.
     */
    memberReleaseWhenIdle: boolean;
    /** The browser's time zone; it should match where its network egress is. */
    timezone: string;
    /**
     * A newer Chromium than the image ships (sites reject its old build): Debian
     * packages unpacked (never installed) into `toolDir` when the sandbox starts,
     * only on `arch` (`uname -m`) and only if every download matches its `sha256`.
     * Null keeps the image's own browser.
     */
    build: { packages: Array<{ url: string; sha256: string }>; arch: string } | null;
    /** How long the browser may sit with no task/viewer/activity hold before sleeping. */
    idleMs: number;
    /** Viewer heartbeat validity; a viewer that stops heartbeating loses its hold. */
    viewerTtlMs: number;
    /** Container directory (persistent CODEX_HOME volume) holding the managed helper + snapshot. */
    toolDir: string;
    /** Absolute container path of the browser snapshot (0600, never logged). */
    snapshotPath: string;
    /** Bound for one helper invocation (status/snapshot/stop/start). */
    helperTimeoutMs: number;
    /** Bound for waiting until CDP answers after a start. */
    wakeTimeoutMs: number;
    /** How long a stop may take before it is reported as a failure. */
    stopTimeoutMs: number;
    /**
     * What to do when a page holds typed-but-unsubmitted input:
     * `block` refuses the sleep (conservative), `warn` sleeps and reports it.
     */
    dirtyInputPolicy: "block" | "warn";
  };
  /**
   * Optional OpenCode Go / LiteLLM bridge models. `enabled` is auto by default:
   * the models are offered only when a key can actually be read.
   *
   * `PA_OPENCODE_GO_MODEL` (single id) is still honoured and wins over
   * `PA_OPENCODE_GO_MODELS`, so an existing single-model deployment keeps
   * exactly the one it configured.
   */
  bridge: {
    enabled: string;
    baseUrl: string;
    /** Every bridged model id, in the order the picker should show them. */
    models: string[];
    providerId: string;
    secretsFile: string;
    envKey: string;
  };
  /** Optional Claude Code harness: an alternative executor for owner task turns. */
  claudeCode: {
    enabled: string;
    /** Pinned CLI, installed into the persistent CODEX_HOME volume like Codex. */
    version: string;
    prefix: string;
    bin: string;
    /** CLAUDE_CONFIG_DIR inside the sandbox: sessions (for --resume) persist here. */
    configDir: string;
    /** Private host file holding CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. */
    secretsFile: string;
    /** Tool-less model for the main-session dispatcher and titles while Claude Code is selected. */
    auxModel: string;
    /** Upstream the member gateway forwards Claude requests to with the owner's credential. */
    apiBaseUrl: string;
    /**
     * Member runtimes only: the gateway address the sandbox CLI talks to. The
     * owner's credential never enters a member sandbox; `secretsFile` then holds
     * that member's own gateway token.
     */
    gatewayUrl?: string;
  };
  /**
   * Jev (TypeSafe System One) structured decisions: the dispatcher's second opinion
   * and the executors' decision tool. The key stays in the control plane; sandboxes
   * reach Jev only through the gateway. Without a key both features are absent.
   */
  jev: {
    endpoint: string;
    model: string;
    /** Private host file holding TYPESAFE_API_KEY (the environment wins). */
    secretsFile: string;
    timeoutMs: number;
    /** How long a dispatch waits for Jev before deciding without it. */
    dispatchTimeoutMs: number;
  };
  /** The decision tool reachable from this runtime's sandbox; set by the decision gateway. */
  decision?: { url: string };
  externalBaseUrl: string;
} {
  const port = envInt("PA_PORT", 4891);
  const bind = envStr("PA_BIND", "127.0.0.1");
  const dataDir = envStr("PA_DATA_DIR", path.join(PROJECT_ROOT, "var"));
  const primaryHost = envStr("PA_PRIMARY_HOST", "agent.clawpage.ai").toLowerCase();
  const workspaceHost = envStr("PA_WORKSPACE_HOST", "agent-workspace.clawpage.ai").toLowerCase();
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
  const claudeCodeVersion = envStr("PA_CLAUDE_CODE_VERSION", "2.1.284");
  const claudeCodePrefix = `/home/gem/.codex/tools/claude-code-${claudeCodeVersion}`;

  return {
    port,
    bind,
    memberModelPort:envInt("PA_MEMBER_MODEL_PORT",4902),
    dataDir,
    dbPath: envStr("PA_DB_PATH", path.join(dataDir, "personal-agent.sqlite")),
    ownerSecretPath: envStr("PA_OWNER_SECRET_PATH", path.join(dataDir, "owner-secret.txt")),
    logDir: path.join(dataDir, "logs"),
    primaryHost,
    legacyPrimaryHost: envStr("PA_LEGACY_PRIMARY_HOST", "").toLowerCase() || undefined,
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
    browser: {
      enabled: envStr("PA_BROWSER_LIFECYCLE", "1") === "1",
      // Releasing an idle browser meant stopping Chromium and carrying logins over
      // in a snapshot; failed restores dropped them. Keep it resident unless asked.
      releaseWhenIdle: envStr("PA_BROWSER_RELEASE_IDLE", "0") === "1",
      memberReleaseWhenIdle: envStr("PA_MEMBER_BROWSER_RELEASE_IDLE", "1") === "1",
      timezone: envStr("PA_BROWSER_TIMEZONE", "America/Los_Angeles"),
      // Chromium 154 for Ubuntu 22.04 arm64 from the xtradeb PPA (a regular build: Cloudflare stalls
      // Chrome for Testing, and Google ships no arm64 Chrome), plus the two Ubuntu libraries it needs
      // that the image lacks. Override with comma-separated `url#sha256` entries.
      build: envStr("PA_BROWSER_BUILD", "on") === "off" ? null : {
        packages: envStr("PA_BROWSER_BUILD_PACKAGES", [
          "https://launchpad.net/~xtradeb/+archive/ubuntu/apps/+files/chromium_154.0.8037.57-1xtradeb1.2204.1_arm64.deb#f1baa0efd51730e88e47ec10f020a03d0af071e5c0410a8ea66847e6390b2e33",
          "https://launchpad.net/~xtradeb/+archive/ubuntu/apps/+files/chromium-common_154.0.8037.57-1xtradeb1.2204.1_arm64.deb#7f9084c52d7b511540a7d21c1b208a5cfe4ae08d74bfd0a40ecaad60cfc157fe",
          "https://launchpad.net/ubuntu/+archive/primary/+files/libopenh264-6_2.2.0+dfsg-2_arm64.deb#7c954033634a7c8980e1d6179afcd4a0edd1924a020caa46628386e8c77d75aa",
          "https://launchpad.net/ubuntu/+archive/primary/+files/libxnvctrl0_510.47.03-0ubuntu1.22.04.1_arm64.deb#2dd5ef51664f355fd28d6264ca63102fe507c65bcd74c27c8b07f432c98bf618",
        ].join(",")).split(",").map((entry) => {
          const [url = "", sha256 = ""] = entry.trim().split("#");
          return { url, sha256 };
        }),
        arch: envStr("PA_BROWSER_BUILD_ARCH", "aarch64"),
      },
      // A five minute default keeps a browser that nobody is looking at from
      // holding hundreds of MB of renderer memory; the floor stops a
      // misconfiguration from thrashing the browser on every navigation.
      idleMs: Math.max(30_000, envInt("PA_BROWSER_IDLE_SECONDS", 300) * 1000),
      viewerTtlMs: Math.max(10_000, envInt("PA_BROWSER_VIEWER_TTL_SECONDS", 60) * 1000),
      toolDir: envStr("PA_BROWSER_TOOL_DIR", "/opt/aio-browser"),
      snapshotPath: envStr(
        "PA_BROWSER_SNAPSHOT_PATH",
        path.posix.join(sandboxCodexPrefix, "..", "aio-browser", "browser-snapshot.json"),
      ),
      helperTimeoutMs: Math.max(5_000, envInt("PA_BROWSER_HELPER_TIMEOUT_SECONDS", 45) * 1000),
      wakeTimeoutMs: Math.max(5_000, envInt("PA_BROWSER_WAKE_TIMEOUT_SECONDS", 90) * 1000),
      stopTimeoutMs: Math.max(5_000, envInt("PA_BROWSER_STOP_TIMEOUT_SECONDS", 30) * 1000),
      // Default `block`: a browser that holds typed-but-unsubmitted input is
      // never released, so no user-visible work can be lost by accident.
      dirtyInputPolicy: envEnum("PA_BROWSER_DIRTY_INPUT_POLICY", ["block", "warn"] as const, "block"),
    },
    // The bridge is a local convenience, never a hard dependency: with no key
    // the model simply does not appear and the ChatGPT path is untouched.
    bridge: {
      enabled: envStr("PA_OPENCODE_GO_ENABLED", "auto"),
      baseUrl: envStr("PA_OPENCODE_GO_BASE_URL", "http://host.docker.internal:4017/v1"),
      models: bridgeModelIds(),
      providerId: envStr("PA_OPENCODE_GO_PROVIDER_ID", "opencode_go"),
      secretsFile: envStr("PA_OPENCODE_GO_SECRETS_FILE", path.join(os.homedir(), ".config", "codex-opencode-go", "secrets.env")),
      envKey: envStr("PA_OPENCODE_GO_ENV_KEY", "LITELLM_MASTER_KEY"),
    },
    // Same contract as the bridge: without a credential the harness simply does
    // not appear, and Codex stays the only executor.
    claudeCode: {
      enabled: envStr("PA_CLAUDE_CODE_ENABLED", "auto"),
      version: claudeCodeVersion,
      prefix: claudeCodePrefix,
      bin: path.posix.join(claudeCodePrefix, "node_modules", ".bin", "claude"),
      configDir: envStr("PA_CLAUDE_CODE_CONFIG_DIR", "/home/gem/.codex/claude-code-home"),
      secretsFile: envStr("PA_CLAUDE_CODE_SECRETS_FILE", path.join(os.homedir(), ".config", "aio-agent", "claude-code.env")),
      auxModel: envStr("PA_CLAUDE_CODE_AUX_MODEL", "claude-sonnet-5-5"),
      apiBaseUrl: envStr("PA_ANTHROPIC_API_BASE_URL", "https://api.anthropic.com"),
    },
    jev: {
      endpoint: envStr("PA_JEV_ENDPOINT", "https://api.typesafe.ai/v1/systemone"),
      model: envStr("PA_JEV_MODEL", "jev-latest"),
      secretsFile: envStr("PA_JEV_SECRETS_FILE", path.join(os.homedir(), ".config", "aio-agent", "jev.env")),
      timeoutMs: Math.max(5_000, envInt("PA_JEV_TIMEOUT_SECONDS", 30) * 1000),
      dispatchTimeoutMs: Math.max(2_000, envInt("PA_JEV_DISPATCH_TIMEOUT_SECONDS", 15) * 1000),
    },
    externalBaseUrl: envStr("PA_EXTERNAL_BASE_URL", ""),
  };
}

export function ensureDataDirs(cfg: Config): void {
  for (const dir of [cfg.dataDir, cfg.logDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
