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
    "Have an independent judgment model (Jev) choose one of several clearly defined options; returns the choice, the probability of each option, and the confidence. Suited to judgments that weigh known candidates against each other: which plan, which search result, which product/flight best fits the user's requirements, what to do next. It does not perform any action; put the facts relevant to the judgment in context, and make each option's description say clearly what it means. Close probabilities mean the options are hard to tell apart; combine the result with your own understanding or confirm with the user, and do not treat it as a definite conclusion.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to judge (the goal)" },
      options: { type: "object", additionalProperties: { type: "string" }, description: "Candidates: id -> what this option means (2-20 of them; ids use letters, digits, underscores, and hyphens)" },
      context: { type: "string", description: "Facts and background relevant to the judgment (optional, at most 8000 characters)" },
      rules: { type: "array", items: { type: "string" }, description: "Rules or preferences the judgment must follow (optional)" },
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
  "When you need to choose among several clearly defined candidates and the basis for the judgment is already complete, you can call the decide tool from aio_decision to get an independent judgment (with probabilities); it only gives advice, does not replace your own fact-checking, and is not user authorization.";

export class DecisionGateway {
  #db: Db;
  #jev: Jev;
  #log: Logger;
  #port: number;
  #tokens = new Map<string, string>();

  constructor(opts: { db: Db; jev: Jev; log: Logger; port: number }) {
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
    if (!question) return text("question must not be empty", true);
    if (options.length < 2 || options.length > MAX_OPTIONS) return text(`options needs 2-${MAX_OPTIONS} candidates`, true);
    if (options.some(([id, note]) => !OPTION_ID.test(id) || typeof note !== "string" || !note.trim())) return text("option ids can only use letters, digits, underscores, dots, colons, and hyphens (at most 40 characters), and descriptions must not be empty", true);
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
      return text(`The judgment service is temporarily unavailable: ${error}`, true);
    }
  }
}
