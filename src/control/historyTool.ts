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
  "AIO's history aio_history is connected: look up past tasks and standing agreements as needed instead of relying on them being put into the context in advance. " +
  "When the user mentions earlier, last time, that one from before, what we agreed, or do you remember, or when this task clearly continues something from earlier (the same person, item, project, website, or app), first search a few keywords with history_search (ranked by relevance; you can include names of people, items, places, or apps), then read the most relevant one or two with history_get. " +
  "To know exactly how it was done at the time or which step it got stuck on (configuration steps, how it signed in, the products chosen), add process=true to see the execution process. The session field in the results says which task it was in which executor session; history_get lists the tasks before and after it in the same session, so read along them when needed. Results of related tasks in the background material may be truncated; use history_get for the full content as well. " +
  "When the user explicitly gives a rule or preference to follow from now on (\"以后…\" / \"from now on…\", \"每次都…\" / \"every time…\", \"别再…\" / \"don't … again\", \"记住…\" / \"remember…\"), an agreement both sides settled on, or an important fact about the user, record it as one sentence with memory_save; if they change their mind, rewrite the original entry with replaces, and use memory_forget when it no longer applies. Do not record one-off task details, temporary information, or guesses, and do not make long-term decisions for the user that they have not expressed. " + // i18n-exempt: examples of what people type, for the executor
  "The standing agreements given at the start list only some of them; search again with memory_search when a topic might be related. If nothing is found, say you did not find it; do not make up the past. Information in history that changes, such as prices or opening hours, must be verified again before use.";

const TOOLS = [
  {
    name: "history_search",
    description: "Search the tasks the user has done in AIO (including those from other executor sessions, the voice gadget, and scheduled tasks): returns, ranked by relevance, the id, date, title, request summary, matching snippets from the result, status, and its position in its executor session. Without query, lists the most recent tasks by time.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few keywords separated by spaces; matching any one is enough, and more keywords give more precise results, e.g. \"小红书 双开 安全文件夹\" (\"Xiaohongshu dual app secure folder\"), \"Roy 疫苗 预约\" (\"Roy vaccine appointment\")" }, // i18n-exempt: examples of what people type, for the executor
        status: { type: "string", description: "Only one status: open (not finished yet), completed, needs_input, failed (optional)" },
        limit: { type: "integer", description: "Maximum number of results, default 10, at most 30" },
      },
    },
  },
  {
    name: "history_get",
    description: "Read the full content of a task: the user's request and follow-ups, status, the complete result or the question still waiting for the user's answer, and the tasks before and after it in the same executor session. With process=true, also includes the steps it actually took (tools called and their arguments, commands run, searches, things it said), for following last time's approach or finding where it got stuck.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task id given by history_search" },
        process: { type: "boolean", description: "Whether to include the execution process (default false)" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_search",
    description: "Look up the user's standing agreements: rules (how to do things from now on, what not to do), preferences, agreements both sides settled on, and important facts about the user. Returned by relevance to the keywords; without query, lists all of them (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. \"推送\" (\"feed\"), \"Roy 饮食\" (\"Roy diet\"), \"订酒店\" (\"book hotel\")" }, // i18n-exempt: examples of what people type, for the executor
        limit: { type: "integer", description: "Maximum number of results, default 20" },
      },
    },
  },
  {
    name: "memory_save",
    description: `Record an agreement the user wants remembered long term; every later executor session can see or look it up. Record only long-term things the user explicitly expressed, written clearly in one sentence (at most ${AGREEMENT_TEXT_MAX} characters) that makes sense out of context, e.g. "推荐商品时只看 Amazon 和 Costco" ("only look at Amazon and Costco when recommending products"), "Roy 对鸡蛋过敏" ("Roy is allergic to eggs"). When an existing agreement changes, rewrite that entry with replaces instead of recording a separate contradictory one.`, // i18n-exempt: examples of what people type, for the executor
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...AGREEMENT_KINDS], description: "rule: a rule (how to do things from now on / what not to do); preference: a preference; commitment: an agreement or promise both sides settled on; fact: an important fact about the user" },
        text: { type: "string", description: "The agreement, in one sentence" },
        replaces: { type: "string", description: "The id of the agreement to rewrite (from memory_search or the standing agreements at the start; optional)" },
        task: { type: "string", description: "Current task ID, recorded as the source (optional)" },
      },
      required: ["kind", "text"],
    },
  },
  {
    name: "memory_forget",
    description: "Delete an agreement that no longer applies (the user says it is no longer needed, or it is outdated).",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Agreement id" } }, required: ["id"] },
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
        return text(list.length ? list : "No matching tasks found. Try other keywords, or drop status.");
      }
      if (name === "history_get") {
        const detail = tasks.historyDetailFor(userId, String(args.id ?? ""), { process: args.process === true });
        return detail ? text(detail) : text("No such task", true);
      }
      if (name === "memory_search") {
        const found = searchAgreements(db, userId, str(args.query) ?? "", typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 20);
        return text(found.length ? found.map(({ id, kind, text: t, updatedAt }) => ({ id, kind, text: t, updated: new Date(updatedAt).toISOString().slice(0, 10) })) : "No matching agreements.");
      }
      if (name === "memory_save") {
        const { agreement, replaced } = saveAgreement(db, userId, { kind: args.kind, text: args.text, replaces: args.replaces, taskId: str(args.task) ?? null });
        return text(`${replaced ? "Rewrote" : "Recorded"} agreement (${agreement.id}): ${agreement.text}`);
      }
      if (name === "memory_forget") {
        return forgetAgreement(db, userId, String(args.id ?? "")) ? text("Deleted this agreement") : text("No such agreement", true);
      }
      return text(`unknown tool ${name}`, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn("history tool call failed", { tool: name, error: message });
      return text(message, true);
    }
  }
}
