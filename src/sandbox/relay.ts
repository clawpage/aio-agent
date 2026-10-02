import http from "node:http";
import https from "node:https";
import type { Logger } from "../common/logger.js";

/**
 * Sandboxes reach the control plane's gateway (models, share, decisions,
 * knowledge base) at `host.docker.internal:<port>`. When the control plane runs
 * on another machine, this relay listens there on the node and forwards every
 * request unchanged; the gateway itself checks each account's capability token.
 */
export function createGatewayRelay(upstream: string, log: Logger): http.Server {
  const base = new URL(upstream);
  const client = base.protocol === "https:" ? https : http;
  return http.createServer((req, res) => {
    const out = client.request(
      { protocol: base.protocol, host: base.hostname, port: base.port || (base.protocol === "https:" ? 443 : 80), method: req.method, path: req.url, headers: { ...req.headers, host: base.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders);
        up.pipe(res);
      },
    );
    out.on("error", (err) => {
      log.debug("gateway relay error", { error: String(err) });
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    res.on("close", () => out.destroy());
    req.pipe(out);
  });
}
