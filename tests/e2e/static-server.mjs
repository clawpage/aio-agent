/**
 * Minimal static server for the built web app (`dist/web`), used as the
 * Playwright `webServer` by `playwright.local.config.ts`.
 *
 * It deliberately never proxies `/api`: every API call in the local specs is
 * mocked with `page.route`, so this harness cannot reach a real deployment.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 4288);
// Default to the checked-in build output, but let a local run point at a
// scratch `--outDir` build (PA_TEST_WEB_ROOT is an absolute path) so verifying
// source changes never has to overwrite the served `dist/web` bundle.
const root = process.env.PA_TEST_WEB_ROOT
  ? path.resolve(process.env.PA_TEST_WEB_ROOT)
  : path.resolve(fileURLToPath(new URL("../../dist/web", import.meta.url)));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  // A missing API is a 404, never a successful HTML response. This also lets
  // rolling-upgrade specs exercise the older backend without the task API.
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
    return;
  }
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  // SPA fallback: any unknown path serves index.html.
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(root, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(filePath));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`personal-agent local web harness listening on http://127.0.0.1:${port}`);
});
