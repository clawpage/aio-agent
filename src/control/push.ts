import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import type { AppContext } from "./context.js";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";

/**
 * Notifications on the person's phone through the standard Web Push protocol:
 * the console, added to the iOS home screen (16.4+), subscribes with Apple's
 * push service; Android and desktop browsers use theirs. Payloads are
 * encrypted end to end (the push service cannot read them) and signed with
 * this deployment's VAPID key, which is generated once and kept in `var/`.
 */

/** The server only ever posts to these push services, so a subscription cannot point it anywhere else. */
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
/** A console seen this recently is on screen: it shows the change itself. */
const FOREGROUND_MS = 45_000;

export interface PushPayload {
  title: string;
  body: string;
  /** Same tag, same notification: a task's later news replaces its earlier one. */
  tag?: string;
  url?: string;
}

export interface PushSubscriptionInput {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

type Sender = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;

export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2000) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

/** The deployment's VAPID key pair, created on first use (mode 600). */
export function loadVapidKeys(file: string): { publicKey: string; privateKey: string } {
  try {
    const keys = JSON.parse(fs.readFileSync(file, "utf8")) as { publicKey?: string; privateKey?: string };
    if (keys.publicKey && keys.privateKey) return { publicKey: keys.publicKey, privateKey: keys.privateKey };
  } catch { /* first start */ }
  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export class PushService {
  readonly publicKey: string;
  #privateKey: string;
  #subject: string;
  #db: Db;
  #log: Logger;
  #send: Sender;
  #seen = new Map<string, number>();

  constructor(opts: { db: Db; log: Logger; keyFile: string; subject: string; send?: Sender }) {
    const keys = loadVapidKeys(opts.keyFile);
    this.publicKey = keys.publicKey;
    this.#privateKey = keys.privateKey;
    this.#subject = opts.subject;
    this.#db = opts.db;
    this.#log = opts.log.child("push");
    this.#send = opts.send ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
  }

  /** Store (or move to this account) a browser's subscription. */
  subscribe(ownerId: string, input: PushSubscriptionInput, userAgent = ""): void {
    const p256dh = input.keys?.p256dh, auth = input.keys?.auth;
    if (!validEndpoint(input.endpoint)) throw new Error("不支持的推送地址");
    if (typeof p256dh !== "string" || typeof auth !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) throw new Error("推送订阅不完整");
    this.#db.prepare(`INSERT INTO push_subscriptions (endpoint,owner_id,p256dh,auth,user_agent,created_at,failures) VALUES (?,?,?,?,?,?,0)
      ON CONFLICT(endpoint) DO UPDATE SET owner_id=excluded.owner_id,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent,failures=0`)
      .run(input.endpoint, ownerId, p256dh, auth, userAgent.slice(0, 300), Date.now());
  }

  unsubscribe(ownerId: string, endpoint: string): void {
    this.#db.prepare("DELETE FROM push_subscriptions WHERE owner_id=? AND endpoint=?").run(ownerId, endpoint);
  }

  count(ownerId: string): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE owner_id=?").get(ownerId) as { n: number }).n;
  }

  /**
   * The console is on screen on one device (its presence heartbeat). Only that device,
   * named by its own push subscription, is spared notifications meanwhile: a console
   * left open on a computer must not silence the phone.
   */
  presence(ownerId: string, endpoint: unknown, now = Date.now()): void {
    if (typeof endpoint === "string" && validEndpoint(endpoint)) this.#seen.set(`${ownerId}\n${endpoint}`, now);
  }

  /** Whether this device shows the console right now. */
  foreground(ownerId: string, endpoint: string, now = Date.now()): boolean {
    return now - (this.#seen.get(`${ownerId}\n${endpoint}`) ?? 0) < FOREGROUND_MS;
  }

  /** Send to every device of the account except one showing the console now (unless forced). Returns how many accepted it. */
  async notify(ownerId: string, payload: PushPayload, opts: { force?: boolean } = {}): Promise<number> {
    const rows = this.#db.prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE owner_id=?").all(ownerId) as Array<{ endpoint: string; p256dh: string; auth: string }>;
    let sent = 0, onScreen = 0, failed = 0;
    await Promise.all(rows.map(async (row) => {
      if (!validEndpoint(row.endpoint)) return;
      if (!opts.force && this.foreground(ownerId, row.endpoint)) { onScreen += 1; return; }
      try {
        await this.#send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify({ url: "/", ...payload }), {
          TTL: 24 * 3600, urgency: "normal", vapidDetails: { subject: this.#subject, publicKey: this.publicKey, privateKey: this.#privateKey },
        });
        sent += 1;
        this.#db.prepare("UPDATE push_subscriptions SET last_ok_at=?,failures=0 WHERE endpoint=?").run(Date.now(), row.endpoint);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: the browser dropped this subscription for good.
        if (status === 404 || status === 410) this.#db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(row.endpoint);
        else this.#db.prepare("UPDATE push_subscriptions SET failures=failures+1 WHERE endpoint=?").run(row.endpoint);
        failed += 1;
        this.#log.warn("push not delivered", { status: status ?? null, host: new URL(row.endpoint).hostname });
      }
    }));
    // Every decision is visible afterwards: what was sent, and to how many devices, or why not.
    this.#log.info("push", { owner: ownerId, tag: payload.tag ?? null, devices: rows.length, sent, onScreen, failed, ...(opts.force ? { forced: true } : {}) });
    return sent;
  }
}

/** A reply as one short line for a lock screen: no Markdown, code or map blocks. */
export function notificationText(text: string | null | undefined, max = 140): string {
  const plain = (text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...plain];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : plain;
}

type TaskView = { id: string; title: string; status: string; result: string | null; error: string | null; clarification: string | null; schedule?: { builtin?: string } | null };

/** What a task's news looks like on the phone, or null for news that is not worth a notification. */
export function taskNotification(task: TaskView): PushPayload | null {
  // The daily feed reads as what it is; its first line ("今日为你留意") is the title already.
  if (task.schedule?.builtin === "daily_feed") {
    if (task.status !== "completed") return null;
    const body = notificationText((task.result ?? "").replace(/^\s*今日为你留意[：:]?\s*/, ""));
    return body ? { title: "今日为你留意", body, tag: "daily-feed" } : null;
  }
  if (task.status === "completed") return { title: `已完成：${task.title}`, body: notificationText(task.result) || "任务已完成，打开一站查看。", tag: task.id };
  if (task.status === "failed") return { title: `没有完成：${task.title}`, body: notificationText(task.error) || "执行失败，打开一站查看。", tag: task.id };
  if (task.status === "unknown") return { title: `结果待核对：${task.title}`, body: "连接中断，结果需要你核对。", tag: task.id };
  if (task.status === "needs_input") return { title: `需要你补充：${task.title}`, body: notificationText(task.clarification) || "打开一站补充信息。", tag: task.id };
  return null;
}

/**
 * Tell the account's phones about its tasks: finished or failed, waiting for an
 * answer, an action to approve, or a browser step only the person can do. The
 * browser hand-over lives in the sandbox's tab server, so it is checked while
 * tasks run (the sandbox is awake then anyway).
 */
/** How long the vault gets to answer a sign-in before the person is told about it. */
const VAULT_GRACE_MS = 10_000;

export function startTaskNotifications(ctx: AppContext, push: PushService, intervalMs = 20_000): { stop(): void } {
  const ownerId = ctx.cfg.runtimeUserId ?? "owner_1";
  const send = (payload: PushPayload | null) => {
    if (payload) void push.notify(ownerId, payload).catch(() => undefined);
  };
  ctx.tasks.setNotifier((task) => send(taskNotification(task)));
  const onEvent = (event: { type: string; conversationId: string }) => {
    if (event.type !== "approval.requested") return;
    const task = ctx.tasks.taskForConversation(event.conversationId);
    if (task) send({ title: `需要你确认：${task.title}`, body: "有一个操作等你确认，打开一站查看。", tag: `${task.id}:approval` });
  };
  ctx.agent.events.on("event", onEvent);
  const asked = new Set<string>();
  let polling = false;
  const timer = setInterval(() => {
    if (polling || !ctx.tabs || !ctx.tasks.hasRunning()) return;
    polling = true;
    void ctx.tabs.list().then((tabs) => {
      for (const tab of tabs) {
        if (!tab.request || tab.holder !== "ai") continue;
        // The vault answers a sign-in it has an account for within seconds: only one still waiting is the person's.
        if (tab.request.kind === "login" && Date.now() - tab.request.at < VAULT_GRACE_MS) continue;
        const key = `${tab.id}:${tab.request.at}`;
        if (asked.has(key)) continue;
        asked.add(key);
        const task = ctx.tasks.taskForConversation(tab.key);
        send({ title: `需要你操作浏览器：${task?.title ?? tab.title}`, body: notificationText(tab.request.reason, 120) || "打开一站接管浏览器。", tag: `${task?.id ?? tab.id}:browser` });
      }
    }).catch(() => undefined).finally(() => { polling = false; });
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      ctx.agent.events.off("event", onEvent);
      ctx.tasks.setNotifier(null);
    },
  };
}
