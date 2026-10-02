#!/usr/bin/env node
/**
 * The UI layer's web server. It serves the built console (dist/ui) and passes
 * `/api/*` through to the control plane unchanged, so the console stays on one
 * origin with the API and the cookie/CSRF model needs no cross-origin rules.
 * It has no state and no secrets; a packaged app talks to the control plane
 * directly instead.
 *
 * Environment:
 *   AIO_UI_PORT / AIO_UI_BIND   where to listen (4891 / 127.0.0.1)
 *   AIO_CONTROL_URL             the control plane (http://127.0.0.1:4892)
 *   AIO_WORKSPACE_ORIGIN        the workspace origin the console may frame
 *   AIO_UI_DIST                 the built console (../../dist/ui from here)
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Hop-by-hop headers never cross a proxy. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"]);

export function createEdge({ dist, control, workspaceOrigin = "", log = () => undefined }) {
  const root = path.resolve(dist);
  const upstream = new URL(control);
  const client = upstream.protocol === "https:" ? https : http;
  const upstreamPort = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);
  const build = readBuild(root);
  const csp = [
    "default-src 'self'",
    `frame-src 'self'${workspaceOrigin ? ` ${workspaceOrigin}` : ""}`,
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  let compat = { at: 0, value: null };

  /** Whether the control plane serves the API version this build was made for (cached briefly). */
  async function compatible() {
    if (compat.value && Date.now() - compat.at < 30_000) return compat.value;
    let value;
    try {
      const v = await getJson("/api/version");
      const ok = Number.isInteger(build.api) && build.api >= v.apiMin && build.api <= v.api;
      value = { ok, ui: build, control: { version: v.version, api: v.api, apiMin: v.apiMin } };
    } catch (err) {
      value = { ok: false, ui: build, control: null, error: String(err?.message ?? err) };
    }
    compat = { at: Date.now(), value };
    return value;
  }

  /**
   * A GET to the control plane under a loopback Host it always accepts: the
   * compose service name is not one of its allowed hosts, and it is right to refuse it.
   */
  function getJson(pathname) {
    return new Promise((resolve, reject) => {
      const req = client.get({ host: upstream.hostname, port: upstreamPort, path: pathname, headers: { host: "localhost" }, timeout: 5000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });
  }

  function proxy(req, res) {
    const headers = { ...req.headers };
    for (const h of HOP) delete headers[h];
    const out = client.request({ host: upstream.hostname, port: upstreamPort, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, stripHop(up.rawHeaders));
      up.pipe(res);
    });
    out.on("error", (err) => {
      log("control unreachable", String(err));
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "control_unreachable", message: "服务暂时不可用，请稍后重试" }));
      else res.destroy();
    });
    res.on("close", () => out.destroy());
    req.pipe(out);
  }

  function serveFile(req, res, file, cacheable) {
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const stat = fs.statSync(file);
    const headers = {
      "content-type": type,
      "content-length": stat.size,
      "x-content-type-options": "nosniff",
      // Hashed build assets never change; everything else is checked on every load.
      "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
      "last-modified": stat.mtime.toUTCString(),
    };
    if (type.startsWith("text/html")) headers["content-security-policy"] = csp;
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://edge");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return proxy(req, res);
    if (url.pathname === "/healthz") {
      void compatible().then((c) => {
        res.writeHead(c.ok ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: c.ok, ui: c.ui, control: c.control }));
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    let file;
    try {
      file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file, url.pathname.startsWith("/assets/"));
    // Every other path is a console route (/u/<name>, ...): the app itself decides.
    serveFile(req, res, path.join(root, "index.html"), false);
  });

  // WebSocket upgrades under /api go through untouched; nothing else upgrades here.
  server.on("upgrade", (req, socket, head) => {
    if (!(req.url ?? "").startsWith("/api/")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const out = upstream.protocol === "https:" ? tls.connect({ host: upstream.hostname, port: upstreamPort, servername: upstream.hostname }) : net.connect(upstreamPort, upstream.hostname);
    out.once(upstream.protocol === "https:" ? "secureConnect" : "connect", () => {
      let lines = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      out.write(`${lines}\r\n`);
      if (head.length) out.write(head);
      out.pipe(socket);
      socket.pipe(out);
    });
    const close = () => {
      out.destroy();
      socket.destroy();
    };
    out.on("error", close);
    socket.on("error", close);
    out.on("close", close);
    socket.on("close", close);
  });

  return { server, compatible };
}

function stripHop(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) if (!HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
  return out;
}

/** What this build of the console needs from the control plane (written by the build). */
function readBuild(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "aio-ui.json"), "utf8"));
  } catch {
    return { api: null, version: null };
  }
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isDirectRun) {
  const port = Number(process.env.AIO_UI_PORT ?? 4891);
  const bind = process.env.AIO_UI_BIND ?? "127.0.0.1";
  const dist = process.env.AIO_UI_DIST ?? path.resolve(import.meta.dirname, "..", "..", "dist", "ui");
  const control = process.env.AIO_CONTROL_URL ?? "http://127.0.0.1:4892";
  const log = (msg, detail) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), scope: "ui-edge", msg, detail })}\n`);
  const { server, compatible } = createEdge({ dist, control, workspaceOrigin: process.env.AIO_WORKSPACE_ORIGIN ?? "", log });
  server.listen(port, bind, () => {
    log("ui edge listening", { bind, port, control });
    void compatible().then((c) => log(c.ok ? "control plane compatible" : "control plane NOT compatible", c));
  });
  const close = () => {
    server.closeAllConnections();
    server.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
