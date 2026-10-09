import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { expandHome, readSecretFile } from "../common/secrets.js";

/**
 * An MCP server on the host (streamable HTTP) offered to some accounts'
 * executors through the member gateway: the knowledge base, Home Assistant. A
 * granted runtime gets its own capability URL (`/<name>/<token>/mcp`); the
 * gateway forwards each call upstream with the bearer token, which stays in
 * this process. Any other account has no URL and no way to reach the upstream.
 */
export interface McpGatewayOptions {
  /** URL path segment and token file prefix (`<dataDir>/<name>-token`). */
  name: string;
  cfg: Config;
  log: Logger;
  port: number;
  usernameOf: (userId: string) => string | null;
  upstreamUrl: string;
  /** The bearer token's key, read from the environment first, then from `secretsFile`. */
  secretKey: string;
  secretsFile: string;
  /** Whether this runtime's account may use the server. */
  granted: (username: string, runtime: Config) => boolean;
  /** Records the granted runtime's capability URL on its config. */
  assign: (runtime: Config, url: string) => void;
  timeoutMs: number;
}

export class McpGateway {
  #opts: McpGatewayOptions;
  #log: Logger;
  #secret: string | null | undefined;
  /** capability token -> the account's username, sent upstream as X-Aio-User for its audit log */
  #tokens = new Map<string, string>();

  constructor(opts: McpGatewayOptions) {
    this.#opts = opts;
    this.#log = opts.log.child(opts.name);
  }

  #token(): string | null {
    if (this.#secret !== undefined) return this.#secret;
    const fromEnv = process.env[this.#opts.secretKey]?.trim();
    if (fromEnv) return (this.#secret = fromEnv);
    const file = readSecretFile(expandHome(this.#opts.secretsFile), this.#opts.secretKey);
    if (!file.ok) this.#log.warn(`${this.#opts.name} MCP unavailable`, { reason: file.reason });
    return (this.#secret = file.ok ? file.value : null);
  }

  /** The upstream bearer token, for a subclass that reaches the same upstream another way. */
  protected upstreamToken(): string | null {
    return this.#token();
  }

  get enabled(): boolean {
    return Boolean(this.#opts.upstreamUrl) && this.#token() !== null;
  }

  /** Give a granted runtime its URL. */
  provision(cfg: Config): void {
    if (!this.enabled) return;
    const username = this.#opts.usernameOf(cfg.runtimeUserId!);
    if (!username || !this.#opts.granted(username, cfg)) return;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, `${this.#opts.name}-token`);
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, username);
    this.#opts.assign(cfg, `http://host.docker.internal:${this.#opts.port}/${this.#opts.name}/${token}/mcp`);
  }

  /** Whether a gateway request path is this server's. */
  owns(url: string | undefined): boolean {
    return (url ?? "").startsWith(`/${this.#opts.name}/`);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = new RegExp(`^/${this.#opts.name}/([a-f0-9]{64})/mcp$`).exec(req.url ?? "");
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
      const upstream = await fetch(this.#opts.upstreamUrl, {
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
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
      // The upstream's own auth failure is this gateway's misconfiguration, not the caller's.
      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel();
        this.#log.warn(`${this.#opts.name} MCP rejected the gateway token`);
        return send(502, { error: `${this.#opts.name} unavailable` });
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
      this.#log.warn(`${this.#opts.name} MCP request failed`, { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(502, { error: `${this.#opts.name} unavailable` });
      else res.destroy();
    }
  }
}
