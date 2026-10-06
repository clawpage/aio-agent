import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { HaGateway, haMcpServers, haThreadServers } from "../../src/control/ha.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { memberConfig } from "../../src/control/tenants.js";

const USERS: Record<string, string> = { owner_1: "owner", user_gadget: "betaw", user_other: "cr" };

it("offers Home Assistant to the listed accounts only, the owner included only if listed, keeping its token on the host", async () => {
  const h = await startHarness();
  const seen: Array<{ auth?: string; body: any }> = [];
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    seen.push({ auth: req.headers.authorization, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "HassTurnOn" }] } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const keyFile = path.join(h.dataDir, "ha-mcp.env");
  fs.writeFileSync(keyFile, "HA_MCP_TOKEN=host-ha-secret\n", { mode: 0o600 });
  const saved = process.env.HA_MCP_TOKEN;
  delete process.env.HA_MCP_TOKEN;
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/api/mcp`;
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, haMcp: { upstreamUrl, secretsFile: keyFile, accounts: ["betaw"] } };
  const ha = new HaGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => USERS[id] ?? null });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ha);
  await gateway.start();
  try {
    const owner = Object.assign(cfg, { runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") });
    ha.provision(owner);
    const gadget = memberConfig(cfg, "user_gadget", 18091);
    gateway.provision(gadget);
    const other = memberConfig(cfg, "user_other", 18092);
    gateway.provision(other);

    expect(owner.ha).toBeUndefined();
    expect(other.ha).toBeUndefined();
    expect(gadget.ha!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/ha\/[a-f0-9]{64}\/mcp$/);
    expect(haThreadServers(gadget)).toEqual({ aio_ha: { url: gadget.ha!.url, tool_timeout_sec: expect.any(Number) } });
    expect(haMcpServers(gadget)).toEqual({ aio_ha: { type: "http", url: gadget.ha!.url } });
    expect(haThreadServers(other)).toEqual({});
    expect(JSON.stringify([owner, gadget, other])).not.toContain("host-ha-secret");
    expect(codexRequirementsToml(gadget)).toContain(`[mcp_servers.aio_ha.identity]\nurl = "${gadget.ha!.url}"\n`);
    expect(codexRequirementsToml(other)).not.toContain("aio_ha");

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const call = { jsonrpc: "2.0", id: 3, method: "tools/list" };
    const rpc = (url: string) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) });
    expect((await rpc(gadget.ha!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)))).status).toBe(403);
    // The knowledge base's path never reaches Home Assistant, nor the other way round.
    expect((await rpc(gadget.ha!.url.replace("/ha/", "/kb/"))).status).toBe(403);
    const res = await rpc(gadget.ha!.url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "HassTurnOn" }] } });
    expect(seen).toEqual([{ auth: "Bearer host-ha-secret", body: call }]);
  } finally {
    if (saved !== undefined) process.env.HA_MCP_TOKEN = saved;
    gateway.close();
    upstream.closeAllConnections();
    upstream.close();
    await h.shutdown();
  }
});
