import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { KbGateway, kbMcpServers, kbThreadServers } from "../../src/control/kb.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
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

it("saves a cited original into the asking account's workspace with kb_file, never passing it through the model", async () => {
  const h = await startHarness();
  const seen: Array<{ url: string; auth?: string; user?: string | string[] }> = [];
  const original = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]); // a HEIC's first bytes
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    seen.push({ url: req.url!, auth: req.headers.authorization, user: req.headers["x-aio-user"] });
    if (req.url!.startsWith("/file?")) {
      const q = new URL(req.url!, "http://kb").searchParams;
      if (q.get("id") !== "t0/roy-birth" || q.get("n") !== "2") return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "t0/roy-birth 没有第 9 条来源" }));
      return res.writeHead(200, { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("IMG_0947.HEIC"), "x-source": encodeURIComponent("source/raw/家庭/IMG_0947.HEIC") }).end(original);
    }
    const body = JSON.parse(data);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [{ name: "kb_source" }] } : { echoed: body.params?.name } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const keyFile = path.join(h.dataDir, "kb-mcp.env");
  fs.writeFileSync(keyFile, "KB_MCP_TOKEN=host-kb-secret\n", { mode: 0o600 });
  const saved = process.env.KB_MCP_TOKEN;
  delete process.env.KB_MCP_TOKEN;
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, kbMcp: { upstreamUrl: `http://127.0.0.1:${(upstream.address() as any).port}/mcp`, secretsFile: keyFile, members: ["cr"] } };
  const written = new Map<string, Map<string, Buffer>>();
  const files = async (username: string) => {
    const mine = written.get(username) ?? new Map<string, Buffer>();
    written.set(username, mine);
    return { write: async (file: string, bytes: Buffer) => { mine.set(file, bytes); } };
  };
  const kb = new KbGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => USERS[id] ?? null, files });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, kb);
  await gateway.start();
  try {
    Object.assign(cfg, { runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") });
    kb.provision(cfg);
    const granted = memberConfig(cfg, "user_granted", 18091);
    gateway.provision(granted);
    const url = granted.kb!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = async (body: unknown) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as any;
    const fileCall = (args: Record<string, unknown>) => rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kb_file", arguments: args } });

    // The upstream's tools, plus kb_file; other calls still go upstream as they are.
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t: { name: string }) => t.name)).toEqual(["kb_source", "kb_file"]);
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kb_source", arguments: {} } })).result).toEqual({ echoed: "kb_source" });

    // The original lands in the account's own workspace under its own name; the reply carries only the path.
    const got = await fileCall({ id: "t0/roy-birth", n: 2 });
    expect(got.result.isError).toBeUndefined();
    expect(got.result.content[0].text).toContain("Original saved: /home/gem/workspace/kb-files/IMG_0947.HEIC (12 bytes, from source/raw/家庭/IMG_0947.HEIC)");
    expect(written.get("cr")!.get("/home/gem/workspace/kb-files/IMG_0947.HEIC")).toEqual(original);
    expect(written.has("owner")).toBe(false);
    expect(seen.find((s) => s.url.startsWith("/file?"))).toMatchObject({ url: "/file?id=t0%2Froy-birth&n=2", auth: "Bearer host-kb-secret", user: "cr" });
    // A named path inside the task's folder; never outside the workspace; a missing source is said plainly.
    expect((await fileCall({ id: "t0/roy-birth", n: 2, path: "/home/gem/workspace/tasks/t1/birth.heic" })).result.isError).toBeUndefined();
    expect(written.get("cr")!.has("/home/gem/workspace/tasks/t1/birth.heic")).toBe(true);
    expect((await fileCall({ id: "t0/roy-birth", n: 2, path: "/etc/passwd" })).result.isError).toBe(true);
    const missing = await fileCall({ id: "t0/roy-birth", n: 9 });
    expect(missing.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("没有第 9 条来源") }] });
    expect((await fileCall({ id: "t0/roy-birth" })).result.isError).toBe(true);
  } finally {
    gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    if (saved === undefined) delete process.env.KB_MCP_TOKEN; else process.env.KB_MCP_TOKEN = saved;
    await h.shutdown();
  }
});
