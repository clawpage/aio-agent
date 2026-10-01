import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { expandHome, readSecretFile } from "./bridgeModel.js";

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
  "已接入只读知识库 aio_kb：问题涉及用户本人或家人的情况、过往记录与安排，或用户自己的项目时，先用它的搜索和读取工具查已有记录，再结合查到的内容作答；记录可能过时或未核对，按页面标注的状态说明。知识库里查不到就如实说明，不要编造。";

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
