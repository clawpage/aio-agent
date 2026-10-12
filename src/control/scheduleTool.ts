import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import type { TaskService } from "./tasks/service.js";
import { MAX_DATES, MAX_TIMES_A_DAY, MIN_INTERVAL_MINUTES } from "./tasks/schedules.js";

/**
 * The schedule tool: the account's scheduled tasks, offered to its executors as one
 * MCP server on the member gateway. A schedule lives in the account (the same ones
 * the main session creates and the 定时任务 page shows), not in the executor's
 * session: every run is a new task. Each runtime gets its own capability URL
 * (`/schedule/<token>/mcp`), which reaches only that account's schedules.
 */

const SCHEDULE_SCHEMA = {
  type: "object",
  description: "When to run; times are in the user's local time zone (the same zone the date command shows in the sandbox)",
  properties: {
    kind: { type: "string", enum: ["once", "daily", "weekly", "monthly", "interval", "dates"], description: "once: one time; daily: every day; weekly: on certain weekdays; monthly: on a day of the month; interval: every so many minutes; dates: a few irregular dates and times" },
    at: { type: "string", description: "HH:MM (24-hour): required for once, daily, weekly, and monthly (use times for several runs a day)" },
    times: { type: "array", items: { type: "string" }, description: `Several HH:MM times when it should run more than once a day (at most ${MAX_TIMES_A_DAY}), instead of at; daily, weekly, and monthly only` },
    dates: { type: "array", items: { type: "string" }, description: `A few irregular run times, each "YYYY-MM-DD HH:MM" (at most ${MAX_DATES}); dates only, e.g. ["2026-10-08 09:00", "2026-10-15 14:30"]` },
    date: { type: "string", description: "YYYY-MM-DD; once only" },
    weekdays: { type: "array", items: { type: "integer" }, description: "1-7 (1=Monday); weekly only" },
    monthDay: { type: "integer", description: "1-31 (short months use their last day); monthly only" },
    everyMinutes: { type: "integer", description: `At least ${MIN_INTERVAL_MINUTES}; interval only` },
    maxRuns: { type: ["integer", "null"], description: "Maximum number of runs (optional)" },
    until: { type: ["string", "null"], description: "Last day YYYY-MM-DD (optional), e.g. to keep watching until an event ends" },
  },
  required: ["kind"],
};

const TOOLS = [
  {
    name: "schedule_create",
    description:
      "Create a scheduled task for the user. Scheduled tasks are saved in the user's AIO account, not in the current conversation or session: they keep running on time after this answer ends and after the session closes. When one is due, AIO automatically creates a new task to carry out the instruction and sends the result to the user's main session (the phone can get a push notification); the user can pause it, run it now, or delete it on the 定时任务 (Scheduled tasks) page. " +
      "Use it for: reminding the user or doing something at a future time (\"明早 9 点提醒我…\" / \"remind me at 9 tomorrow morning…\", \"10/6 那天帮我看看…\" / \"check … for me on 10/6\"), repeating on a pattern (daily, weekly, monthly, every so often), and \"帮我盯着\" (\"keep an eye on it for me\") requests such as prices, stock, sale launches, or event days that need checking periodically. When watching something, pick a suitable cadence, for example check once a day until the event ends (until), and create a separate one to check a few more times on the day of the event. " +
      "Do not use sleep, cron, background processes, or in-session timer tools instead of it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Name of the scheduled task (at most 40 characters), e.g. \"盯 Prime Day 扫地机价格\" (\"Watch robot vacuum prices for Prime Day\")" },
        instruction: {
          type: "string",
          description: "What to do on each run: one self-contained sentence without the timing. Say clearly what to check, what to compare it with, and when it is worth telling the user, e.g. \"Check the price of the Ecovacs T90 Pro Omni on Amazon; if it is below $449 or has a Prime member-exclusive discount, give the price and link, otherwise say in one sentence that nothing changed\"",
        },
        schedule: SCHEDULE_SCHEMA,
        needsBrowser: { type: "boolean", description: "Whether a run needs the browser to check web pages (default true)" },
      },
      required: ["title", "instruction", "schedule"],
    },
  },
  {
    name: "schedule_list",
    description: "List the user's existing scheduled tasks: id, name, rule (rule is the human-readable wording; schedule is the rule you can edit directly and pass to schedule_update), status, next run time, and what each run does. Check for an identical one before creating; use it to find the id before changing, pausing, resuming, or cancelling.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "schedule_change",
    description: "Pause (pause), resume (resume), or cancel (cancel, deletes it permanently) a scheduled task. To change its time or what it does, use schedule_update.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id given by schedule_list" },
        action: { type: "string", enum: ["pause", "resume", "cancel"] },
      },
      required: ["id", "action"],
    },
  },
  {
    name: "schedule_update",
    description:
      "Change an existing scheduled task: its name, what each run does, its rule (change the time, add or remove run times, switch to a few irregular dates), or whether it uses the browser. Pass only the fields to change; when changing the rule, pass the complete new schedule (you can edit the schedule that schedule_list gives). After the rule changes, the run count (maxRuns) restarts from now, and a scheduled task that had finished starts again if it has a next run. Change the built-in daily feed with feed_update.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id given by schedule_list" },
        title: { type: "string", description: "New name (at most 40 characters)" },
        instruction: { type: "string", description: "New description of what each run does, written the same way as for schedule_create" },
        schedule: SCHEDULE_SCHEMA,
        needsBrowser: { type: "boolean", description: "Whether a run needs the browser" },
      },
      required: ["id"],
    },
  },
  {
    name: "feed_get",
    description:
      "View the built-in 每日推送 (daily feed): its push time, status, the requirements the user gave it (instruction; customized=false means it is still the default one-sentence instruction), and what it remembers in memory (care: things to pay more attention to; avoid: things not to push again; note: the user's habits and preferences about the feed; source is user if the user said it, or feed if the feed learned it on its own). " +
      "Each time the daily feed runs, the system includes a complete set of instructions: read all of the user's past tasks, check the latest information online, look read-only at the email and feeds the user is signed in to, use the last few feeds and the user's reactions to avoid repetition, plus the requirements and memory here. Use it to see the current state before describing the feed to the user or changing it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "feed_update",
    description:
      "Change the built-in 每日推送 (daily feed). Use it when the user wants to change what the feed does or where it looks (e.g. \"每天推送时帮我看看 Gmail 有没有账单\" / \"check Gmail for bills in the daily feed\", \"推送少说新闻\" / \"less news in the feed\"), change the push time, tells you what they care about or no longer want to see, or gives feedback on a feed item (useful, want more, stop pushing this). Record all of these with it, and every later daily feed will follow them. " +
      "instruction replaces the user's previous requirements as a whole: rewrite on top of the existing requirements and do not drop parts that still apply; pass an empty string to restore the default. add adds memory; remove deletes memory by the id from feed_get; at most 30 entries per kind. Do not create a separate scheduled task to adjust the feed.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "The user's complete requirements for the daily feed (at most 1500 characters); appended to the system instructions and followed first; an empty string restores the default" },
        at: { type: "string", description: "New daily push time HH:MM (24-hour)" },
        add: {
          type: "array",
          description: "Things to remember",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["care", "avoid", "note"], description: "care: things or sources to pay more attention to; avoid: topics not to push again; note: preferences about the feed's format or timing" },
              text: { type: "string", description: "One sentence (at most 200 characters), e.g. \"Roy 的疫苗和体检预约\" (\"Roy's vaccine and checkup appointments\"), \"不要再推加密货币行情\" (\"stop pushing crypto prices\"), \"只在有降价时才提商品\" (\"mention products only when there is a price drop\")" },
            },
            required: ["kind", "text"],
          },
        },
        remove: { type: "array", items: { type: "string" }, description: "Ids of memory entries to delete (given by feed_get): outdated ones or ones contradicted by what the user now says" },
        source: { type: "string", enum: ["user", "feed"], description: "user: the user said it in the conversation (default); feed: the daily feed learned it on its own from the user's reactions" },
      },
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
  "When the user asks to do something at a future time, to repeat something on a pattern, or says things like \"帮我盯着…\" (\"keep an eye on … for me\") or \"到时候提醒我…\" (\"remind me when it's time…\"), create a scheduled task with schedule_create from aio_schedule (use kind=dates for a few irregular dates and times for several runs a day). It is saved in the user's AIO account and stays in effect across conversations and sessions; when due it automatically creates a new task to run and sends the result to the main session. Do not say that scheduled tasks only last for the current session, and do not ask the user to use some other reminder method because of that; when useful, you can check once now and then create the scheduled task. Inside a scheduled task's own automatic run, do not create further scheduled tasks. When the user wants to change an existing scheduled task's time, number of runs, or content, find it with schedule_list first, then change it with schedule_update; do not delete it and recreate it. " +
  "Each account has a built-in 每日推送 (daily feed): when the user wants to change what it does, where it looks, or when it pushes, mentions what they care about or no longer want to see, or gives feedback on a feed item (useful, want more, stop pushing this), use feed_get to see the current state and feed_update to change or record it; do not create a separate scheduled task.";

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
        const list = tasks.listSchedules(userId).map(({ spec: { anchorAt: _anchor, ...schedule }, ...s }) => ({ id: s.id, title: s.title, rule: s.rule, schedule, status: s.status, nextRun: s.nextRunText, instruction: s.instruction, needsBrowser: s.needsBrowser, ...(s.builtin ? { builtin: true, note: "The built-in daily feed: view its full settings and memory with feed_get, change them with feed_update" } : {}) }));
        return text(list.length ? list : "No scheduled tasks yet.");
      }
      if (name === "schedule_update") {
        const changed = tasks.updateScheduleFor(userId, args);
        return changed.ok ? text(changed.message) : text(changed.error, true);
      }
      if (name === "feed_get") return text(tasks.feedSettings(userId));
      if (name === "feed_update") return text(tasks.updateFeed(userId, args));
      const action = args.action;
      if (action !== "pause" && action !== "resume" && action !== "cancel") return text("action must be pause, resume, or cancel", true);
      return text(tasks.changeSchedule(String(args.id ?? ""), userId, action).message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn("schedule tool call failed", { tool: name, error: message });
      return text(message, true);
    }
  }
}
