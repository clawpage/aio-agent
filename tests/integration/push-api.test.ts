import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { PushService } from "../../src/control/push.js";

let h: TestHarness;
const send = vi.fn(async () => ({ statusCode: 201 }));
beforeAll(async () => {
  h = await startHarness();
  h.ctx.push = new PushService({ db: h.ctx.db, log: h.ctx.log, keyFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "push-")), "vapid.json"), subject: "https://agent.example.com", send });
});
afterAll(async () => { await h.shutdown(); });

it("subscribes this account's device, sends a test, marks presence and unsubscribes", async () => {
  expect((await h.request("/api/push")).status).toBe(401);
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const info = (await (await h.request("/api/push", { headers: { cookie } })).json()) as { supported: boolean; publicKey: string; devices: number };
  expect(info).toMatchObject({ supported: true, publicKey: h.ctx.push!.publicKey, devices: 0 });
  const subscription = { endpoint: "https://web.push.apple.com/QGuQyavXutnMH6Ey", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
  expect((await h.request("/api/push/subscribe", { method: "POST", headers: { cookie }, body: JSON.stringify({ subscription }) })).status).toBe(403);
  expect((await h.request("/api/push/subscribe", { method: "POST", headers, body: JSON.stringify({ subscription: { ...subscription, endpoint: "http://169.254.169.254/latest" } }) })).status).toBe(400);
  expect(await (await h.request("/api/push/subscribe", { method: "POST", headers, body: JSON.stringify({ subscription }) })).json()).toEqual({ ok: true, devices: 1 });
  // The test notification goes out even while the console is on screen.
  await h.request("/api/presence", { method: "POST", headers, body: "{}" });
  expect(h.ctx.push!.foreground("owner_1")).toBe(true);
  expect(await (await h.request("/api/push/test", { method: "POST", headers, body: "{}" })).json()).toEqual({ sent: 1 });
  expect(send).toHaveBeenCalledTimes(1);
  await h.request("/api/push/unsubscribe", { method: "POST", headers, body: JSON.stringify({ endpoint: subscription.endpoint }) });
  expect(h.ctx.push!.count("owner_1")).toBe(0);
});
