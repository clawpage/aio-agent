import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { McpGateway } from "./mcpGateway.js";

/**
 * The knowledge base: an MCP server the owner runs on the host, offered to the
 * owner's and the listed members' executors through the member gateway
 * (McpGateway, at `/kb/<token>/mcp`). Which of them may also add notes
 * (`kb_note`) is the upstream's decision, by the username this gateway sends.
 */

export const KB_MCP_KEY = "KB_MCP_TOKEN";
// A scanned original is read by text recognition on the knowledge base's host: a dozen pages take ~15 s.
const TIMEOUT_MS = 90_000;

/** Thread-level MCP wiring for a Codex executor. */
export function kbThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.kb ? { aio_kb: { url: cfg.kb.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 10 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function kbMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.kb ? { aio_kb: { type: "http", url: cfg.kb.url } } : {};
}

export const KB_POLICY =
  "已接入知识库 aio_kb（只读；获准写入的账号另有 kb_note）：问题涉及用户本人或家人的情况、过往记录与安排，或用户自己的项目时，先搜索并读取已有记录，再结合内容开展任务，不先向用户索取可查的资料。昵称、英文名与正式姓名可能不同，首次无结果时用相关记录中的别名再查。页面是来源索引时，未写字段值不代表没有记录：需要生日、年龄、地址、原话或数字，用 kb_source 读取页面列出的相关原文；年龄按已核实生日和本次目标日期计算，不照搬旧年龄。原件里的号码、证件、住址、诊断和剂量只引用任务需要的部分。当前用户纠正优先于历史资料，时效性信息重新核实。经过相关搜索、页面和必要原文核对仍缺失，才说明具体缺口；不编造，也不把检索当成最终交付而忘记继续原任务。工具里有 kb_note 时，用户要你记住、记下、更正某件事或计入家庭知识库，就用它新增一条笔记（写清事实、相关的人、时间和出处），不要只在对话里答应记住；聊天里出现新的家庭偏好（饮食、作息、喜好与忌讳、常用的店与医生等）或 Roy 的事项（健康、喂养、睡眠、成长、照护与安排），即使用户没说要记也主动记下，记之前先搜索确认没有同样的记录，同一件事一次对话只记一条，记完在回复里简短说明记了什么。不记闲聊、临时安排、你自己的建议和密码证件号等凭据。";

export class KbGateway extends McpGateway {
  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null }) {
    super({
      ...opts,
      name: "kb",
      upstreamUrl: opts.cfg.kbMcp.upstreamUrl,
      secretKey: KB_MCP_KEY,
      secretsFile: opts.cfg.kbMcp.secretsFile,
      // The owner, and the members the owner listed.
      granted: (username, runtime) => !runtime.memberRuntime || opts.cfg.kbMcp.members.includes(username),
      assign: (runtime, url) => { runtime.kb = { url }; },
      timeoutMs: TIMEOUT_MS,
    });
  }
}
