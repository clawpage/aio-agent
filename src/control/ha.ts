import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { McpGateway } from "./mcpGateway.js";
import { CAMERA_POLICY, CAMERA_TOOLS, CAMERA_TOOL_NAMES, type HaCameras } from "./camera.js";
import { HA_HISTORY_TOOLS, HA_HISTORY_TOOL_NAMES, type HaHistory } from "./haHistory.js";

/**
 * Home Assistant: its built-in MCP Server integration (the Assist API: the
 * entities exposed to Assist, their state and the intents that turn them on,
 * off or set them), offered to the accounts the owner lists through the
 * member gateway (McpGateway, at `/ha/<token>/mcp`), with the camera tools
 * (HaCameras) and the history tool (HaHistory) added to the same server. The long-lived access token stays in
 * the control plane.
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
  "The home Home Assistant is connected (aio_ha): when the user wants lights and switches turned on or off, the air conditioner temperature adjusted, the TV turned on, or the robot vacuum started, or asks about temperature and humidity around the house or the state of devices, query or operate them directly with its tools; do not make the user do it in the app themselves. Device names may be in English or pinyin (e.g. Living Room, Family room, Main Floor, Upstairs); map Chinese room names the user says to the closest device; when unsure which one is meant, first use the state tools to see which devices exist, then choose. Operate only the devices the user asked for this time, and read the state once after operating to confirm the result before answering; for safety-related things such as camera detection switches or vehicle status, do exactly what the user said and do not change anything else along the way. " +
  "For how things changed over time (today's temperature trend, the high and low, when the heating or cooling ran, when a light or door was on), use ha_history instead of guessing from the current state, and give the values with their units. " +
  CAMERA_POLICY;

export class HaGateway extends McpGateway {
  #cameras: HaCameras | null;
  #history: HaHistory | null;

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; cameras?: HaCameras | null; history?: HaHistory | null }) {
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
    this.#cameras = opts.cameras ?? null;
    this.#history = opts.history ?? null;
  }

  /** HA's tools plus the camera and history tools; those calls never reach HA's MCP server. */
  protected override async local(message: unknown, username: string): Promise<unknown> {
    const cameras = this.#cameras;
    const history = this.#history;
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if ((!cameras && !history) || id === undefined || id === null) return undefined;
    if (method === "tools/list") {
      const upstream = (await this.rpcUpstream(message, username)) as { result?: { tools?: unknown[] } };
      if (!Array.isArray(upstream?.result?.tools)) return upstream;
      const extra = [...(cameras ? CAMERA_TOOLS : []), ...(history ? HA_HISTORY_TOOLS : [])];
      return { ...upstream, result: { ...upstream.result, tools: [...upstream.result.tools, ...extra] } };
    }
    if (method === "tools/call" && typeof params?.name === "string") {
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      if (cameras && CAMERA_TOOL_NAMES.has(params.name)) return { jsonrpc: "2.0", id, result: await cameras.tool(params.name, args) };
      if (history && HA_HISTORY_TOOL_NAMES.has(params.name)) return { jsonrpc: "2.0", id, result: await history.tool(params.name, args) };
    }
    return undefined;
  }
}
