import { it, expect } from "vitest";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { Analytics } from "../../src/control/analytics.js";
import { OPS_POLICY, OpsGateway, opsMcpServers, opsThreadServers } from "../../src/control/opsTool.js";
import { memberConfig } from "../../src/control/tenants.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";

it("gives the owner's executors the deployment's figures as counts, and no member a way in", async () => {
  const h = await startHarness();
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const analytics = h.ctx.analytics ?? new Analytics(h.ctx.db);
  const ops = new OpsGateway({ cfg, db: h.ctx.db, analytics, log: h.ctx.log, port: 0 });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ops);
  await gateway.start();
  try {
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    ops.provision(owner);
    expect(owner.ops!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/ops\/[a-f0-9]{64}\/mcp$/);
    expect(opsThreadServers(owner)).toEqual({ aio_ops: { url: owner.ops!.url, tool_timeout_sec: 60 } });
    expect(opsMcpServers(owner)).toEqual({ aio_ops: { type: "http", url: owner.ops!.url } });
    expect(codexRequirementsToml(owner)).toContain(`[mcp_servers.aio_ops.identity]\nurl = "${owner.ops!.url}"\n`);

    // A member's configuration neither inherits the owner's URL nor is given one of its own.
    const member = memberConfig(owner, "user_m", 18093);
    expect(member.ops).toBeUndefined();
    gateway.provision(member);
    ops.provision(member);
    expect(member.ops).toBeUndefined();
    expect(opsThreadServers(member)).toEqual({});
    expect(opsMcpServers(member)).toEqual({});
    expect(codexRequirementsToml(member)).not.toContain("aio_ops");

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = (url: string, body: unknown) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await rpc(owner.ops!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(owner.ops!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "aio_ops" }, instructions: OPS_POLICY });
    expect((await rpc(owner.ops!.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const tools = (await (await rpc(owner.ops!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["ops_report"]);

    // Two accounts beside the owner; one arrived by a campaign link and its browser would not come back once.
    const now = Date.now();
    const account = (id: string, name: string) => h.ctx.db.prepare("INSERT INTO owners (id,username,role,password_hash,password_salt,password_params,created_at) VALUES (?,?,'member','h','s','{}',?)").run(id, name, now - 60_000);
    account("user_secret1", "alice-private-name");
    account("user_secret2", "bob-private-name");
    const site = { source: "clawpage.ai", medium: "website", campaign: "use_cases" };
    analytics.track("auth_view", { props: { mode: "register", ...site } }, now - 120_000);
    analytics.track("attribution", { userId: "user_secret1", props: site }, now - 30_000);
    analytics.track("app_open", { userId: "user_secret1", platform: "web", props: { ui: "1.0.0" } }, now - 20_000);
    analytics.track("browser_restore_failed", { userId: "user_secret1", props: { reason: "deadline" } }, now - 10_000);
    h.ctx.db.prepare("INSERT INTO invites (code,note,created_at) VALUES ('invite-code-private','for carol',?)").run(now);

    const call = async (args: unknown) => (await (await rpc(owner.ops!.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ops_report", arguments: args } })).json()).result as { isError?: boolean; content: Array<{ text: string }> };
    const answer = await call({});
    expect(answer.isError).toBeUndefined();
    const report = JSON.parse(answer.content[0]!.text);
    expect(report.days).toBe(7);
    expect(report.totals.accounts).toBeGreaterThanOrEqual(3);
    expect(report.totals.activeToday).toBe(1);
    expect(report.acquisition).toContainEqual({ ...site, content: null, registerViews: 1, signups: 1, firstTask: 0, firstCompleted: 0 });
    expect(report.quality).toMatchObject({ restoreFailures: 1, restoreReasons: { deadline: 1 } });
    expect(report.registration).toEqual({ accounts: report.totals.accounts, openLimit: 30, inviteRequired: false, unusedInvites: 1 });
    // Counts only: nothing that names an account, and no invite code.
    for (const key of ["accounts", "activeTodayAccounts", "boot", "welcomeCards"]) expect(report).not.toHaveProperty(key);
    expect(report.quality).not.toHaveProperty("restoreAccounts");
    expect(answer.content[0]!.text).not.toMatch(/private|user_secret|carol/);

    expect(JSON.parse((await call({ days: 30 })).content[0]!.text).days).toBe(30);
    const bad = await call({ days: 5 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("7, 30 or 90");
    const unknown = await (await rpc(owner.ops!.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "accounts_list", arguments: {} } })).json();
    expect(unknown.error.code).toBe(-32602);
  } finally {
    gateway.close();
    await h.shutdown();
  }
});
