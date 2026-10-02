import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import type { TaskService } from "./tasks/service.js";
import { MIN_INTERVAL_MINUTES } from "./tasks/schedules.js";

/**
 * The schedule tool: the account's scheduled tasks, offered to its executors as one
 * MCP server on the member gateway. A schedule lives in the account (the same ones
 * the main session creates and the 定时任务 page shows), not in the executor's
 * session: every run is a new task. Each runtime gets its own capability URL
 * (`/schedule/<token>/mcp`), which reaches only that account's schedules.
 */

const SCHEDULE_SCHEMA = {
  type: "object",
  description: "运行规则；时间按用户本地时区理解（和沙箱里 date 命令显示的时区一致）",
  properties: {
    kind: { type: "string", enum: ["once", "daily", "weekly", "monthly", "interval"], description: "once 一次；daily 每天；weekly 每周几；monthly 每月几号；interval 每隔若干分钟" },
    at: { type: "string", description: "HH:MM（24 小时制），interval 以外都要" },
    date: { type: "string", description: "YYYY-MM-DD，仅 once" },
    weekdays: { type: "array", items: { type: "integer" }, description: "1-7（1=周一），仅 weekly" },
    monthDay: { type: "integer", description: "1-31（短月取最后一天），仅 monthly" },
    everyMinutes: { type: "integer", description: `至少 ${MIN_INTERVAL_MINUTES}，仅 interval` },
    maxRuns: { type: ["integer", "null"], description: "最多运行几次（可选）" },
    until: { type: ["string", "null"], description: "最后一天 YYYY-MM-DD（可选），例如盯到活动结束" },
  },
  required: ["kind"],
};

const TOOLS = [
  {
    name: "schedule_create",
    description:
      "为用户创建定时任务。定时任务保存在一站的账号里，不属于当前对话或会话：本次回答结束、会话关闭后照样按时运行；到点时一站自动新建一个任务去执行 instruction，结果发到用户的主会话（手机可收到推送），用户可在「定时任务」页暂停、立即运行或删除。" +
      "用于：将来某个时间提醒或去做某事（“明早 9 点提醒我…”“10/6 那天帮我看看…”），按规律重复（每天、每周、每月、每隔一段时间），以及“帮我盯着”价格、库存、开售、活动日这类需要定期去查的事——盯一件事时选合适的节奏，例如每天查一次直到活动结束（until），活动当天再多查几次可以另建一个。" +
      "不要用 sleep、cron、后台进程或会话内的计时工具代替它。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "定时任务的名称（40 字以内），例如“盯 Prime Day 扫地机价格”" },
        instruction: {
          type: "string",
          description: "每次运行要做的事：一句能独立执行的话，不含时间安排；写清楚查什么、和什么比较、什么情况值得告诉用户，例如“查 Amazon 上 Ecovacs T90 Pro Omni 的价格，低于 $449 或有 Prime 会员专享折扣时给出价格和链接，否则一句话说明没变化”",
        },
        schedule: SCHEDULE_SCHEMA,
        needsBrowser: { type: "boolean", description: "运行时是否要用浏览器查网页（默认 true）" },
      },
      required: ["title", "instruction", "schedule"],
    },
  },
  {
    name: "schedule_list",
    description: "列出用户已有的定时任务：id、名称、规则、状态、下次运行时间、每次要做的事。创建前先看看有没有相同的；暂停、恢复或取消前用它找到 id。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "schedule_change",
    description: "暂停（pause）、恢复（resume）或取消（cancel，彻底删除）一个定时任务。要改时间或要做的事时，cancel 旧的再用 schedule_create 建新的。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "schedule_list 给出的 id" },
        action: { type: "string", enum: ["pause", "resume", "cancel"] },
      },
      required: ["id", "action"],
    },
  },
];

/** Thread-level MCP wiring for a Codex executor. */
export function scheduleThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.schedule ? { aio_schedule: { url: cfg.schedule.url, tool_timeout_sec: 30 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function scheduleMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.schedule ? { aio_schedule: { type: "http", url: cfg.schedule.url } } : {};
}

export const SCHEDULE_POLICY =
  "用户要求将来某个时间做某事、按规律重复做、或“帮我盯着…”“到时候提醒我…”时，用 aio_schedule 的 schedule_create 建立定时任务：它保存在一站的账号里，跨对话、跨会话长期有效，到点自动新建任务执行并把结果发到主会话。不要说定时任务只在当前会话有效，也不要因此让用户改用别的提醒方式；需要时可以先现在查一次，再建定时任务。定时任务自己的自动运行里不要再创建新的定时任务。";

export class ScheduleGateway {
  #port: number;
  #log: Logger;
  #tasksFor: (userId: string) => Promise<TaskService>;
  #tokens = new Map<string, string>();

  constructor(opts: { port: number; log: Logger; tasksFor: (userId: string) => Promise<TaskService> }) {
    this.#port = opts.port;
    this.#log = opts.log.child("schedule-tool");
    this.#tasksFor = opts.tasksFor;
  }

  /** Give a runtime its schedule-tool URL. */
  provision(cfg: Config): void {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "schedule-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, cfg.runtimeUserId!);
    cfg.schedule = { url: `http://host.docker.internal:${this.#port}/schedule/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/schedule\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
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
          serverInfo: { name: "aio_schedule", version: "1" },
          instructions: SCHEDULE_POLICY,
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
    try {
      const tasks = await this.#tasksFor(userId);
      if (name === "schedule_create") {
        const created = tasks.createScheduleFor(userId, args);
        return created.ok ? text(`${created.message}\n\nid: ${created.schedule.id}`) : text(created.error, true);
      }
      if (name === "schedule_list") {
        const list = tasks.listSchedules(userId).map((s) => ({ id: s.id, title: s.title, rule: s.rule, status: s.status, nextRun: s.nextRunText, instruction: s.instruction, ...(s.builtin ? { builtin: true } : {}) }));
        return text(list.length ? list : "还没有定时任务。");
      }
      const action = args.action;
      if (action !== "pause" && action !== "resume" && action !== "cancel") return text("action 只能是 pause、resume 或 cancel", true);
      return text(tasks.changeSchedule(String(args.id ?? ""), userId, action).message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn("schedule tool call failed", { tool: name, error: message });
      return text(message, true);
    }
  }
}
