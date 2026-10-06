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
  "已接入家里的 Home Assistant（aio_ha）：用户要开关灯和开关、调空调温度、开电视、让扫地机工作，或问家里各处温湿度、设备状态时，用它的工具直接查或操作，不要让用户自己去 App 里弄。设备名可能是英文或拼音（例如 Living Room、Family room、Main Floor、Upstairs），用户说的中文房间名按最接近的设备理解；拿不准指哪个时先用状态工具看有哪些设备再选。只操作用户这次要求的设备，操作后读一次状态确认结果再回答；摄像头侦测开关、车况这类跟安全有关的，按用户原话办，不顺手改别的。";

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
