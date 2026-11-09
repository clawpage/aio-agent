import { createHash } from "node:crypto";
import type { Logger } from "../../common/logger.js";
import type { DeviceLinks, Tunnel } from "../deviceLink.js";
import type { PhoneGateway } from "../phone.js";
import type { UserBrowserGateway } from "../userBrowser.js";
import { MAX_COMMAND_S, SLACK_MS, type MacShellGateway } from "../macShell.js";
import { TAB_TASK_HEADER } from "../browser/tabs.js";
import { CAPABILITIES, TOOL_CAPABILITY, type Capability, type EnvAnswer, type EnvInfo, type EnvKind } from "./catalog.js";
import { iosCapabilities, OldMac, type MacCaller } from "./legacy.js";

/**
 * The environments of every account (docs/EXEC-ENVS.md): the sandbox, and what each linked device
 * offers. A device of protocol 1 says so itself (`GET /env/manifest`, then `manifest` events as it
 * changes); an older one is read through legacy.ts. One physical device reached two ways (a phone on a
 * Mac's USB and in its own app) is one environment, keyed by its id or aliases; a call goes to the way
 * that can do it, the device's own app first. Environments stay listed (offline) once seen, so their
 * ids hold across reconnects; this is memory only, rebuilt as devices come back after a restart.
 */
const MANIFEST_PATH = "/env/manifest";
const CALL_PATH = "/env/call";
const READ_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/** A photo may first have to come down from the cloud. */
const SLOW_TIMEOUT_MS = 150_000;

type Protocol = "v1" | "ios-v0" | "mac-v0";

/** One way to reach an environment: a device link and what it offers through it. */
interface Route {
  tunnel: Tunnel;
  protocol: Protocol;
  /** The device's own id for it (protocol 1), or its adb serial on an old Mac's USB. */
  deviceId: string;
  keys: string[];
  kind: Exclude<EnvKind, "sandbox">;
  name: string;
  capabilities: Capability[];
  foreground: boolean;
}

/** An environment once seen: its routes while online, what it last offered when not. */
interface Known {
  id: string;
  kind: Exclude<EnvKind, "sandbox">;
  name: string;
  keys: Set<string>;
  capabilities: Capability[];
  routes: Route[];
}

export const SANDBOX_ENV: EnvInfo = { id: "sandbox", kind: "sandbox", name: "Sandbox", online: true, foreground: false, capabilities: ["browser", "files", "shell"] };

export type EnvCall =
  | { status: "answered"; env: EnvInfo; answer: EnvAnswer }
  | { status: "missing" }
  | { status: "sandbox" }
  | { status: "offline"; env: EnvInfo }
  | { status: "unable"; env: EnvInfo; capability: Capability }
  | { status: "failed"; env: EnvInfo; error: string };

type ManifestEnv = { deviceId?: unknown; aliases?: unknown; kind?: unknown; name?: unknown; capabilities?: unknown; foreground?: unknown };

export class EnvRegistry {
  #links: DeviceLinks;
  #log: Logger;
  #mac: OldMac;
  #browser?: UserBrowserGateway;
  #known = new Map<string, Known[]>();
  #reading = new Map<Tunnel, Promise<void>>();

  constructor(opts: { links: DeviceLinks; log: Logger; phone?: PhoneGateway; browser?: UserBrowserGateway; shell?: MacShellGateway }) {
    this.#links = opts.links;
    this.#log = opts.log.child("envs");
    this.#mac = new OldMac(opts);
    this.#browser = opts.browser;
    opts.links.watch((tunnel, online) => {
      if (online) {
        tunnel.events.on("event", (name: string, data: unknown) => { if (name === "manifest") this.#apply(tunnel, this.#fromManifest(tunnel, data)); });
        this.#read(tunnel);
      } else this.#drop(tunnel);
    });
  }

  /** The account's environments: the sandbox first, then each device in the order it was first seen. */
  async list(userId: string): Promise<EnvInfo[]> {
    for (const tunnel of this.#links.tunnelsFor(userId)) await (this.#reading.get(tunnel) ?? this.#read(tunnel));
    return [SANDBOX_ENV, ...(this.#known.get(userId) ?? []).map((k) => this.#info(k))];
  }

  /** The same, as known right now without waiting on a device still being read: for the brief at the start of a turn. */
  snapshot(userId: string): EnvInfo[] {
    return [SANDBOX_ENV, ...(this.#known.get(userId) ?? []).map((k) => this.#info(k))];
  }

  /** One aio_env call for the account: to the environment named, by the way that can do it. */
  async call(userId: string, caller: MacCaller, envId: string, tool: string, args: Record<string, unknown>): Promise<EnvCall> {
    if (envId === SANDBOX_ENV.id) return { status: "sandbox" };
    await this.list(userId);
    const known = (this.#known.get(userId) ?? []).find((k) => k.id === envId);
    if (!known) return { status: "missing" };
    const env = this.#info(known);
    if (!known.routes.length) return { status: "offline", env };
    const capability = TOOL_CAPABILITY.get(tool);
    const route = capability ? this.#best(known, capability) : undefined;
    if (!capability || !route) return { status: "unable", env, capability: capability ?? "browser" };
    try {
      return { status: "answered", env, answer: await this.#send(route, caller, tool, args) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#log.warn("environment call failed", { userId, env: envId, tool, error });
      return known.routes.length ? { status: "failed", env, error } : { status: "offline", env };
    }
  }

  /** The way to reach `known` for `capability`: the device's own app (protocol 1) before an older way. */
  #best(known: Known, capability: Capability): Route | undefined {
    const able = known.routes.filter((r) => r.capabilities.includes(capability) && r.tunnel.alive);
    return able.find((r) => r.protocol === "v1") ?? able[0];
  }

  async #send(route: Route, caller: MacCaller, tool: string, args: Record<string, unknown>): Promise<EnvAnswer> {
    const timeoutMs = tool === "photos_get" || tool === "files_pull" || tool === "files_push" ? SLOW_TIMEOUT_MS : CALL_TIMEOUT_MS;
    if (route.protocol === "mac-v0") {
      if (route.kind === "android") return this.#mac.phone(caller, tool, args, route.deviceId);
      return TOOL_CAPABILITY.get(tool) === "shell" ? this.#mac.shell(caller, tool, args) : this.#mac.browser(caller, tool, args);
    }
    // A Mac's Chrome browses on the Mac; its page on the task's card, the person taking it over and request_human stay with the console.
    if (route.protocol === "v1" && route.kind === "mac" && TOOL_CAPABILITY.get(tool) === "browser" && this.#browser) {
      return this.#browser.envCall(route.tunnel.ownerId, caller.headers, tool, args, () => this.#post(route, caller, tool, args, timeoutMs));
    }
    // A command may run up to its own timeout on the Mac, and longer than any other call.
    const seconds = Number(args.timeout_sec);
    return this.#post(route, caller, tool, args, tool === "shell_bash" ? Math.min(seconds > 0 ? seconds : CALL_TIMEOUT_MS / 1000, MAX_COMMAND_S) * 1000 + SLACK_MS : timeoutMs);
  }

  async #post(route: Route, caller: MacCaller, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<EnvAnswer> {
    const body = route.protocol === "v1" ? { env: route.deviceId, tool, arguments: args } : { tool, arguments: args };
    // The task names its own shell on a device that keeps one per task (a Mac).
    const task = caller.headers[TAB_TASK_HEADER.toLowerCase()];
    const reply = await route.tunnel.request("POST", route.protocol === "v1" ? CALL_PATH : "/ios/call", {
      headers: { "content-type": "application/json", ...(typeof task === "string" ? { [TAB_TASK_HEADER.toLowerCase()]: task } : {}) },
      body: Buffer.from(JSON.stringify(body)),
      timeoutMs,
    });
    if (reply.status === 404) return { ok: false, code: "unknown_tool" };
    if (reply.status !== 200) throw new Error(`device answered ${reply.status}`);
    return JSON.parse(reply.body.toString("utf8")) as EnvAnswer;
  }

  /** Learn what a device that just came online offers. */
  #read(tunnel: Tunnel): Promise<void> {
    const reading = (async () => {
      try {
        const reply = await tunnel.request("GET", MANIFEST_PATH, { timeoutMs: READ_TIMEOUT_MS });
        if (reply.status === 200) return this.#apply(tunnel, this.#fromManifest(tunnel, JSON.parse(reply.body.toString("utf8"))));
        if (reply.status !== 404) return;
        this.#apply(tunnel, await this.#fromOld(tunnel));
      } catch (err) {
        this.#log.warn("device environments not read", { link: tunnel.linkId, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    this.#reading.set(tunnel, reading);
    return reading;
  }

  #fromManifest(tunnel: Tunnel, manifest: unknown): Route[] {
    const envs = (manifest as { envs?: unknown } | null)?.envs;
    if (!Array.isArray(envs)) return [];
    return envs.flatMap((raw: ManifestEnv) => {
      const kind = raw.kind === "ios" || raw.kind === "android" || raw.kind === "mac" ? raw.kind : null;
      const deviceId = typeof raw.deviceId === "string" && raw.deviceId ? raw.deviceId.slice(0, 200) : "";
      if (!kind || !deviceId) return [];
      const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === "string" && a.length > 0).map((a) => a.slice(0, 200)) : [];
      // A Mac is first known by its link (as before protocol 1), so its id holds when its app is updated.
      if (kind === "mac" && tunnel.kind === "mac") aliases.unshift(`link:${tunnel.linkId}`);
      const capabilities = CAPABILITIES.filter((c) => Array.isArray(raw.capabilities) && raw.capabilities.includes(c));
      return [{ tunnel, protocol: "v1" as const, deviceId, keys: [...aliases, deviceId], kind, name: typeof raw.name === "string" ? raw.name.slice(0, 80) : kind, capabilities, foreground: raw.foreground === true }];
    });
  }

  /** What an old device offers: an old iPhone's abilities; an old Mac itself and the phone on its USB. */
  async #fromOld(tunnel: Tunnel): Promise<Route[]> {
    const linkKey = `link:${tunnel.linkId}`;
    const json = async (path: string) => {
      const reply = await tunnel.request("GET", path, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
      return reply?.status === 200 ? JSON.parse(reply.body.toString("utf8")) as unknown : null;
    };
    const named = this.#links.list(tunnel.ownerId, tunnel.kind).find((l) => l.id === tunnel.linkId)?.name ?? tunnel.kind;
    if (tunnel.kind === "ios") {
      // The old app answers only while on screen.
      return [{ tunnel, protocol: "ios-v0", deviceId: linkKey, keys: [linkKey], kind: "ios", name: named, capabilities: iosCapabilities(await json("/ios/status")), foreground: true }];
    }
    if (tunnel.kind !== "mac") return [];
    const shell = await this.#mac.shellOn(tunnel.ownerId);
    const routes: Route[] = [{ tunnel, protocol: "mac-v0", deviceId: linkKey, keys: [linkKey], kind: "mac", name: named, capabilities: shell ? ["browser", "shell"] : ["browser"], foreground: false }];
    const phone = ((await json("/status")) as { device?: { serial?: unknown; name?: unknown; model?: unknown } | null } | null)?.device;
    if (phone && typeof phone.serial === "string" && phone.serial) {
      routes.push({ tunnel, protocol: "mac-v0", deviceId: phone.serial, keys: [phone.serial], kind: "android", name: String(phone.name || phone.model || "Android"), capabilities: ["apps", "screen"], foreground: false });
    }
    return routes;
  }

  /** A device's routes replace what it offered before; each joins the environment it is, or becomes a new one. */
  #apply(tunnel: Tunnel, routes: Route[]): void {
    const known = this.#known.get(tunnel.ownerId) ?? [];
    for (const k of known) k.routes = k.routes.filter((r) => r.tunnel !== tunnel);
    for (const route of routes) {
      let env = known.find((k) => k.kind === route.kind && route.keys.some((key) => k.keys.has(key)));
      if (!env) {
        env = { id: envId(tunnel.ownerId, route.kind, route.keys[0]!), kind: route.kind, name: route.name, keys: new Set(), capabilities: [], routes: [] };
        known.push(env);
      }
      for (const key of route.keys) env.keys.add(key);
      env.routes.push(route);
      if (route.protocol === "v1" || env.routes.every((r) => r.protocol !== "v1")) env.name = route.name;
    }
    for (const k of known) if (k.routes.length) k.capabilities = CAPABILITIES.filter((c) => k.routes.some((r) => r.capabilities.includes(c)));
    this.#known.set(tunnel.ownerId, known);
  }

  #drop(tunnel: Tunnel): void {
    this.#reading.delete(tunnel);
    for (const k of this.#known.get(tunnel.ownerId) ?? []) k.routes = k.routes.filter((r) => r.tunnel !== tunnel);
  }

  #info(k: Known): EnvInfo {
    const online = k.routes.some((r) => r.tunnel.alive);
    return { id: k.id, kind: k.kind, name: k.name, online, foreground: online && k.routes.some((r) => r.foreground), capabilities: [...k.capabilities] };
  }
}

/** `<kind>:<8 hex>`: the same for a device every time, and different across accounts. */
function envId(ownerId: string, kind: string, key: string): string {
  return `${kind}:${createHash("sha256").update(`${ownerId}\u0000${kind}\u0000${key}`).digest("hex").slice(0, 8)}`;
}
