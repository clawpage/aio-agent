import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { login, startHarness, type TestHarness } from "../helpers/harness.js";
import { PushService } from "../../src/control/push.js";

let h: TestHarness;
const send = vi.fn(async () => ({ statusCode: 201 }));
const apns = vi.fn(async (): Promise<{ statusCode: number; reason?: string }> => ({ statusCode: 200 }));
beforeAll(async () => {
  h = await startHarness();
  h.ctx.push = new PushService({ db: h.ctx.db, log: h.ctx.log, keyFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "push-")), "vapid.json"), subject: "https://agent.example.com", send, apns });
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
  // A console on screen elsewhere (no subscription named) leaves this device notified...
  await h.request("/api/presence", { method: "POST", headers, body: "{}" });
  expect(h.ctx.push!.foreground("owner_1", subscription.endpoint)).toBe(false);
  // ...while this device showing the console is spared, but the test notification still goes out.
  await h.request("/api/presence", { method: "POST", headers, body: JSON.stringify({ endpoint: subscription.endpoint }) });
  expect(h.ctx.push!.foreground("owner_1", subscription.endpoint)).toBe(true);
  expect(await (await h.request("/api/push/test", { method: "POST", headers, body: "{}" })).json()).toEqual({ sent: 1 });
  expect(send).toHaveBeenCalledTimes(1);
  await h.request("/api/push/unsubscribe", { method: "POST", headers, body: JSON.stringify({ endpoint: subscription.endpoint }) });
  expect(h.ctx.push!.count("owner_1")).toBe(0);
});

it("keeps the iOS app's device token, tells the app it is on, and forgets a token Apple refuses", async () => {
  const { cookie, csrf } = await login(h);
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const token = "0f".repeat(32);
  expect((await h.request("/api/push/subscribe", { method: "POST", headers, body: JSON.stringify({ apns: { token: "not-a-token", environment: "production" } }) })).status).toBe(400);
  expect((await h.request("/api/push/subscribe", { method: "POST", headers, body: JSON.stringify({ apns: { token, environment: "staging" } }) })).status).toBe(400);
  const added = await (await h.request("/api/push/subscribe", { method: "POST", headers, body: JSON.stringify({ apns: { token, environment: "production" } }) })).json() as { endpoint: string };
  expect(added).toEqual({ ok: true, devices: 1, endpoint: `apns:production:${token}` });
  expect(await (await h.request(`/api/push?endpoint=${encodeURIComponent(added.endpoint)}`, { headers: { cookie } })).json()).toMatchObject({ apns: true, subscribed: true });
  expect(await (await h.request("/api/push/test", { method: "POST", headers, body: "{}" })).json()).toEqual({ sent: 1 });
  expect(apns).toHaveBeenLastCalledWith({ environment: "production", token }, expect.objectContaining({ tag: "test", url: "/" }));
  // The app was removed from the phone: Apple says so, and the device is dropped.
  apns.mockResolvedValueOnce({ statusCode: 410, reason: "Unregistered" });
  expect(await (await h.request("/api/push/test", { method: "POST", headers, body: "{}" })).json()).toEqual({ sent: 0 });
  expect(await (await h.request(`/api/push?endpoint=${encodeURIComponent(added.endpoint)}`, { headers: { cookie } })).json()).toMatchObject({ subscribed: false, devices: 0 });
});
