import WebSocket from "ws";
import { startHarness } from "./harness.js";
import { macParts } from "./macNative.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { DeviceLinks, DEVICE_LINK_PATH } from "../../src/control/deviceLink.js";
import { IosDeviceGateway } from "../../src/control/iosDevice.js";
import { EnvRegistry } from "../../src/control/envs/registry.js";
import { EnvGateway } from "../../src/control/envs/gateway.js";
import { memberConfig } from "../../src/control/tenants.js";
import { createMember } from "../../src/control/auth/owner.js";
import { handleUpgrade } from "../../src/control/http/server.js";
import { Logger } from "../../src/common/logger.js";

/**
 * A control plane with the execution environments (docs/EXEC-ENVS.md) for tests: device links on a real
 * socket, the registry, aio_env and today's per-device servers on a member gateway, and the account's
 * workspace as a map. Devices dial `url`; the executor's side is `executor(runtime)`.
 */
export async function startEnvWorld() {
  const h = await startHarness();
  const log = new Logger("error", undefined, false);
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0, runtimeUserId: "owner_1" });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const links = new DeviceLinks(h.ctx.db, cfg, log);
  const mac = macParts({ cfg, log, usernameOf: names, userIdOf: ids, links });
  const saved = new Map<string, { userId: string; bytes: Buffer }>();
  /** Who was told to come back to their phone's app; tests that wait for them say how long (`registry.awayWaitMs`). */
  const away: Array<{ userId: string; name: string; kind: string }> = [];
  const registry = new EnvRegistry({ links, log, phone: mac.phone, browser: mac.browser, shell: mac.shell, onAway: (userId, env) => { away.push({ userId, name: env.name, kind: env.kind }); } });
  registry.awayWaitMs = 0;
  const envs = new EnvGateway({ cfg, log, port: 0, usernameOf: names, userIdOf: ids, links, registry, workspace: "/home/gem/workspace",
    filesFor: async (userId) => ({
      read: async (file) => { const kept = saved.get(file); if (!kept || kept.userId !== userId) throw new Error("no such file"); return kept.bytes; },
      write: async (file, bytes) => { saved.set(file, { userId, bytes: Buffer.from(bytes) }); },
    }) });
  // The per-device servers of today, kept for runtimes with the environments off.
  const ios = new IosDeviceGateway({ cfg, log, port: 0, usernameOf: names, userIdOf: ids, links, workspace: "/home/gem/workspace", filesFor: async () => ({ read: async () => { throw new Error("unused"); }, write: async () => undefined }) });
  const gateway = new MemberModelGateway(cfg, log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, mac.native, undefined, undefined, ios, envs);
  await gateway.start();
  Object.assign(h.ctx, { deviceLinks: links, envs: registry });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  const devices: WebSocket[] = [];

  async function signIn(username: string) {
    await createMember(h.ctx.db, username, `${username}-password-123`);
    h.ctx.db.prepare("DELETE FROM login_failures").run();
    const res = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: `${username}-password-123` }) });
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const csrf = /pa_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
    const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE username=?").get(username) as { id: string }).id;
    return { cookie, csrf, id, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" } };
  }

  /** A device link of `kind` for the account, as the app asks for it; its token. */
  async function link(who: { headers: Record<string, string> }, kind: "mac" | "ios" | "android", name: string): Promise<string> {
    const res = await h.request("/api/device-links", { method: "POST", headers: who.headers, body: JSON.stringify({ name, kind }) });
    if (res.status !== 200) throw new Error(`device link not created (${res.status})`);
    return ((await res.json()) as { token: string }).token;
  }

  /** An account's runtime with the execution environments on (PA_EXEC_ENVS=1), provisioned on the member gateway. */
  function runtimeFor(userId: string, port: number) {
    const runtime = memberConfig({ ...h.ctx.cfg, execEnvs: true }, userId, port);
    gateway.provision(runtime);
    return runtime;
  }

  /** A runtime's gateway URL as reached from here (the sandbox reaches it as host.docker.internal). */
  const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:\d+/, `http://127.0.0.1:${gateway.port}`);

  /** The account's aio_env, as its executor calls it (a task's thread adds its X-AIO-Task header). */
  function executor(runtime: { env?: { url: string } }, headers: Record<string, string> = {}) {
    let id = 0;
    const rpc = async (method: string, params: unknown = {}) => {
      const res = await fetch(local(runtime.env!.url), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      return (await res.json()) as { result: any; error?: unknown };
    };
    const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
    const text = (out: { content: Array<{ type: string; text?: string }> }) => out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const list = async () => JSON.parse(text(await call("env_list"))) as { envs: Array<{ id: string; kind: string; name: string; online: boolean; foreground: boolean; capabilities: string[] }> };
    return { rpc, call, text, list };
  }

  async function close() {
    for (const ws of devices) ws.terminate();
    links.close();
    gateway.close();
    await h.shutdown();
  }

  return { h, links, registry, gateway, mac, saved, away, devices, url: `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, signIn, link, runtimeFor, local, executor, close };
}

/** Polls until `probe` gives something truthy (every 25 ms, at most `ms`). */
export async function waitFor<T>(probe: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}
