import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";
import type { TaskService } from "./tasks/service.js";
import { AGREEMENT_KINDS, AGREEMENT_TEXT_MAX, forgetAgreement, saveAgreement, searchAgreements } from "./tasks/history.js";

/**
 * The history tool: the account's past tasks and standing agreements, offered to its
 * executors as one MCP server on the member gateway, so an executor looks up what it
 * needs instead of every turn carrying it. Each runtime gets its own capability URL
 * (`/history/<token>/mcp`), which reaches only that account's tasks and agreements.
 */

export const HISTORY_POLICY =
  "已接入一站的历史记录 aio_history：过往任务和长期约定都按需查，不靠事先塞进上下文。" +
  "用户提到以前、上次、之前那个、我们说好的、还记得吗，或本任务明显接着早先的事（同一个人、物品、项目、网站或 App）时，先用 history_search 搜几个关键词（按相关度排序，可带上人名、物品、地点、App 名），再用 history_get 读最相关的一两个；" +
  "要知道当时具体怎么做的、卡在哪一步（配置步骤、登录方式、选过的商品），加 process=true 看执行过程。结果里的 session 说明它属于哪个执行会话的第几个任务，history_get 会列出同一会话的前后任务，需要时顺着读。背景资料里相关任务的结果可能截断了，要完整内容也用 history_get。" +
  "用户明确交代以后要遵守的规则或偏好（“以后…”“每次都…”“别再…”“记住…”）、双方说定的约定、关于用户的重要事实，用 memory_save 记成一句话；改了主意用 replaces 改写原条，不再适用就 memory_forget。一次性的任务细节、临时信息和推测不要记，也不替用户做他没表达过的长期决定。" +
  "开头给出的「长期约定」只列了一部分，遇到可能相关的话题用 memory_search 再查。查不到就说没找到，不编造过往；历史里的价格、营业时间这类会变的信息，用之前重新核实。";

const TOOLS = [
  {
    name: "history_search",
    description: "搜索用户在一站做过的任务（包括其他执行会话、语音配件和定时任务的）：按相关度返回 id、日期、标题、请求摘要、结果里命中的片段、状态，以及它在执行会话里的位置。不给 query 时按时间列出最近的任务。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "几个关键词，空格分开，命中任意一个即可，越多越准，例如“小红书 双开 安全文件夹”“Roy 疫苗 预约”" },
        status: { type: "string", description: "只看某种状态：open（还没结束的）、completed、needs_input、failed（可选）" },
        limit: { type: "integer", description: "最多几条，默认 10，最多 30" },
      },
    },
  },
  {
    name: "history_get",
    description: "读取一个任务的完整内容：用户的请求和补充、状态、完整结果或还在等用户回答的问题，以及同一执行会话里前后的任务。process=true 时另附它实际做过的步骤（调用的工具和参数、运行的命令、搜索、说过的话），用来照着上次的做法做或找出卡在哪里。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "history_search 给出的任务 id" },
        process: { type: "boolean", description: "是否附上执行过程（默认 false）" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_search",
    description: "查用户的长期约定：规则（以后怎么做、不要做什么）、偏好、双方说定的约定、关于用户的重要事实。按与关键词的相关度返回；不给 query 时列出全部（新的在前）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，例如“推送”“Roy 饮食”“订酒店”" },
        limit: { type: "integer", description: "最多几条，默认 20" },
      },
    },
  },
  {
    name: "memory_save",
    description: `记下一条用户要求长期记住的约定，之后每个执行会话都能看到或查到。只记用户明确表达的长期内容，一句话写清（最多 ${AGREEMENT_TEXT_MAX} 字），写成脱离上下文也看得懂的样子，例如“推荐商品时只看 Amazon 和 Costco”“Roy 对鸡蛋过敏”。原有约定变了时用 replaces 改写那一条，不要另记一条相反的。`,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...AGREEMENT_KINDS], description: "rule 规则（以后怎么做/不要做什么）；preference 偏好；commitment 双方说定的约定或承诺；fact 关于用户的重要事实" },
        text: { type: "string", description: "约定内容，一句话" },
        replaces: { type: "string", description: "要改写的那条约定的 id（来自 memory_search 或开头的长期约定，可选）" },
        task: { type: "string", description: "当前任务 ID，记下出处（可选）" },
      },
      required: ["kind", "text"],
    },
  },
  {
    name: "memory_forget",
    description: "删除一条不再适用的约定（用户说不用再这样了、已经过时）。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "约定 id" } }, required: ["id"] },
  },
];

/** Thread-level MCP wiring for a Codex executor. */
export function historyThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.history ? { aio_history: { url: cfg.history.url, tool_timeout_sec: 30 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function historyMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.history ? { aio_history: { type: "http", url: cfg.history.url } } : {};
}

export class HistoryGateway {
  #port: number;
  #log: Logger;
  #runtimeFor: (userId: string) => Promise<{ tasks: TaskService; db: Db }>;
  #tokens = new Map<string, string>();

  constructor(opts: { port: number; log: Logger; runtimeFor: (userId: string) => Promise<{ tasks: TaskService; db: Db }> }) {
    this.#port = opts.port;
    this.#log = opts.log.child("history-tool");
    this.#runtimeFor = opts.runtimeFor;
  }

  /** Give a runtime its history-tool URL. */
  provision(cfg: Config): void {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "history-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, cfg.runtimeUserId!);
    cfg.history = { url: `http://host.docker.internal:${this.#port}/history/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/history\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
    const userId = match ? this.#tokens.get(match[1]!) : undefined;
    if (!userId) return send(403, { error: "forbidden" });
    if (req.method === "DELETE") return send(200, {});
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 256 * 1024) return send(413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, { error: "bad request" });
    }
    const headers: Record<string, string> = {};
    if (!Array.isArray(body) && (body as { method?: string })?.method === "initialize") headers["mcp-session-id"] = randomUUID();
    const messages = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(messages.map((m) => this.#rpc(userId, m)))).filter(Boolean);
    if (!out.length) return send(202, undefined, headers);
    return send(200, Array.isArray(body) ? out : out[0], headers);
  }

  async #rpc(userId: string, message: unknown): Promise<unknown> {
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: Record<string, unknown> };
    if (id === undefined || id === null) return null; // a notification
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: (params?.protocolVersion as string) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "aio_history", version: "1" },
          instructions: HISTORY_POLICY,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(params?.name);
        if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
        return reply(await this.#call(userId, name, (params?.arguments ?? {}) as Record<string, unknown>));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
    }
  }

  async #call(userId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      const { tasks, db } = await this.#runtimeFor(userId);
      if (name === "history_search") {
        const list = tasks.searchHistoryFor(userId, { query: str(args.query), status: str(args.status), limit: typeof args.limit === "number" ? args.limit : undefined });
        return text(list.length ? list : "没有找到相关任务。换几个关键词再试，或去掉 status。");
      }
      if (name === "history_get") {
        const detail = tasks.historyDetailFor(userId, String(args.id ?? ""), { process: args.process === true });
        return detail ? text(detail) : text("没有这个任务", true);
      }
      if (name === "memory_search") {
        const found = searchAgreements(db, userId, str(args.query) ?? "", typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 20);
        return text(found.length ? found.map(({ id, kind, text: t, updatedAt }) => ({ id, kind, text: t, updated: new Date(updatedAt).toISOString().slice(0, 10) })) : "没有相关的约定。");
      }
      if (name === "memory_save") {
        const { agreement, replaced } = saveAgreement(db, userId, { kind: args.kind, text: args.text, replaces: args.replaces, taskId: str(args.task) ?? null });
        return text(`${replaced ? "已改写" : "已记下"}约定（${agreement.id}）：${agreement.text}`);
      }
      if (name === "memory_forget") {
        return forgetAgreement(db, userId, String(args.id ?? "")) ? text("已删除这条约定") : text("没有这条约定", true);
      }
      return text(`unknown tool ${name}`, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn("history tool call failed", { tool: name, error: message });
      return text(message, true);
    }
  }
}
