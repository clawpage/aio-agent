import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { KbGateway, kbMcpServers, kbThreadServers } from "../../src/control/kb.js";
import { codexRequirementsToml } from "../../src/control/docker/seed.js";
import { memberConfig } from "../../src/control/tenants.js";

const USERS: Record<string, string> = { owner_1: "owner", user_granted: "cr", user_other: "yzmy" };

it("offers the knowledge base to the owner and the listed members only, keeping its token on the host", async () => {
  const h = await startHarness();
  const seen: Array<{ auth?: string; user?: string | string[]; body: any }> = [];
  let status = 200;
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    seen.push({ auth: req.headers.authorization, user: req.headers["x-aio-user"], body });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { echoed: body.method } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const keyFile = path.join(h.dataDir, "kb-mcp.env");
  fs.writeFileSync(keyFile, "KB_MCP_TOKEN=host-kb-secret\n", { mode: 0o600 });
  const saved = process.env.KB_MCP_TOKEN;
  delete process.env.KB_MCP_TOKEN;
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/mcp`;
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, kbMcp: { upstreamUrl, secretsFile: keyFile, members: ["cr"] } };
  const kb = new KbGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => USERS[id] ?? null });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, kb);
  await gateway.start();
  try {
    // As in production: the owner is provisioned on the very config every member config is derived from.
    const owner = Object.assign(cfg, { runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") });
    kb.provision(owner);
    const granted = memberConfig(cfg, "user_granted", 18091);
    gateway.provision(granted);
    const other = memberConfig(cfg, "user_other", 18092);
    gateway.provision(other);
    const unknown = memberConfig(cfg, "user_deleted", 18093);
    gateway.provision(unknown);

    expect(owner.kb!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/kb\/[a-f0-9]{64}\/mcp$/);
    expect(granted.kb!.url).not.toBe(owner.kb!.url);
    expect(other.kb).toBeUndefined();
    expect(unknown.kb).toBeUndefined();
    // Executors of a granted runtime get the server; nobody's config carries the upstream token.
    expect(kbThreadServers(granted)).toEqual({ aio_kb: { url: granted.kb!.url, tool_timeout_sec: expect.any(Number) } });
    expect(kbMcpServers(granted)).toEqual({ aio_kb: { type: "http", url: granted.kb!.url } });
    expect(kbThreadServers(other)).toEqual({});
    expect(kbMcpServers(other)).toEqual({});
    expect(JSON.stringify([owner, granted, other])).not.toContain("host-kb-secret");
    // Codex only enables an MCP server its managed policy names with this exact URL.
    expect(codexRequirementsToml(granted)).toContain(`[mcp_servers.aio_kb.identity]\nurl = "${granted.kb!.url}"\n`);
    expect(codexRequirementsToml(other)).not.toContain("aio_kb");
    expect(codexRequirementsToml(other)).toContain("[mcp_servers.aio_tabs.identity]");

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = (url: string, body: unknown, method = "POST") =>
      fetch(local(url), { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    const call = { jsonrpc: "2.0", id: 7, method: "tools/list" };
    expect((await rpc(granted.kb!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), call)).status).toBe(403);
    expect((await rpc(granted.kb!.url, call, "GET")).status).toBe(405);
    expect((await rpc(granted.kb!.url, call, "DELETE")).status).toBe(200);
    expect(seen).toHaveLength(0);

    const res = await rpc(granted.kb!.url, call);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { echoed: "tools/list" } });
    await rpc(owner.kb!.url, call);
    expect(seen.map((s) => [s.auth, s.user])).toEqual([["Bearer host-kb-secret", "cr"], ["Bearer host-kb-secret", "owner"]]);
    expect(seen[0]!.body).toEqual(call);

    // A token the upstream rejects, or an upstream that is down, is this side's fault: 502, never 401.
    status = 401;
    expect((await rpc(granted.kb!.url, call)).status).toBe(502);
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    expect((await rpc(granted.kb!.url, call)).status).toBe(502);
  } finally {
    if (saved !== undefined) process.env.KB_MCP_TOKEN = saved;
    gateway.close();
    upstream.closeAllConnections();
    upstream.close();
    await h.shutdown();
  }
});

it("offers no knowledge base without an upstream URL or without its token", async () => {
  const h = await startHarness();
  const saved = process.env.KB_MCP_TOKEN;
  delete process.env.KB_MCP_TOKEN;
  try {
    const keyFile = path.join(h.dataDir, "kb-mcp.env");
    fs.writeFileSync(keyFile, "KB_MCP_TOKEN=host-kb-secret\n", { mode: 0o600 });
    const cases = [
      { upstreamUrl: "", secretsFile: keyFile, members: [] },
      { upstreamUrl: "http://127.0.0.1:9/mcp", secretsFile: path.join(h.dataDir, "missing.env"), members: [] },
    ];
    for (const kbMcp of cases) {
      const cfg = { ...h.ctx.cfg, kbMcp };
      const kb = new KbGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => USERS[id] ?? null });
      const runtime = { ...cfg, runtimeUserId: "owner_1" };
      kb.provision(runtime);
      expect(kb.enabled).toBe(false);
      expect(runtime.kb).toBeUndefined();
      expect(kbThreadServers(runtime)).toEqual({});
    }
    expect(h.ctx.cfg.kbMcp.upstreamUrl).toBe("");
  } finally {
    if (saved !== undefined) process.env.KB_MCP_TOKEN = saved;
    await h.shutdown();
  }
});
