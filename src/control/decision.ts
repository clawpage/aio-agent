import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";
import { confident, type Jev } from "./jev.js";

/**
 * The decision tool: Jev's structured choice, offered to every account's
 * executors as one MCP server on the member gateway. Each runtime gets its own
 * capability URL (`/decision/<token>/mcp`); the Jev key stays in this process.
 * Every call is recorded per account.
 */

const OPTION_ID = /^[A-Za-z0-9_.:-]{1,40}$/;
const MAX_OPTIONS = 20;

const TOOL = {
  name: "decide",
  description:
    "让独立的判断模型（Jev）在几个明确的选项中选一个，返回选择、每个选项的概率和置信度。适合需要在已知候选之间取舍的判断：哪个方案、哪个搜索结果、哪个商品/航班最符合用户要求、下一步做什么。不会执行任何操作；把与判断有关的事实写进 context，option 的说明写清楚各自意味着什么。概率接近时说明难以区分，应结合自己的理解或向用户确认，不要把它当成确定结论。",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "要判断的问题（目标）" },
      options: { type: "object", additionalProperties: { type: "string" }, description: "候选项：id -> 这个选项意味着什么（2-20 个，id 用字母数字下划线连字符）" },
      context: { type: "string", description: "与判断有关的事实与背景（可选，最多 8000 字）" },
      rules: { type: "array", items: { type: "string" }, description: "判断时必须遵守的规则或偏好（可选）" },
    },
    required: ["question", "options"],
  },
};

/** Thread-level MCP wiring for a Codex executor. */
export function decisionThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.decision ? { aio_decision: { url: cfg.decision.url, tool_timeout_sec: Math.ceil(cfg.jev.timeoutMs / 1000) + 10 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function decisionMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.decision ? { aio_decision: { type: "http", url: cfg.decision.url } } : {};
}

export const DECISION_POLICY =
  "需要在几个明确候选之间取舍、且判断依据已经齐全时，可调用 aio_decision 的 decide 工具获得独立判断（带概率）；它只给建议，不代替你核实事实，也不是用户授权。";

export class DecisionGateway {
  #cfg: Config;
  #db: Db;
  #jev: Jev;
  #log: Logger;
  #port: number;
  #tokens = new Map<string, string>();

  constructor(opts: { cfg: Config; db: Db; jev: Jev; log: Logger; port: number }) {
    this.#cfg = opts.cfg;
    this.#db = opts.db;
    this.#jev = opts.jev;
    this.#log = opts.log.child("decision");
    this.#port = opts.port;
  }

  /** Give a runtime its decision URL; nothing is offered while Jev has no key. */
  provision(cfg: Config): void {
    if (!this.#jev.enabled) return;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "decision-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, cfg.runtimeUserId!);
    cfg.decision = { url: `http://host.docker.internal:${this.#port}/decision/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      const data = body === undefined ? "" : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(data);
    };
    const match = /^\/decision\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
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
        if (size > 1024 * 1024) return send(413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, { error: "bad request" });
    }
    const headers: Record<string, string> = {};
    if (!Array.isArray(body) && (body as { method?: string })?.method === "initialize") headers["mcp-session-id"] = randomUUID();
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.#rpc(userId, m)))).filter(Boolean);
      return out.length ? send(200, out, headers) : send(202, undefined, headers);
    }
    const out = await this.#rpc(userId, body);
    return out ? send(200, out, headers) : send(202, undefined, headers);
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
          serverInfo: { name: "aio_decision", version: "1" },
          instructions: DECISION_POLICY,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: [TOOL] });
      case "tools/call":
        if (params?.name !== TOOL.name) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${String(params?.name)}` } };
        return reply(await this.#decide(userId, (params?.arguments ?? {}) as Record<string, unknown>));
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
    }
  }

  async #decide(userId: string, args: Record<string, unknown>): Promise<unknown> {
    const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });
    const question = typeof args.question === "string" ? args.question.trim().slice(0, 2000) : "";
    const options = args.options && typeof args.options === "object" && !Array.isArray(args.options) ? Object.entries(args.options as Record<string, unknown>) : [];
    if (!question) return text("question 不能为空", true);
    if (options.length < 2 || options.length > MAX_OPTIONS) return text(`options 需要 2-${MAX_OPTIONS} 个候选`, true);
    if (options.some(([id, note]) => !OPTION_ID.test(id) || typeof note !== "string" || !note.trim())) return text("options 的 id 只能用字母、数字、下划线、点、冒号、连字符（最多 40 字），说明不能为空", true);
    const criteria = Object.fromEntries(options.map(([id, note]) => [id, String(note).slice(0, 1000)]));
    const rules = Array.isArray(args.rules) ? args.rules.filter((r): r is string => typeof r === "string").map((r) => r.slice(0, 500)).slice(0, 20) : [];
    const context = typeof args.context === "string" ? args.context.slice(0, 8000) : "";
    const started = Date.now();
    const record = (row: { ok: boolean; choice?: string; confidence?: number; error?: string; usage?: unknown }) => {
      try {
        this.#db.prepare("INSERT INTO decision_events (created_at,owner_id,ok,latency_ms,question,options,choice,confidence,error,usage_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(started, userId, row.ok ? 1 : 0, Date.now() - started, question.slice(0, 500), options.length, row.choice ?? null, row.confidence ?? null, row.error ?? null, row.usage === undefined ? null : JSON.stringify(row.usage));
      } catch { /* monitoring never fails the call */ }
    };
    try {
      const result = await this.#jev.decide({ context, now: new Date().toISOString() }, { decision: { criteria, instructions: { goal: question, ...(rules.length ? { rules } : {}) } } });
      const answer = result.answers.decision!;
      record({ ok: true, choice: answer.choice, confidence: answer.confidence, usage: result.usage });
      return text({ choice: answer.choice, confident: confident(answer), confidence: answer.confidence, probabilities: answer.probabilities });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      record({ ok: false, error });
      this.#log.warn("decision failed", { error });
      return text(`判断服务暂时不可用：${error}`, true);
    }
  }
}
