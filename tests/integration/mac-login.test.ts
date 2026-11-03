import { it, expect } from "vitest";
import fs from "node:fs";
import http from "node:http";
import { chromium, type Page } from "playwright-core";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { macParts } from "../helpers/macNative.js";
import { DeviceLinks, DEVICE_LINK_PATH } from "../../src/control/deviceLink.js";
import { Vault } from "../../src/control/vault.js";
// @ts-expect-error plain ESM script without types
import { linkDevice } from "../../bin/device-link-client.mjs";

const hasChromium = fs.existsSync(chromium.executablePath());
const LOCAL_TOKEN = "local-bridge-secret";
const USERNAME = "roy.parent@example.com";
const PASSWORD = "S3cret-pass!word";

/** Two sites on one server: login.example (a sign-in form, and a link off to elsewhere.example) and elsewhere.example (a look-alike form). */
async function sites() {
  const posted: Array<{ host: string; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0]!;
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      posted.push({ host, body });
      res.writeHead(303, { location: "/home" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/home") { res.end("<title>Home</title><h1>Signed in</h1>"); return; }
    res.end(`<title>Sign in</title><a id="away" href="http://elsewhere.example:${port}/login">Partner</a>
      <form method="post" action="/session"><input id="user" name="user" type="text"><input id="note" name="note" type="text"><input id="pass" name="pass" type="password"><button>Sign in</button></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, posted, close: () => { server.closeAllConnections(); server.close(); } };
}

/** The browser half of the Mac's bridge, in front of a real Chromium page: chrome-devtools-mcp's tools, as far as a sign-in uses them. */
async function bridgeOver(page: Page) {
  const typed: string[] = [];
  const pages = () => `## Pages\n1: ${page.url() === "about:blank" ? "about:blank" : `Page (${page.url()})`} [selected]`;
  const tool = async (name: string, a: Record<string, unknown>): Promise<string> => {
    if (name === "list_pages" || name === "take_snapshot") return pages();
    if (name === "new_page" || name === "navigate_page") { await page.goto(String(a.url)); return pages(); }
    if (name === "evaluate_script") return `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(await page.evaluate(`(${String(a.function)})()`))}\n\`\`\``;
    if (name === "type_text") { typed.push(String(a.text)); await page.keyboard.type(String(a.text)); return "Typed text"; }
    if (name === "press_key") { await page.keyboard.press(String(a.key)); await page.waitForLoadState().catch(() => undefined); return "Pressed"; }
    throw new Error(`unexpected tool ${name}`);
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) { res.writeHead(401).end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    if (body.method === "tools/list") { res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })); return; }
    try {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: await tool(body.params.name, body.params.arguments ?? {}) }] } }));
    } catch (err) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: String(err) }], isError: true } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, typed, close: () => { server.closeAllConnections(); server.close(); } };
}

it("signs in with the password manager in the Mac's Chrome, only on the saved site, and the agent never sees the account", async () => {
  if (!hasChromium) return;
  const web = await sites();
  const chrome = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP *.example 127.0.0.1"] });
  const page = await chrome.newPage();
  const bridge = await bridgeOver(page);
  const h = await startHarness();
  const cfg = Object.assign(h.ctx.cfg, { memberModelPort: 0 });
  const ids = (name: string) => (h.ctx.db.prepare("SELECT id AS v FROM owners WHERE username=?").get(name) as { v: string } | undefined)?.v ?? null;
  const names = (id: string) => (h.ctx.db.prepare("SELECT username AS v FROM owners WHERE id=?").get(id) as { v: string } | undefined)?.v ?? null;
  const ownerId = (h.ctx.db.prepare("SELECT id FROM owners WHERE role='owner'").get() as { id: string }).id;
  cfg.runtimeUserId = ownerId;
  const vault = new Vault(h.ctx.db, cfg.dataDir, ownerId);
  const links = new DeviceLinks(h.ctx.db, cfg, h.ctx.log);
  const { native } = macParts({ cfg, log: h.ctx.log, usernameOf: names, userIdOf: ids, links, vaultFor: async () => vault });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, native);
  await gateway.start();
  Object.assign(h.ctx, { deviceLinks: links });
  h.server.removeAllListeners("upgrade");
  h.server.on("upgrade", (req, socket, head) => links.handleUpgrade(req, socket, head));
  let client: { close(): void } | null = null;
  try {
    const { token } = links.create(ownerId, "Mac");
    native.provision(cfg);
    const states: string[] = [];
    client = linkDevice({ url: `ws://localhost:${h.primaryPort}${DEVICE_LINK_PATH}`, token, name: "Mac", local: bridge.url, localToken: LOCAL_TOKEN, onState: (s: string) => states.push(s) });
    await expect.poll(() => states.at(-1)).toBe("online");
    const agent = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await fetch(cfg.macNative!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`), {
        method: "POST", headers: { "content-type": "application/json", "X-AIO-Task": "conv_login" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const result = ((await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
      // Whatever the agent hears, never the account or the password.
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(JSON.stringify(result)).not.toContain(USERNAME);
      return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
    };
    const login = `http://login.example:${web.port}/login`;

    // The tools are offered next to the browser's own.
    const listed = await fetch(cfg.macNative!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["request_human", "browser_login", "browser_login_report"]));

    // Nothing saved for the site: the person is asked instead.
    await agent("new_page", { url: login });
    const none = await agent("browser_login", { pageId: 1 });
    expect(none).toEqual({ isError: true, text: expect.stringMatching(/no account for login\.example.*request_human/s) });
    vault.create({ site: "login.example", username: USERNAME, password: PASSWORD });

    // Only this task's page: another pageId is refused.
    expect((await agent("browser_login", { pageId: 7 })).text).toMatch(/pageId of the page this task opened/);

    // A step that would type the password into a text box is refused, and nothing is sent.
    const wrongBox = await agent("browser_login", { pageId: 1, steps: [{ action: "fill", selector: "#user", value: "{{username}}" }, { action: "fill", selector: "#note", value: "{{password}}" }] });
    expect(wrongBox).toEqual({ isError: true, text: expect.stringMatching(/Step 2 .*not point at a password box.*Attempts left: 2/s) });
    expect(bridge.typed).not.toContain(PASSWORD);

    // Steps that lead off the saved site type nothing there.
    const away = await agent("browser_login", { pageId: 1, steps: [{ action: "click", selector: "#away" }, { action: "wait", ms: 500 }, { action: "fill", selector: "#pass", value: "{{password}}" }] });
    expect(away).toEqual({ isError: true, text: expect.stringMatching(/Step 3 .*elsewhere\.example, not login\.example; nothing was typed/s) });
    expect(web.posted).toEqual([]);
    expect(bridge.typed).not.toContain(PASSWORD);

    // Good steps: the form is posted to the saved site with the saved account, and the page keeps no password.
    await agent("navigate_page", { pageId: 1, type: "url", url: login });
    const steps = [{ action: "fill", selector: "#user", value: "{{username}}" }, { action: "fill", selector: "#pass", value: "{{password}}" }, { action: "press", key: "Enter" }];
    const signedIn = await agent("browser_login", { pageId: 1, steps });
    expect(signedIn).toEqual({ isError: false, text: expect.stringMatching(/filled in the account and password and submitted.*browser_login_report/s) });
    expect(web.posted).toEqual([{ host: "login.example", body: new URLSearchParams({ user: USERNAME, note: "", pass: PASSWORD }).toString() }]);
    expect(page.url()).toBe(`http://login.example:${web.port}/home`);
    expect(await agent("browser_login_report", { pageId: 1, ok: true })).toEqual({ isError: false, text: expect.stringMatching(/Noted/) });
    expect(vault.script("login.example")).toMatchObject({ steps, startUrl: login, successes: 1 });

    // Next time the kept steps are used without the agent writing any, from where they worked.
    await agent("navigate_page", { pageId: 1, type: "url", url: `http://login.example:${web.port}/home` });
    expect((await agent("browser_login", { pageId: 1 })).text).toMatch(/using the steps that worked on this site last time/);
    expect(web.posted).toHaveLength(2);
    expect(web.posted[1]!.host).toBe("login.example");
  } finally {
    client?.close();
    links.close();
    gateway.close();
    bridge.close();
    await chrome.close();
    web.close();
    await h.shutdown();
  }
}, 60_000);

it("finds the sign-in form by itself when no steps are given, and empties the password box if the page stays", async () => {
  if (!hasChromium) return;
  const chrome = await chromium.launch({ headless: true });
  const page = await chrome.newPage();
  try {
    const { runMacLogin } = await import("../../src/control/macLogin.js");
    const { CLEAR_PASSWORDS_SCRIPT } = await import("../../src/control/macLogin.js");
    // A form that ignores Enter: the boxes are filled, nothing leaves the page.
    await page.route("http://login.example/**", (route) => route.fulfill({ contentType: "text/html", body: `<form onsubmit="return false"><input name="email" type="email"><input type="password"></form>` }));
    const call = async (name: string, a: Record<string, unknown>) => {
      if (name === "navigate_page") { await page.goto(String(a.url)); return ""; }
      if (name === "evaluate_script") return `\`\`\`json\n${JSON.stringify(await page.evaluate(`(${String(a.function)})()`))}\n\`\`\``;
      if (name === "type_text") { await page.keyboard.type(String(a.text)); return ""; }
      if (name === "press_key") { await page.keyboard.press(String(a.key)); return ""; }
      throw new Error(name);
    };
    expect(await runMacLogin(call, 1, { site: "login.example", steps: null, startUrl: "http://login.example/" }, USERNAME, PASSWORD)).toEqual({ result: "submitted" });
    expect(await page.inputValue('input[type="email"]')).toBe(USERNAME);
    expect(await page.inputValue('input[type="password"]')).toBe(PASSWORD);
    await call("evaluate_script", { function: CLEAR_PASSWORDS_SCRIPT });
    expect(await page.inputValue('input[type="password"]')).toBe("");
  } finally {
    await chrome.close();
  }
}, 30_000);
