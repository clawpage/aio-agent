import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";

/** Lazy browser recovery, authenticated to the sandbox's account, never a caller-supplied user id. */
export class BrowserGateway {
  private tokens = new Map<string, string>();
  constructor(private opts: { port: number; log: Logger; readyFor: (userId: string) => Promise<void> }) {}

  provision(cfg: Config): void {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "browser-token");
    let token: string;
    try { token = fs.readFileSync(file, "utf8").trim(); }
    catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    if (!/^[a-f0-9]{64}$/.test(token) || !cfg.runtimeUserId) throw new Error("Invalid browser gateway identity");
    this.tokens.set(token, cfg.runtimeUserId);
    cfg.browser.readyGateway = { url: `http://host.docker.internal:${this.opts.port}/browser/ready`, token };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, error?: string) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(error ? { error } : { ok: true }));
    };
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    const userId = token && this.tokens.get(token);
    if (!userId) return send(403, "forbidden");
    if (req.url !== "/browser/ready") return send(404, "not found");
    if (req.method !== "POST") return send(405, "method not allowed");
    req.resume();
    try {
      await this.opts.readyFor(userId);
      send(200);
    } catch {
      this.opts.log.warn("browser recovery failed at tool call", { userId });
      send(503, "浏览器暂未就绪，自动恢复失败；请稍后重试。不是浏览器授权缺失。");
    }
  }
}
