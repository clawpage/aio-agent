// Public HTTPS acceptance probe: real cookies, both origins, no secrets printed.
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

// Maintained live smoke test. Defaults target the production deployment; override to
// point at a local instance, e.g.
//   PA_PRIMARY_ORIGIN=http://localhost:4891 PA_COMPANION_ORIGIN=http://127.0.0.1:4891 npm run smoke
const PRIMARY = process.env.PA_PRIMARY_ORIGIN ?? "https://agent.zymx.tech";
const COMPANION = process.env.PA_COMPANION_ORIGIN ?? "https://agent-workspace.zymx.tech";
const secretFile = process.env.PA_OWNER_SECRET_FILE ?? process.argv[2] ?? "var/owner-secret.txt";
const password = fs.readFileSync(path.resolve(secretFile), "utf8").trim();

class Jar {
  constructor(name) { this.name = name; this.cookies = new Map(); this.attributes = new Map(); }
  setFrom(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const key = pair.slice(0, i).trim();
      this.cookies.set(key, pair.slice(i + 1).trim());
      this.attributes.set(key, attrs.map((a) => a.trim()));
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
}

const primary = new Jar("primary");
const companion = new Jar("companion");

async function call(jar, url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) { headers.set("content-type", "application/json"); }
  // manual redirects: Node's fetch has no cookie jar, so a followed redirect would
  // drop the Set-Cookie from the 303 bootstrap response.
  const res = await fetch(url, {
    redirect: "manual",
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  jar.setFrom(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, headers: res.headers, json, text };
}

const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. Login over TLS
const login = await call(primary, `${PRIMARY}/api/auth/login`, { method: "POST", json: { password }, headers: { origin: PRIMARY } });
check("login", login.status === 200, `status=${login.status}`);
const sessionAttrs = (primary.attributes.get("pa_session") ?? []).join(";").toLowerCase();
check("session cookie is HttpOnly", sessionAttrs.includes("httponly"));
// Secure is mandatory over TLS; loopback http (local runs) intentionally omits it.
if (PRIMARY.startsWith("https://")) {
  check("session cookie is Secure", sessionAttrs.includes("secure"));
} else {
  check("loopback session cookie omits Secure by design", !sessionAttrs.includes("secure"));
}
const csrfCookie = primary.cookies.get("pa_csrf");
check("csrf cookie present (not a credential)", Boolean(csrfCookie));

// 2. Authenticated status
const status = await call(primary, `${PRIMARY}/api/status`, { headers: { origin: PRIMARY } });
check("status authenticated", status.status === 200 && status.json?.agent?.sessionReady === true, `account=${status.json?.agent?.account?.email}`);
check("host auth ok", status.json?.hostAuth?.ok === true);

// 3. Conversation + model list (read-only: no probe conversation is created)
const models = await call(primary, `${PRIMARY}/api/models`, { headers: { origin: PRIMARY } });
check("models from live API", (models.json?.models ?? []).length > 0, (models.json?.models ?? []).map((m) => m.id).join(","));
const conversations = await call(primary, `${PRIMARY}/api/conversations`, { headers: { origin: PRIMARY } });
check(
  "conversation list readable",
  conversations.status === 200 && Array.isArray(conversations.json?.conversations),
  `status=${conversations.status} count=${conversations.json?.conversations?.length}`,
);

// 4. Workspace ticket -> companion cookie
const ticket = await call(primary, `${PRIMARY}/api/workspace/ticket`, {
  method: "POST", json: { next: "/terminal" }, headers: { origin: PRIMARY, "x-csrf-token": csrfCookie ?? "" },
});
check("issue workspace ticket", ticket.status === 200 && Boolean(ticket.json?.ticket));
const bootUrl = ticket.json?.url;
check("ticket url uses companion origin", typeof bootUrl === "string" && bootUrl.startsWith(COMPANION), bootUrl?.slice(0, 48));
const boot = await call(companion, bootUrl);
check("bootstrap redirects", boot.status === 303, `status=${boot.status} -> ${boot.headers.get("location")}`);
const companionAttrs = (companion.attributes.get("pa_ws_session") ?? []).join(";").toLowerCase();
check("companion cookie is HttpOnly", companionAttrs.includes("httponly"));
if (COMPANION.startsWith("https://")) check("companion cookie is Secure", companionAttrs.includes("secure"));
const replay = await call(companion, bootUrl);
check("ticket is single-use", replay.status === 403, `status=${replay.status}`);

// 5. Companion session + real terminal API through the authenticated proxy
const wsSession = await call(companion, `${COMPANION}/api/workspace/session`);
check("companion session authenticated", wsSession.json?.authenticated === true);
// A browser posting to the companion sends its own Origin, so the probe does too.
const shell = await call(companion, `${COMPANION}/v1/shell/exec`, {
  method: "POST",
  json: { command: "echo PUBLIC_PROXY_OK && uname -s", exec_dir: "/home/gem" },
  headers: { origin: COMPANION },
});
const shellOut = JSON.stringify(shell.json);
check("authenticated shell exec through proxy", shell.status === 200 && shellOut.includes("PUBLIC_PROXY_OK"), shellOut.slice(0, 120));

// 6. Companion session renewal from the control-plane origin
const renew = await call(companion, `${COMPANION}/api/workspace/refresh`, {
  method: "POST", json: {}, headers: { origin: PRIMARY },
});
check("companion renewal from control-plane origin", renew.status === 200, `status=${renew.status}`);

// 7. File upload + list through the control plane (default fixed uploads dir)
const upload = await call(primary, `${PRIMARY}/api/sandbox/upload`, {
  method: "POST",
  json: {
    name: "public-proof.txt",
    contentBase64: Buffer.from("public upload ok").toString("base64"),
  },
  headers: { origin: PRIMARY, "x-csrf-token": csrfCookie ?? "" },
});
check("upload file", upload.status === 200 && Boolean(upload.json?.path), upload.json?.path);
check("upload lands in the fixed uploads dir", String(upload.json?.path ?? "").startsWith("/home/gem/workspace/uploads/"), upload.json?.path);
const list = await call(primary, `${PRIMARY}/api/files/list?path=${encodeURIComponent("/home/gem/workspace/uploads")}`, { headers: { origin: PRIMARY } });
const names = (list.json?.files ?? []).map((f) => f.name);
check("uploaded file visible in uploads listing", names.some((n) => n.includes("public-proof")), names.join(","));
// Do not leave the probe attachment behind in the persistent workspace.
const cleanupUpload = await call(primary, `${PRIMARY}/api/files/delete`, {
  method: "POST",
  json: { path: upload.json?.path },
  headers: { origin: PRIMARY, "x-csrf-token": csrfCookie ?? "" },
});
check("probe attachment cleaned up", upload.status !== 200 || (cleanupUpload.status === 200 && cleanupUpload.json?.ok === true), `status=${cleanupUpload.status}`);

// 8. Cross-origin write to the companion must be rejected with a real Origin header
const forgedWrite = await call(companion, `${COMPANION}/v1/shell/exec`, {
  method: "POST",
  json: { command: "touch /home/gem/pwned" },
  headers: { origin: "https://evil.example.com" },
});
check("cross-origin companion write rejected", forgedWrite.status === 403, `status=${forgedWrite.status}`);

// 9. Editor / notebook / desktop surfaces answer through the authenticated proxy
for (const surface of ["/code-server/", "/jupyter/lab", "/terminal", "/browser-ui", "/vnc/vnc.html"]) {
  const res = await call(companion, `${COMPANION}${surface}`);
  check(`surface ${surface}`, res.status < 400, `status=${res.status}`);
}

// 10. Unauthenticated companion access must be denied on every surface
const anonJar = new Jar("anon");
for (const surface of ["/terminal", "/vnc/vnc.html", "/code-server/", "/jupyter/lab", "/v1/openapi.json", "/mcp"]) {
  const res = await call(anonJar, `${COMPANION}${surface}`);
  check(`unauthenticated ${surface} denied`, res.status === 401, `status=${res.status}`);
}

// 11. Open-redirect attempt on the bootstrap target must fall back to "/"
const redirectTicket = await call(primary, `${PRIMARY}/api/workspace/ticket`, {
  method: "POST",
  json: { next: "//evil.example.com/steal" },
  headers: { origin: PRIMARY, "x-csrf-token": csrfCookie ?? "" },
});
const redirectBoot = await call(companion, redirectTicket.json?.url);
check("open redirect neutralised", redirectBoot.status === 303 && redirectBoot.headers.get("location") === "/", `location=${redirectBoot.headers.get("location")}`);

// 12. Real WebSocket upgrade on the companion origin (authenticated 101, anonymous 401)
async function wsUpgrade(url, cookie) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return await new Promise((resolve) => {
    const req = client.request({
      host: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Origin: target.origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: 20_000,
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}
const authedWs = await wsUpgrade(`${COMPANION}/v1/shell/ws`, companion.header());
check("authenticated websocket upgrade accepted", authedWs === 101, `status=${authedWs}`);
const anonWs = await wsUpgrade(`${COMPANION}/v1/shell/ws`, "");
check("unauthenticated websocket upgrade denied", anonWs === 401, `status=${anonWs}`);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
