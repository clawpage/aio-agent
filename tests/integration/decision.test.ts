import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { DecisionGateway, decisionMcpServers, decisionThreadServers } from "../../src/control/decision.js";
import { Jev } from "../../src/control/jev.js";
import { memberConfig } from "../../src/control/tenants.js";

it("offers every account Jev's decision through its own MCP URL, keeping the key on the host and recording each call", async () => {
  const h = await startHarness();
  const seen: Array<{ auth?: string; body: any }> = [];
  let reply: (body: any) => unknown = (body) => {
    const ids = Object.keys(body.questions.decision.criteria);
    const probabilities = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.8 : 0.2 / (ids.length - 1)]));
    return { answers: { decision: { choice: ids[0], confidence: 0.8, probabilities } }, usage: { tokens: 12 } };
  };
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    seen.push({ auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply(body)));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const keyFile = path.join(h.dataDir, "jev.env");
  fs.writeFileSync(keyFile, "TYPESAFE_API_KEY=owner-jev-secret\n", { mode: 0o600 });
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, jev: { ...h.ctx.cfg.jev, secretsFile: keyFile, endpoint: `http://127.0.0.1:${(upstream.address() as any).port}/v1/systemone` } };
  const jev = new Jev(cfg, h.ctx.log);
  const decision = new DecisionGateway({ cfg, db: h.ctx.db, jev, log: h.ctx.log, port: 0 });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, decision);
  await gateway.start();
  try {
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    decision.provision(owner);
    const member = memberConfig(cfg, "user_m", 18091);
    gateway.provision(member);
    expect(owner.decision!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/decision\/[a-f0-9]{64}\/mcp$/);
    expect(member.decision!.url).not.toBe(owner.decision!.url);
    // Executors get the server; the URL carries no Jev key.
    expect(decisionThreadServers(member)).toEqual({ aio_decision: { url: member.decision!.url, tool_timeout_sec: expect.any(Number) } });
    expect(decisionMcpServers(member)).toEqual({ aio_decision: { type: "http", url: member.decision!.url } });
    expect(JSON.stringify(member)).not.toContain("owner-jev-secret");

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = (url: string, body: unknown) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await rpc(member.decision!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(member.decision!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect((await init.json()).result.serverInfo.name).toBe("aio_decision");
    expect((await rpc(member.decision!.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const tools = await (await rpc(member.decision!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(["decide"]);

    const call = async (args: unknown) => (await (await rpc(member.decision!.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decide", arguments: args } })).json()).result;
    const ok = await call({ question: "哪个航班最符合要求", options: { ua857: "UA857 直飞 13h", nh7: "NH7 转机 16h" }, context: "带一岁宝宝，优先直飞", rules: ["直飞优先"] });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0].text)).toMatchObject({ choice: "ua857", confident: true, confidence: 0.8 });
    expect(seen[0]!.auth).toBe("Bearer owner-jev-secret");
    expect(seen[0]!.body).toMatchObject({ model: "jev-latest", state: { context: "带一岁宝宝，优先直飞" }, questions: { decision: { type: "choice", criteria: { ua857: "UA857 直飞 13h" }, instructions: { goal: "哪个航班最符合要求", rules: ["直飞优先"] } } } });

    // Bad arguments never reach Jev; a malformed answer is an error, not a guess.
    expect((await call({ question: "x", options: { only: "one" } })).isError).toBe(true);
    expect((await call({ question: "x", options: { "bad id": "a", b: "b" } })).isError).toBe(true);
    expect(seen).toHaveLength(1);
    reply = () => ({ answers: { decision: { choice: "zzz", confidence: 2, probabilities: {} } } });
    const broken = await call({ question: "哪个", options: { a: "A", b: "B" } });
    expect(broken.isError).toBe(true);

    const rows = h.ctx.db.prepare("SELECT owner_id,ok,choice,options FROM decision_events ORDER BY id").all();
    expect(rows).toEqual([{ owner_id: "user_m", ok: 1, choice: "ua857", options: 2 }, { owner_id: "user_m", ok: 0, choice: null, options: 2 }]);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await h.shutdown();
  }
});

it("offers no decision tool while Jev has no key", async () => {
  const h = await startHarness();
  try {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const cfg = { ...h.ctx.cfg, jev: { ...h.ctx.cfg.jev, secretsFile: path.join(h.dataDir, "missing.env") } };
    const decision = new DecisionGateway({ cfg, db: h.ctx.db, jev: new Jev(cfg, h.ctx.log), log: h.ctx.log, port: 0 });
    const runtime = { ...cfg, runtimeUserId: "owner_1" };
    decision.provision(runtime);
    expect(runtime.decision).toBeUndefined();
    expect(decisionThreadServers(runtime)).toEqual({});
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  } finally {
    await h.shutdown();
  }
});
