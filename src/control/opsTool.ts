import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";
import type { Analytics } from "./analytics.js";
import type { AnalyticsReport } from "../common/analytics.js";
import { OPEN_REGISTRATION_LIMIT } from "./auth/invites.js";

/**
 * The operations tool: the figures of the owner's statistics page (Analytics.report),
 * offered to the owner's executors as one MCP server on the member gateway
 * (`/ops/<token>/mcp`), so a review of sign-ups or usage can read them itself.
 * Counts only: the per-account lists of the page are left out, so no username,
 * email or account id reaches the executor. Only the owner's runtime is given a URL.
 */

const RANGES = [7, 30, 90];

const TOOL = {
  name: "ops_report",
  description:
    "Read this deployment's operations figures for the last 7, 30 or 90 days (default 7), the same ones the owner's statistics page shows, as aggregate counts with no usernames, emails or account ids: " +
    "totals (accounts, sign-ups, active today / 7 days / 30 days, tasks and how they ended), current against previous (the same number of days just before), daily (one row per date), " +
    "activation (register-page views -> accounts created -> first task -> first completed task -> back the next day -> back within 7 days; eligible is how many were old enough to count), cohorts (by sign-up week), " +
    "acquisition (per campaign link, i.e. the utm_source / utm_medium / utm_campaign / utm_content of the link a browser first arrived by: register-page views, accounts created, and how many of those ran and completed a first task; the row whose fields are all null is everything without a campaign link, including the phone apps), " +
    "funnel (register-page and sign-in-page views against password sign-ups), features, quality, platforms, versions, events, and registration (accounts against the limit for signing up without an invite code). " +
    "Days before collectionStartedAt have account and task figures only. When acquisitionStartedAt is null no campaign has been recorded yet: report sources as not yet collected, not as zero. " +
    "It does not know visits to other sites, clicks on their links, or app store downloads.",
  inputSchema: {
    type: "object",
    properties: { days: { type: "integer", enum: RANGES, description: "The range in days (default 7)" } },
  },
};

/** Thread-level MCP wiring for a Codex executor. */
export function opsThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.ops ? { aio_ops: { url: cfg.ops.url, tool_timeout_sec: 60 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function opsMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.ops ? { aio_ops: { type: "http", url: cfg.ops.url } } : {};
}

export const OPS_POLICY =
  "This deployment's operations figures are available (aio_ops): when the user asks how sign-ups, activation, retention, usage or acquisition are going, or a review needs them, read them with ops_report instead of saying they are unavailable or asking the user to open the statistics page. They are aggregate counts; do not try to obtain account names or emails another way. Keep visits, register-page views, accounts created and first tasks apart, and say \"not collected\" where the report has no data rather than zero.";

/** The report without anything that names an account. */
export function aggregateReport(report: AnalyticsReport): Omit<AnalyticsReport, "accounts" | "activeTodayAccounts" | "boot" | "welcomeCards"> {
  const { accounts: _accounts, activeTodayAccounts: _today, boot: _boot, welcomeCards: _cards, quality, ...rest } = report;
  if (!quality) return rest;
  const { restoreAccounts: _restore, ...counts } = quality;
  return { ...rest, quality: counts };
}

export class OpsGateway {
  #db: Db;
  #analytics: Analytics;
  #cfg: Config;
  #log: Logger;
  #port: number;
  #tokens = new Set<string>();

  constructor(opts: { cfg: Config; db: Db; analytics: Analytics; log: Logger; port: number }) {
    this.#cfg = opts.cfg;
    this.#db = opts.db;
    this.#analytics = opts.analytics;
    this.#log = opts.log.child("ops");
    this.#port = opts.port;
  }

  /** Give the owner's runtime its URL; a member's runtime never gets one. */
  provision(cfg: Config): void {
    if (cfg.memberRuntime) return;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "ops-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.add(token);
    cfg.ops = { url: `http://host.docker.internal:${this.#port}/ops/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/ops\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
    if (!match || !this.#tokens.has(match[1]!)) return send(403, { error: "forbidden" });
    if (req.method === "DELETE") return send(200, {});
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 64 * 1024) return send(413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, { error: "bad request" });
    }
    const headers: Record<string, string> = {};
    if (!Array.isArray(body) && (body as { method?: string })?.method === "initialize") headers["mcp-session-id"] = randomUUID();
    if (Array.isArray(body)) {
      const out = body.map((m) => this.#rpc(m)).filter(Boolean);
      return out.length ? send(200, out, headers) : send(202, undefined, headers);
    }
    const out = this.#rpc(body);
    return out ? send(200, out, headers) : send(202, undefined, headers);
  }

  #rpc(message: unknown): unknown {
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: Record<string, unknown> };
    if (id === undefined || id === null) return null; // a notification
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: (params?.protocolVersion as string) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "aio_ops", version: "1" },
          instructions: OPS_POLICY,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: [TOOL] });
      case "tools/call":
        if (params?.name !== TOOL.name) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${String(params?.name)}` } };
        return reply(this.#report((params?.arguments ?? {}) as Record<string, unknown>));
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
    }
  }

  #report(args: Record<string, unknown>): unknown {
    const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
    const days = args.days === undefined || args.days === null ? 7 : Number(args.days);
    if (!RANGES.includes(days)) return text("days must be 7, 30 or 90", true);
    try {
      const report = aggregateReport(this.#analytics.report(this.#cfg, days));
      const accounts = report.totals.accounts;
      return text({ ...report, registration: { accounts, openLimit: OPEN_REGISTRATION_LIMIT, inviteRequired: accounts >= OPEN_REGISTRATION_LIMIT, unusedInvites: this.#unusedInvites() } });
    } catch (err) {
      this.#log.warn("operations report failed", { error: err instanceof Error ? err.message : String(err) });
      return text("The operations figures could not be read right now", true);
    }
  }

  #unusedInvites(): number | null {
    try {
      return (this.#db.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND revoked_at IS NULL").get() as { n: number }).n;
    } catch {
      return null;
    }
  }
}
