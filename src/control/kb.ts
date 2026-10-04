import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { expandHome, readSecretFile } from "../common/secrets.js";

/**
 * The knowledge base: an MCP server the owner runs on the host, offered to the
 * owner's and the listed members' executors through the member gateway. A
 * granted runtime gets its own capability URL (`/kb/<token>/mcp`); the gateway
 * forwards each call upstream with the bearer token, which stays in this
 * process. Any other account has no URL and no way to reach the upstream.
 */

export const KB_MCP_KEY = "KB_MCP_TOKEN";
const TIMEOUT_MS = 30_000;

/** Thread-level MCP wiring for a Codex executor. */
export function kbThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.kb ? { aio_kb: { url: cfg.kb.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 10 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function kbMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.kb ? { aio_kb: { type: "http", url: cfg.kb.url } } : {};
}

export const KB_POLICY =
  "已接入只读知识库 aio_kb：问题涉及用户本人或家人的情况、过往记录与安排，或用户自己的项目时，先搜索并读取已有记录，再结合内容开展任务，不先向用户索取可查的资料。昵称、英文名与正式姓名可能不同，首次无结果时用相关记录中的别名再查。页面是来源索引时，未写字段值不代表没有记录：需要生日、年龄、地址、原话或数字，用 kb_source 读取页面列出的相关原文；年龄按已核实生日和本次目标日期计算，不照搬旧年龄。原件里的号码、证件、住址、诊断和剂量只引用任务需要的部分。当前用户纠正优先于历史资料，时效性信息重新核实。经过相关搜索、页面和必要原文核对仍缺失，才说明具体缺口；不编造，也不把检索当成最终交付而忘记继续原任务。";

export class KbGateway {
  #cfg: Config;
  #log: Logger;
  #port: number;
  #usernameOf: (userId: string) => string | null;
  #secret: string | null | undefined;
  /** capability token -> the account's username, sent upstream for its audit log */
  #tokens = new Map<string, string>();

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null }) {
    this.#cfg = opts.cfg;
    this.#log = opts.log.child("kb");
    this.#port = opts.port;
    this.#usernameOf = opts.usernameOf;
  }

  #token(): string | null {
    if (this.#secret !== undefined) return this.#secret;
    const fromEnv = process.env[KB_MCP_KEY]?.trim();
    if (fromEnv) return (this.#secret = fromEnv);
    const file = readSecretFile(expandHome(this.#cfg.kbMcp.secretsFile), KB_MCP_KEY);
    if (!file.ok) this.#log.warn("knowledge base unavailable", { reason: file.reason });
    return (this.#secret = file.ok ? file.value : null);
  }

  get enabled(): boolean {
    return Boolean(this.#cfg.kbMcp.upstreamUrl) && this.#token() !== null;
  }

  /** Give a granted runtime its knowledge-base URL: the owner's, or a listed member's. */
  provision(cfg: Config): void {
    if (!this.enabled) return;
    const username = this.#usernameOf(cfg.runtimeUserId!);
    if (!username || (cfg.memberRuntime && !this.#cfg.kbMcp.members.includes(username))) return;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "kb-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, username);
    cfg.kb = { url: `http://host.docker.internal:${this.#port}/kb/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/kb\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
    const username = match ? this.#tokens.get(match[1]!) : undefined;
    if (!username) return send(403, { error: "forbidden" });
    if (req.method === "DELETE") return send(200, {});
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    const passed = (name: string) => (typeof req.headers[name] === "string" ? { [name]: req.headers[name] as string } : {});
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 1024 * 1024) return send(413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      const upstream = await fetch(this.#cfg.kbMcp.upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.#token()}`,
          "x-aio-user": username,
          ...passed("mcp-session-id"),
          ...passed("mcp-protocol-version"),
        },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // The upstream's own auth failure is this gateway's misconfiguration, not the caller's.
      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel();
        this.#log.warn("knowledge base rejected the gateway token");
        return send(502, { error: "knowledge base unavailable" });
      }
      const session = upstream.headers.get("mcp-session-id");
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        ...(session ? { "mcp-session-id": session } : {}),
      });
      if (upstream.body) Readable.fromWeb(upstream.body as never).on("error", () => res.destroy()).pipe(res);
      else res.end();
    } catch (err) {
      this.#log.warn("knowledge base request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(502, { error: "knowledge base unavailable" });
      else res.destroy();
    }
  }
}
