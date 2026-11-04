import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import path from "node:path";
import webpush from "web-push";
import type { AppContext } from "./context.js";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";
import type { Locale } from "./locale.js";
import { runInLocale, t } from "./i18n/index.js";

/**
 * Notifications on the person's phone through the standard Web Push protocol:
 * the console, added to the iOS home screen (16.4+), subscribes with Apple's
 * push service; Android and desktop browsers use theirs. Payloads are
 * encrypted end to end (the push service cannot read them) and signed with
 * this deployment's VAPID key, which is generated once and kept in `var/`.
 * The iOS app's web view has no Web Push: the app registers with APNs itself
 * and its device token is kept in the same table, as `apns:<environment>:<token>`.
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

export type ApnsEnvironment = "production" | "development";
/** One notification to one iOS device: APNs' status and, when refused, its reason. */
export type ApnsSend = (device: { token: string; environment: ApnsEnvironment }, payload: PushPayload) => Promise<{ statusCode: number; reason?: string }>;
const APNS_ENDPOINT = /^apns:(production|development):([0-9a-f]{64,200})$/;
/** APNs refusals that mean the token will never work again (the app was removed, or the token is not this app's). */
const APNS_GONE = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

export const apnsEndpoint = (environment: ApnsEnvironment, token: string) => `apns:${environment}:${token}`;
const serviceOf = (endpoint: string) => endpoint.startsWith("apns:") ? "apns" : new URL(endpoint).hostname;

export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2000) return false;
  if (APNS_ENDPOINT.test(endpoint)) return true;
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

/**
 * Sends through Apple's push service with a token key (ES256 JWT, renewed every 40 minutes:
 * Apple accepts one for an hour and refuses renewals more often than every 20), over one
 * HTTP/2 connection per environment, as Apple asks.
 */
export function apnsSender(opts: { key: string; keyId: string; teamId: string; topic: string; origins?: Record<ApnsEnvironment, string> }): ApnsSend {
  const origins = opts.origins ?? { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" };
  const key = crypto.createPrivateKey(opts.key);
  let jwt = { token: "", at: 0 };
  const bearer = () => {
    const now = Math.floor(Date.now() / 1000);
    if (!jwt.token || now - jwt.at > 40 * 60) {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${part({ alg: "ES256", kid: opts.keyId })}.${part({ iss: opts.teamId, iat: now })}`;
      jwt = { token: `${unsigned}.${crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`, at: now };
    }
    return jwt.token;
  };
  const sessions = new Map<string, http2.ClientHttp2Session>();
  const session = (origin: string) => {
    let current = sessions.get(origin);
    if (!current || current.closed || current.destroyed) {
      const created = http2.connect(origin);
      created.on("error", () => undefined);
      created.on("close", () => { if (sessions.get(origin) === created) sessions.delete(origin); });
      created.unref();
      sessions.set(origin, created);
      current = created;
    }
    return current;
  };
  return (device, payload) => new Promise((resolve, reject) => {
    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${bearer()}`, "content-type": "application/json",
      "apns-topic": opts.topic, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 3600),
    };
    // Same tag, same notification, as with Web Push.
    if (payload.tag && Buffer.byteLength(payload.tag) <= 64) headers["apns-collapse-id"] = payload.tag;
    const body = JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body }, sound: "default", ...(payload.tag ? { "thread-id": payload.tag } : {}) }, url: payload.url ?? "/" });
    let status = 0, text = "", settled = false;
    const request = session(origins[device.environment]).request(headers);
    request.setTimeout(15_000, () => request.close(http2.constants.NGHTTP2_CANCEL));
    request.on("response", (response) => { status = Number(response[":status"]); });
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { text += chunk; });
    request.on("end", () => {
      settled = true;
      let reason: string | undefined;
      try { reason = (JSON.parse(text) as { reason?: string }).reason; } catch { /* 200 has no body */ }
      resolve({ statusCode: status, reason });
    });
    request.on("error", (err) => { settled = true; reject(err); });
    request.on("close", () => { if (!settled) reject(new Error("APNs request closed")); });
    request.end(body);
  });
}

/** The APNs sender of this deployment, or null when its key, key id or team is missing. */
export function loadApns(cfg: { keyFile: string; keyId: string; teamId: string; topic: string }): ApnsSend | null {
  const keyId = cfg.keyId || /AuthKey_([A-Z0-9]{10})\.p8$/.exec(cfg.keyFile)?.[1] || "";
  if (!keyId || !cfg.teamId || !cfg.topic || !fs.statSync(cfg.keyFile, { throwIfNoEntry: false })?.isFile()) return null;
  return apnsSender({ key: fs.readFileSync(cfg.keyFile, "utf8"), keyId, teamId: cfg.teamId, topic: cfg.topic });
}

export class PushService {
  readonly publicKey: string;
  #privateKey: string;
  #subject: string;
  #db: Db;
  #log: Logger;
  #send: Sender;
  #apns: ApnsSend | null;
  #seen = new Map<string, number>();

  constructor(opts: { db: Db; log: Logger; keyFile: string; subject: string; send?: Sender; apns?: ApnsSend | null }) {
    const keys = loadVapidKeys(opts.keyFile);
    this.publicKey = keys.publicKey;
    this.#privateKey = keys.privateKey;
    this.#subject = opts.subject;
    this.#db = opts.db;
    this.#log = opts.log.child("push");
    this.#send = opts.send ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
    this.#apns = opts.apns ?? null;
  }

  /** Whether the iOS app's devices can be reached (the deployment has an APNs key). */
  get apns(): boolean {
    return this.#apns !== null;
  }

  /** Store (or move to this account) a browser's subscription. */
  subscribe(ownerId: string, input: PushSubscriptionInput, userAgent = ""): void {
    const p256dh = input.keys?.p256dh, auth = input.keys?.auth;
    if (!validEndpoint(input.endpoint)) throw new Error(t().http.push.badEndpoint);
    if (typeof p256dh !== "string" || typeof auth !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) throw new Error(t().http.push.incomplete);
    this.#db.prepare(`INSERT INTO push_subscriptions (endpoint,owner_id,p256dh,auth,user_agent,created_at,failures) VALUES (?,?,?,?,?,?,0)
      ON CONFLICT(endpoint) DO UPDATE SET owner_id=excluded.owner_id,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent,failures=0`)
      .run(input.endpoint, ownerId, p256dh, auth, userAgent.slice(0, 300), Date.now());
  }

  /** Store (or move to this account) the iOS app's device token. Returns its endpoint. */
  subscribeApns(ownerId: string, token: unknown, environment: unknown, userAgent = ""): string {
    const endpoint = typeof token === "string" && (environment === "production" || environment === "development") ? apnsEndpoint(environment, token.toLowerCase()) : "";
    if (!APNS_ENDPOINT.test(endpoint)) throw new Error(t().http.push.incomplete);
    this.#db.prepare(`INSERT INTO push_subscriptions (endpoint,owner_id,p256dh,auth,user_agent,created_at,failures) VALUES (?,?,'','',?,?,0)
      ON CONFLICT(endpoint) DO UPDATE SET owner_id=excluded.owner_id,user_agent=excluded.user_agent,failures=0`)
      .run(endpoint, ownerId, userAgent.slice(0, 300), Date.now());
    return endpoint;
  }

  /** Whether this device gets the account's notifications. */
  has(ownerId: string, endpoint: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM push_subscriptions WHERE owner_id=? AND endpoint=?").get(ownerId, endpoint));
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
      const apns = APNS_ENDPOINT.exec(row.endpoint);
      if (apns && !this.#apns) return;
      try {
        if (apns) {
          const result = await this.#apns!({ environment: apns[1] as ApnsEnvironment, token: apns[2]! }, { url: "/", ...payload });
          if (result.statusCode !== 200) {
            const gone = result.statusCode === 410 || (result.statusCode === 400 && APNS_GONE.has(result.reason ?? ""));
            throw Object.assign(new Error(result.reason ?? "APNs refused"), { statusCode: gone ? 410 : result.statusCode, reason: result.reason });
          }
        } else await this.#send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify({ url: "/", ...payload }), {
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
        this.#log.warn("push not delivered", { status: status ?? null, host: serviceOf(row.endpoint), ...(apns ? { reason: (err as { reason?: string }).reason ?? null } : {}) });
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

/** What a task's news looks like on the phone, in the account's language, or null for news that is not worth a notification. */
export function taskNotification(task: TaskView, locale: Locale): PushPayload | null {
  const m = t(locale).http.push;
  // The daily feed reads as what it is; its first line ("今日为你留意", or the heading in the account's language) is the title already.
  if (task.schedule?.builtin === "daily_feed") {
    if (task.status !== "completed") return null;
    const result = (task.result ?? "").replace(/^\s*今日为你留意[：:]?\s*/, "");
    const heading = result.trimStart();
    const body = notificationText(heading.toLowerCase().startsWith(m.dailyFeed.toLowerCase()) ? heading.slice(m.dailyFeed.length).replace(/^[：:]?\s*/, "") : result);
    return body ? { title: m.dailyFeed, body, tag: "daily-feed" } : null;
  }
  if (task.status === "completed") return { title: m.completed(task.title), body: notificationText(task.result) || m.completedBody, tag: task.id };
  if (task.status === "failed") return { title: m.failed(task.title), body: notificationText(task.error) || m.failedBody, tag: task.id };
  if (task.status === "unknown") return { title: m.unknown(task.title), body: m.unknownBody, tag: task.id };
  if (task.status === "needs_input") return { title: m.needsInput(task.title), body: notificationText(task.clarification) || m.needsInputBody, tag: task.id };
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
  // Written for the account whatever runs when the news comes (a task, an event, this timer): in its language.
  const m = () => t(ctx.tasks.locale()).http.push;
  ctx.tasks.setNotifier((task) => send(taskNotification(task, ctx.tasks.locale())));
  const onEvent = (event: { type: string; conversationId: string }) => {
    if (event.type !== "approval.requested") return;
    const task = ctx.tasks.taskForConversation(event.conversationId);
    if (task) send({ title: m().approval(task.title), body: m().approvalBody, tag: `${task.id}:approval` });
  };
  ctx.agent.events.on("event", onEvent);
  const asked = new Set<string>();
  let polling = false;
  const timer = setInterval(() => {
    if (polling || !ctx.tabs || !ctx.tasks.hasRunning()) return;
    polling = true;
    // The tab service words a request without a reason of its own in the language current when listing.
    void runInLocale(() => ctx.tasks.locale(), () => ctx.tabs!.list()).then((tabs) => {
      for (const tab of tabs) {
        if (!tab.request || tab.holder !== "ai") continue;
        // The vault answers a sign-in it has an account for within seconds: only one still waiting is the person's.
        if (tab.request.kind === "login" && Date.now() - tab.request.at < VAULT_GRACE_MS) continue;
        const key = `${tab.id}:${tab.request.at}`;
        if (asked.has(key)) continue;
        asked.add(key);
        const task = ctx.tasks.taskForConversation(tab.key);
        send({ title: m().browser(task?.title ?? tab.title), body: notificationText(tab.request.reason, 120) || m().browserBody, tag: `${task?.id ?? tab.id}:browser` });
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
