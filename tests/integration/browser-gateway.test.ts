import { it, expect } from "vitest";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { BrowserGateway } from "../../src/control/browser/gateway.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { memberConfig } from "../../src/control/tenants.js";

it("recovers only the authenticated account and reports recovery failure without leaking details", async () => {
  const h = await startHarness();
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const asked: string[] = [];
  let fail = false;
  const browser = new BrowserGateway({ port: 0, log: h.ctx.log, readyFor: async id => {
    asked.push(id);
    if (fail) throw new Error("private URL and credentials");
  } });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, browser);
  await gateway.start();
  try {
    const owner = { ...cfg, browser: { ...cfg.browser }, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner") };
    browser.provision(owner);
    const member = memberConfig(owner, "user_m", 18092);
    expect(member.browser.readyGateway).toBeUndefined();
    gateway.provision(member);
    expect(member.browser.readyGateway!.token).not.toBe(owner.browser.readyGateway!.token);
    const url = `http://127.0.0.1:${gateway.port}/browser/ready`;
    const call = (token?: string, method = "POST", suffix = "") => fetch(url + suffix, { method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(method === "POST" ? { body: JSON.stringify({ userId: "owner_1" }) } : {}) });
    expect((await call()).status).toBe(403);
    expect((await call("f".repeat(64))).status).toBe(403);
    expect(asked).toEqual([]);
    expect((await call(member.browser.readyGateway!.token, "GET")).status).toBe(405);
    expect((await call(member.browser.readyGateway!.token, "POST", "/extra")).status).toBe(404);
    expect((await call(member.browser.readyGateway!.token)).status).toBe(200);
    expect(asked).toEqual(["user_m"]); // The body cannot select the owner's runtime.
    expect((await call(owner.browser.readyGateway!.token)).status).toBe(200);
    expect(asked).toEqual(["user_m", "owner_1"]);
    fail = true;
    const failed = await call(member.browser.readyGateway!.token);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private");
    fail = false;
    expect((await call(member.browser.readyGateway!.token)).status).toBe(200);
  } finally { gateway.close(); await h.shutdown(); }
});
