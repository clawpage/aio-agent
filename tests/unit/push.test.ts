import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/server/db.js";
import { Logger } from "../../src/server/logger.js";
import { loadVapidKeys, notificationText, PushService, startTaskNotifications, taskNotification, validEndpoint } from "../../src/server/push.js";
import type { AppContext } from "../../src/server/context.js";

const log = new Logger("error", undefined, false);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
const apple = "https://web.push.apple.com/QGuQyavXutnMH6Ey_example";
const sub = (endpoint = apple) => ({ endpoint, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

function service(send = vi.fn(async () => ({ statusCode: 201 }))) {
  const db = openDb(":memory:");
  const push = new PushService({ db, log, keyFile: path.join(tmp(), "vapid.json"), subject: "https://agent.example.com", send });
  return { db, push, send };
}

describe("phone notifications", () => {
  it("posts only to the known push services", () => {
    expect(validEndpoint(apple)).toBe(true);
    expect(validEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(validEndpoint("https://wns2-by3p.notify.windows.com/w/?token=x")).toBe(true);
    expect(validEndpoint("http://web.push.apple.com/x")).toBe(false);
    expect(validEndpoint("https://web.push.apple.com:8443/x")).toBe(false);
    expect(validEndpoint("https://evil.example.com/web.push.apple.com")).toBe(false);
    expect(validEndpoint("https://127.0.0.1/x")).toBe(false);
  });

  it("keeps one private VAPID key pair across restarts", () => {
    const file = path.join(tmp(), "vapid.json");
    const first = loadVapidKeys(file);
    expect(loadVapidKeys(file)).toEqual(first);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("stores a subscription per account, refuses bad ones, and moves a device that switches accounts", () => {
    const { push } = service();
    push.subscribe("owner_1", sub());
    expect(push.count("owner_1")).toBe(1);
    expect(() => push.subscribe("owner_1", sub("https://evil.example.com/x"))).toThrow("不支持的推送地址");
    expect(() => push.subscribe("owner_1", { endpoint: apple, keys: { p256dh: "short", auth: "x" } })).toThrow("推送订阅不完整");
    push.subscribe("member_1", sub());
    expect([push.count("owner_1"), push.count("member_1")]).toEqual([0, 1]);
    push.unsubscribe("member_1", apple);
    expect(push.count("member_1")).toBe(0);
  });

  it("sends signed, to every device, but not while the console is on screen unless forced", async () => {
    const { push, send } = service();
    push.subscribe("owner_1", sub());
    push.subscribe("owner_1", sub("https://fcm.googleapis.com/fcm/send/other"));
    expect(await push.notify("owner_1", { title: "已完成：查天气", body: "晴", tag: "t1" })).toBe(2);
    const [subscription, payload, options] = send.mock.calls[0] as unknown as [{ endpoint: string }, string, { vapidDetails: { subject: string; publicKey: string } ; TTL: number }];
    expect(JSON.parse(payload)).toEqual({ url: "/", title: "已完成：查天气", body: "晴", tag: "t1" });
    expect(options.vapidDetails).toMatchObject({ subject: "https://agent.example.com", publicKey: push.publicKey });
    expect(options.TTL).toBe(86400);
    expect(subscription.endpoint).toBeTruthy();
    push.presence("owner_1");
    expect(await push.notify("owner_1", { title: "x", body: "y" })).toBe(0);
    expect(await push.notify("owner_1", { title: "x", body: "y" }, { force: true })).toBe(2);
    expect(push.foreground("owner_1", Date.now() + 60_000)).toBe(false);
  });

  it("drops a subscription the push service says is gone", async () => {
    const { push } = service(vi.fn(async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); }));
    push.subscribe("owner_1", sub());
    expect(await push.notify("owner_1", { title: "x", body: "y" })).toBe(0);
    expect(push.count("owner_1")).toBe(0);
  });

  it("turns task news into a short lock-screen line", () => {
    const base = { id: "t1", title: "查 Mac Studio 价格", result: null, error: null, clarification: null };
    expect(taskNotification({ ...base, status: "completed", result: "**降价了**：[Apple 官网](https://apple.com) 现价 $1,799。\n```map\n{}\n```" }))
      .toEqual({ title: "已完成：查 Mac Studio 价格", body: "降价了：Apple 官网 现价 $1,799。", tag: "t1" });
    expect(taskNotification({ ...base, status: "needs_input", clarification: "要哪个配置？" })!.title).toBe("需要你补充：查 Mac Studio 价格");
    expect(taskNotification({ ...base, status: "failed", error: "网站打不开" })!.body).toBe("网站打不开");
    expect(taskNotification({ ...base, status: "running" })).toBeNull();
    expect(notificationText("x".repeat(300), 10)).toBe("xxxxxxxxx…");
  });
});

describe("what triggers a notification", () => {
  it("task news, approvals and a browser hand-over, each once", async () => {
    vi.useFakeTimers();
    try {
      let notifier: ((t: unknown) => void) | null = null;
      const tabs = [{ id: "t3", key: "conv-1", title: "Target", holder: "ai", request: { reason: "请完成人机验证", at: 1 } }];
      const ctx = {
        cfg: { runtimeUserId: "owner_1" },
        agent: { events: new EventEmitter() },
        tasks: { setNotifier: (n: typeof notifier) => { notifier = n; }, taskForConversation: () => ({ id: "task-1", title: "比价" }), hasRunning: () => true },
        tabs: { list: async () => tabs },
      } as unknown as AppContext;
      const sent: Array<{ title: string; tag?: string }> = [];
      const push = { notify: async (_: string, p: { title: string; tag?: string }) => { sent.push(p); return 1; } } as unknown as PushService;
      const handle = startTaskNotifications(ctx, push, 1000);
      notifier!({ id: "task-1", title: "比价", status: "completed", result: "Target 便宜 $3", error: null, clarification: null });
      ctx.agent.events.emit("event", { type: "approval.requested", conversationId: "conv-1" });
      ctx.agent.events.emit("event", { type: "turn.started", conversationId: "conv-1" });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent.map((p) => p.title)).toEqual(["已完成：比价", "需要你确认：比价", "需要你操作浏览器：比价"]);
      expect(sent.map((p) => p.tag)).toEqual(["task-1", "task-1:approval", "task-1:browser"]);
      handle.stop();
      expect(notifier).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
