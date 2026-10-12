import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { McpGateway } from "./mcpGateway.js";

/**
 * Home Assistant: its built-in MCP Server integration (the Assist API: the
 * entities exposed to Assist, their state and the intents that turn them on,
 * off or set them), offered to the accounts the owner lists through the
 * member gateway (McpGateway, at `/ha/<token>/mcp`). The long-lived access
 * token stays in the control plane.
 */
export const HA_MCP_KEY = "HA_MCP_TOKEN";
const TIMEOUT_MS = 30_000;

/** Thread-level MCP wiring for a Codex executor. */
export function haThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.ha ? { aio_ha: { url: cfg.ha.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 10 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function haMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.ha ? { aio_ha: { type: "http", url: cfg.ha.url } } : {};
}

export const HA_POLICY =
  "The home Home Assistant is connected (aio_ha): when the user wants lights and switches turned on or off, the air conditioner temperature adjusted, the TV turned on, or the robot vacuum started, or asks about temperature and humidity around the house or the state of devices, query or operate them directly with its tools; do not make the user do it in the app themselves. Device names may be in English or pinyin (e.g. Living Room, Family room, Main Floor, Upstairs); map Chinese room names the user says to the closest device; when unsure which one is meant, first use the state tools to see which devices exist, then choose. Operate only the devices the user asked for this time, and read the state once after operating to confirm the result before answering; for safety-related things such as camera detection switches or vehicle status, do exactly what the user said and do not change anything else along the way.";

export class HaGateway extends McpGateway {
  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null }) {
    super({
      ...opts,
      name: "ha",
      upstreamUrl: opts.cfg.haMcp.upstreamUrl,
      secretKey: HA_MCP_KEY,
      secretsFile: opts.cfg.haMcp.secretsFile,
      // Only the accounts the owner listed by username (the owner too only if listed).
      granted: (username) => opts.cfg.haMcp.accounts.includes(username),
      assign: (runtime, url) => { runtime.ha = { url }; },
      timeoutMs: TIMEOUT_MS,
    });
  }
}
