import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { createEdge } from "../../src/ui/edge.mjs";

let control: http.Server;
let edge: http.Server;
let base: string;
let dist: string;
let api = { api: 1, apiMin: 1 };
const seen: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "aio-edge-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>一站</title>");
  fs.writeFileSync(path.join(dist, "assets", "app-abc123.js"), "console.log(1)");
  fs.writeFileSync(path.join(dist, "sw.js"), "self.addEventListener('push',()=>{})");
  fs.writeFileSync(path.join(dist, "aio-ui.json"), JSON.stringify({ component: "ui", version: "0.2.0", api: 1 }));
  control = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === "/api/version") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ component: "control", version: "0.2.0", ...api }));
    if (req.url === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 400);
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(201, { "content-type": "application/json", "set-cookie": ["pa_session=a; HttpOnly", "pa_csrf=b"] }).end(JSON.stringify({ method: req.method, url: req.url, body })));
  });
  new WebSocketServer({ server: control }).on("connection", (ws) => ws.on("message", (m) => ws.send(`echo:${String(m)}`)));
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  ({ server: edge } = createEdge({ dist, control: `http://127.0.0.1:${(control.address() as AddressInfo).port}`, workspaceOrigin: "https://agent-workspace.example.com" }));
  await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
});

afterAll(() => {
  edge.closeAllConnections();
  edge.close();
  control.closeAllConnections();
  control.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

describe("UI edge", () => {
  it("serves the console with its CSP for every console route, and assets with the right caching", async () => {
    for (const route of ["/", "/u/owner", "/u/cr/tasks"]) {
      const res = await fetch(base + route);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>一站</title>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-src 'self' https://agent-workspace.example.com");
      expect(csp).toContain("frame-ancestors 'none'");
    }
    const asset = await fetch(`${base}/assets/app-abc123.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/sw.js`)).headers.get("cache-control")).toBe("no-cache");
    // Dot segments are resolved inside the build; an encoded slash cannot climb out of it.
    expect(await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain("<title>一站</title>");
    const escaped = await new Promise<number>((resolve) => http.get(`${base}/..%2f..%2f..%2fetc%2fpasswd`, (r) => (r.resume(), resolve(r.statusCode ?? 0))));
    expect(escaped).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });

  it("passes the API through untouched: host, origin, body, cookies and status", async () => {
    const res = await fetch(`${base}/api/tasks?x=1`, { method: "POST", body: "payload", headers: { origin: "https://agent.example.com", "x-csrf-token": "t", "cf-connecting-ip": "203.0.113.9" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ method: "POST", url: "/api/tasks?x=1", body: "payload" });
    expect(res.headers.getSetCookie()).toEqual(["pa_session=a; HttpOnly", "pa_csrf=b"]);
    const got = seen.at(-1)!;
    expect(got.host).toBe(new URL(base).host);
    expect(got.origin).toBe("https://agent.example.com");
    expect(got["x-csrf-token"]).toBe("t");
    expect(got["cf-connecting-ip"]).toBe("203.0.113.9");
    expect(got["x-forwarded-host"]).toBeUndefined();
  });

  it("streams server-sent events as they come", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/api/stream`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("data: first");
    expect(Date.now() - started).toBeLessThan(350);
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("data: second");
  });

  it("passes API WebSockets through", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/socket`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    ws.close();
    expect(reply).toBe("echo:hi");
  });

  it("is healthy only while the control plane serves the API this build needs", async () => {
    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, ui: { api: 1 }, control: { api: 1, apiMin: 1 } });
    // Asked under a loopback Host the control plane accepts, not the compose service name.
    expect(seen.some((h) => h.host === "localhost")).toBe(true);
    api = { api: 3, apiMin: 2 };
    const { server, compatible } = createEdge({ dist, control: `http://127.0.0.1:${(control.address() as AddressInfo).port}` });
    try {
      expect(await compatible()).toMatchObject({ ok: false, control: { api: 3, apiMin: 2 } });
    } finally {
      server.close();
      api = { api: 1, apiMin: 1 };
    }
  });
});
