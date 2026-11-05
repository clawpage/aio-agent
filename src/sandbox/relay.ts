import http from "node:http";
import https from "node:https";
import type { Logger } from "../common/logger.js";

/** While the control plane restarts its gateway refuses connections: requests wait this long for it. */
const RETRY_FOR_MS = 60_000;
const RETRY_EVERY_MS = 500;
/** Request bodies are held so a request can be sent again; nothing the gateway takes comes near this. */
const MAX_BODY = 64 * 1024 * 1024;
/** Errors that mean the request never reached the gateway, so sending it again is safe. */
const NOT_DELIVERED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

/**
 * Sandboxes reach the control plane's gateway (models, share, decisions,
 * knowledge base) at `host.docker.internal:<port>`. When the control plane runs
 * on another machine, this relay listens there on the node and forwards every
 * request unchanged; the gateway itself checks each account's capability token.
 * A request the gateway could not take (it is restarting, or not open yet) is
 * sent again until it can, so a turn that goes on through a restart of the
 * control plane does not fail on a model or tool call made meanwhile.
 */
export function createGatewayRelay(upstream: string, log: Logger, retryForMs = RETRY_FOR_MS): http.Server {
  const base = new URL(upstream);
  const client = base.protocol === "https:" ? https : http;
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const started = Date.now();
    const send = (body: Buffer) => {
      const out = client.request(
        { protocol: base.protocol, host: base.hostname, port: base.port || (base.protocol === "https:" ? 443 : 80), method: req.method, path: req.url, headers: { ...req.headers, host: base.host } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders);
          up.pipe(res);
        },
      );
      out.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (!res.headersSent && !res.destroyed && NOT_DELIVERED.has(code) && Date.now() - started < retryForMs) {
          setTimeout(() => send(body), RETRY_EVERY_MS);
          return;
        }
        log.debug("gateway relay error", { error: String(err) });
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      res.once("close", () => out.destroy());
      out.end(body);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!res.writableEnded) send(Buffer.concat(chunks)); });
  });
}
