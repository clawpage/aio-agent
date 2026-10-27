import { it, expect } from "vitest";
import http from "node:http";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { MacShellGateway, MAC_SHELL_TOOLS, macShellMcpServers, macShellThreadServers } from "../../src/control/macShell.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { DeviceLinks, DEVICE_LINK_PATH } from "../../src/control/deviceLink.js";
import { memberConfig } from "../../src/control/tenants.js";
import { createMember } from "../../src/control/auth/owner.js";
import { handleUpgrade } from "../../src/control/http/server.js";
// @ts-expect-error plain ESM script without types
import { linkDevice } from "../../bin/device-link-client.mjs";

const LOCAL_TOKEN = "local-bridge-secret";

/** A stand-in for the terminal half of bin/phone-bridge.mjs: answers each call with the command and the task's shell it ran in. */
async function fakeBridge() {
  const state: { status: { enabled: boolean; tmux: boolean } | null } = { status: { enabled: false, tmux: true } };
  const seen: Array<{ path: string; session: string | undefined; body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } }> = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) { res.writeHead(401).end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : {};
    const session = req.headers["x-aio-shell-session"] as string | undefined;
    seen.push({ path: req.url ?? "", session, body });
    if (req.url === "/shell/status") {
      if (!state.status) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.status));
      return;
    }
    // An app from before the terminal has no such path.
    if (body.params?.arguments?.command === "from an old app") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ran ${body.params?.arguments?.command} in ${session ?? "main"}` }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, state, close: () => { server.closeAllConnections(); server.close(); } };
}

async function signIn(h: Awaited<ReturnType<typeof startHarness>>, username: string) {
  await createMember(h.ctx.db, username, `${username}-password-123`);
  h.ctx.db.prepare("DELETE FROM login_failures").run();
  const res = await h.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: `${username}-password-123` }) });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const csrf = /pa_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE username=?").get(username) as { id: string }).id;
  return { cookie, csrf, id };
}

it("offers an account the terminal on the Mac it linked, one shell per task, and says so when the Mac is away", async () => {
  const bridge = await fakeBridge();
  const h = await startHarness();
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0, runtimeUserId: "owner_1" });
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const links = new DeviceLinks(h.ctx.db, cfg, h.ctx.log);
  const shell = new MacShellGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: names, userIdOf: ids, links });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, shell);
  await gateway.start();
  Object.assign(h.ctx, { deviceLinks: links, macShell: shell });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.ownsUpgrade(req) ? links.handleUpgrade(req, socket, head) : handleUpgrade(h.ctx, req, socket, head));
  let client: { close(): void } | null = null;
  try {
    const alice = await signIn(h, "alice");
    const bob = await signIn(h, "bob");
    const aliceCfg = memberConfig(cfg, alice.id, 18092);
    const bobCfg = memberConfig(cfg, bob.id, 18093);
    gateway.provision(aliceCfg);
    expect(aliceCfg.macShell).toBeUndefined();
    expect(macShellThreadServers(aliceCfg)).toEqual({});

    // Linking her Mac gives her runtime the terminal; nobody else's runtime gets one.
    const created = await h.request("/api/device-links", { method: "POST", headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf, "content-type": "application/json" }, body: JSON.stringify({ name: "Mac" }) });
    const { token, link } = (await created.json()) as { token: string; link: { id: string } };
    shell.refresh(aliceCfg);
    const url = aliceCfg.macShell!.url;
    expect(url).toMatch(/^http:\/\/host\.docker\.internal:0\/mac-shell\/[a-f0-9]{64}\/mcp$/);
    expect(macShellThreadServers(aliceCfg, { key: "conv_1", title: "t" })).toEqual({ aio_mac_shell: { url, http_headers: { "X-AIO-Task": "conv_1" }, tool_timeout_sec: expect.any(Number) } });
    expect(macShellMcpServers(aliceCfg, { key: "conv_1", title: "t" })).toEqual({ aio_mac_shell: { type: "http", url, headers: { "X-AIO-Task": "conv_1" } } });
    expect(codexRequirementsToml(aliceCfg)).toContain(`[mcp_servers.aio_mac_shell.identity]\nurl = "${url}"\n`);
    gateway.provision(bobCfg);
    shell.provision(cfg);
    expect(bobCfg.macShell).toBeUndefined();
    expect(cfg.macShell).toBeUndefined();
    expect(codexRequirementsToml(bobCfg)).not.toContain("aio_mac_shell");

    const rpc = async (body: unknown, task?: string, to = url) => {
      const res = await fetch(to.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`), {
        method: "POST", headers: { "content-type": "application/json", ...(task ? { "X-AIO-Task": task } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    };
    const bash = (command: string, task?: string, id = 9) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "bash", arguments: { command } } }, task);
    // A token nobody was given reaches nothing.
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, undefined, url.replace(/[a-f0-9]{64}/, "0".repeat(64)))).status).toBe(403);

    // The workspace's Mac Terminal reads its state: the account's own Mac only.
    const status = async (who: { cookie: string }) => (await (await h.request("/api/mac-shell/status", { headers: { cookie: who.cookie } })).json());
    expect(await status(alice)).toEqual({ state: "offline" });
    expect(await status(bob)).toEqual({ state: "unlinked" });

    // With the Mac away the server still starts and lists its four tools; a call says the Mac is away.
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).body).toEqual({ jsonrpc: "2.0", id: 1, result: expect.objectContaining({ protocolVersion: "2025-06-18", serverInfo: { name: "aio_mac_shell", version: "1" } }) });
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: MAC_SHELL_TOOLS } });
    expect(MAC_SHELL_TOOLS.map((t) => t.name)).toEqual(["read", "write", "edit", "bash"]);
    const away = (await bash("ls")).body as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(away.result.isError).toBe(true);
    expect(away.result.content[0]!.text).toMatch(/Mac is not connected/);
    expect(bridge.seen).toEqual([]);

    // Once the Mac dials in, each call goes down its socket to the terminal, in the task's own shell.
    const states: string[] = [];
    client = linkDevice({ url: `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, token, name: "Mac", local: bridge.url, localToken: LOCAL_TOKEN, onState: (s: string) => states.push(s) });
    await expect.poll(() => states.at(-1)).toBe("online");
    expect(await status(alice)).toEqual({ state: "ready", enabled: false, tmux: true });
    bridge.state.status = { enabled: true, tmux: false };
    expect(await status(alice)).toEqual({ state: "ready", enabled: true, tmux: false });
    expect(await status(bob)).toEqual({ state: "unlinked" });
    bridge.seen.length = 0;
    expect((await bash("pwd", "conv_1", 5)).body).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "ran pwd in conv_1" }] } });
    expect((await bash("pwd", undefined, 6)).body).toEqual({ jsonrpc: "2.0", id: 6, result: { content: [{ type: "text", text: "ran pwd in main" }] } });
    // A task key that is not one never names a shell.
    expect((await bash("pwd", "../../etc", 7)).body).toMatchObject({ result: { content: [{ text: "ran pwd in main" }] } });
    expect(bridge.seen.map((s) => [s.path, s.session, s.body.method, s.body.id])).toEqual([
      ["/shell/mcp", "conv_1", "tools/call", 5],
      ["/shell/mcp", undefined, "tools/call", 6],
      ["/shell/mcp", undefined, "tools/call", 7],
    ]);
    // The handshake and the tool list never go to the Mac.
    await rpc({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    expect(bridge.seen).toHaveLength(3);

    // A Mac app from before the terminal answers its path 404: the executor learns the result is unknown, not that it failed.
    const old = (await bash("from an old app")).body as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(old.result).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/did not answer.*unknown/s) }] });
    // …and has no terminal to report.
    bridge.state.status = null;
    expect(await status(alice)).toEqual({ state: "outdated" });

    // Removing the link takes the terminal away.
    expect((await h.request(`/api/device-links/${link.id}`, { method: "DELETE", headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf } })).status).toBe(200);
    await expect.poll(() => states.at(-1)).toBe("revoked");
    shell.refresh(aliceCfg);
    expect(aliceCfg.macShell).toBeUndefined();
  } finally {
    client?.close();
    links.close();
    gateway.close();
    bridge.close();
    await h.shutdown();
  }
});
