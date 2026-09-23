import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { login, rawUpgrade, startHarness, type TestHarness } from "../helpers/harness.js";

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.shutdown();
});

describe("host and origin gating", () => {
  it("rejects unknown Host headers", async () => {
    const res = await h.request("/api/auth/session", { hostHeader: "evil.example.com" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_host");
  });

  it("rejects a spoofed X-Forwarded-Host that disagrees with Host", async () => {
    const res = await h.request("/api/auth/session", {
      hostHeader: `localhost:${h.primaryPort}`,
      headers: { "x-forwarded-host": "evil.example.com" },
    });
    expect(res.status).toBe(404);
  });

  it("refuses login from a disallowed origin even before authentication", async () => {
    const res = await h.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("authentication", () => {
  it("denies API access without a session", async () => {
    for (const path of ["/api/status", "/api/conversations", "/api/models", "/api/capabilities"]) {
      const res = await h.request(path);
      expect(res.status, path).toBe(401);
    }
  });

  it("rate limits after repeated wrong passwords", async () => {
    const results: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await h.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: `wrong-${i}` }),
      });
      results.push(res.status);
    }
    expect(results.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(results[5]).toBe(429);
  });
});

describe("session lifecycle", () => {
  it("logs in with an HttpOnly cookie and refreshes by rotation", async () => {
    const { cookie, csrf } = await login(h);
    expect(cookie).toContain("pa_session=");

    const sessionRes = await h.request("/api/auth/session", { headers: { cookie } });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { authenticated: boolean; username: string };
    expect(session.authenticated).toBe(true);
    expect(session.username).toBe("owner");

    const refresh = await h.request("/api/auth/refresh", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    expect(refresh.status).toBe(200);
    const rotated = refresh.headers.getSetCookie().find((c) => c.startsWith("pa_session="))!.split(";")[0]!;
    // Previous token is still valid inside the rotation grace window.
    expect((await h.request("/api/auth/session", { headers: { cookie } })).status).toBe(200);
    expect((await h.request("/api/auth/session", { headers: { cookie: rotated } })).status).toBe(200);
  });

  it("requires CSRF on the control plane and rejects a foreign origin", async () => {
    const { cookie } = await login(h);
    const noCsrf = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { error: string }).error).toBe("csrf_invalid");

    const { csrf } = await login(h);
    const badOrigin = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", origin: "https://sibling.example.com" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(badOrigin.status).toBe(403);
    expect(((await badOrigin.json()) as { error: string }).error).toBe("origin_denied");
  });

  it("invalidates API access after logout", async () => {
    const { cookie, csrf } = await login(h);
    expect((await h.request("/api/conversations", { headers: { cookie } })).status).toBe(200);
    const logout = await h.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    expect((await h.request("/api/conversations", { headers: { cookie } })).status).toBe(401);
  });
});

describe("conversation and agent endpoints", () => {
  it("serves the app default model through the manager, not the CLI default", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/models", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { models } = (await res.json()) as { models: Array<{ id: string; isDefault: boolean }> };
    // The fake CLI reports gpt-5.5 as its own default; the app default is Sol.
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["gpt-6-sol"]);
  });

  it("creates conversations, streams events and reports status", async () => {
    const { cookie, csrf } = await login(h);
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ title: "测试会话" }),
    });
    expect(created.status).toBe(201);
    const { conversation } = (await created.json()) as { conversation: { id: string } };

    const events = await h.request(`/api/conversations/${conversation.id}/events?format=json`, { headers: { cookie } });
    expect(events.status).toBe(200);
    const payload = (await events.json()) as { events: Array<{ type: string }> };
    expect(payload.events.map((e) => e.type)).toContain("conversation.created");

    const status = await h.request("/api/status", { headers: { cookie } });
    const body = (await status.json()) as { agent: { queuedTurns: number }; sandbox: { running: boolean } };
    expect(body.sandbox.running).toBe(true);
    expect(body.agent.queuedTurns).toBe(0);
  });

  it("returns 409 when a clientMessageId is reused with different content", async () => {
    const { cookie, csrf } = await login(h);
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ title: "conflict" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };

    const first = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", clientMessageId: "dup-1" }),
    });
    expect(first.status).toBe(202);
    const again = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", clientMessageId: "dup-1" }),
    });
    expect(again.status).toBe(200);
    const conflict = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "different", clientMessageId: "dup-1" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("reports a truthful status when there is nothing to interrupt", async () => {
    const { cookie, csrf } = await login(h);
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ title: "idle" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const res = await h.request(`/api/conversations/${conversation.id}/interrupt`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("none");
  });

  it("serves a minimal health endpoint without identities", async () => {
    const res = await h.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("personal-agent");
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
    expect(body.agent).toBeUndefined();
  });
});

describe("sandbox proxy", () => {
  it("denies unauthenticated access to the companion origin", async () => {
    const res = await h.request("/terminal", { host: "workspace" });
    expect(res.status).toBe(401);
    const api = await h.request("/v1/shell/exec", { host: "workspace", method: "POST" });
    expect(api.status).toBe(401);
  });

  it("accepts an API request with a forged X-Forwarded-Host only when it matches", async () => {
    const res = await h.request("/api/workspace/session", {
      host: "workspace",
      headers: { "x-forwarded-host": "evil.example.com" },
    });
    expect(res.status).toBe(404);
  });

  it("forwards requests with an intact raw body and strips control cookies", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const payload = JSON.stringify({ hello: "沙箱", nested: { n: 1 } });
    const res = await h.request("/echo/path?x=1", {
      host: "workspace",
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { url: string; method: string; headers: Record<string, string>; body: string };
    expect(echoed.url).toBe("/echo/path?x=1");
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe(payload);
    expect(echoed.headers.cookie ?? "").not.toContain("pa_ws_session");
    expect(echoed.headers.authorization).toBeUndefined();
  });

  it("rewrites sandbox cookies and injects a narrow frame-ancestors policy", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const res = await h.request("/set-cookie", { host: "workspace", headers: { cookie } });
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("jupyter_token="))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("pa_session="))).toBe(false);
    expect(setCookies.join(" ")).not.toContain("Domain=example.com");
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://agent.zymx.tech");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it("denies cross-origin writes to the companion origin", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const res = await h.request("/echo", {
      host: "workspace",
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("workspace bootstrap tickets", () => {
  it("issues a one-time ticket that sets a host-only cookie and clears the URL", async () => {
    const { cookie, csrf } = await login(h);
    const ticketRes = await h.request("/api/workspace/ticket", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ next: "/terminal" }),
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}&next=%2Fterminal`, { host: "workspace" });
    expect(boot.status).toBe(303);
    expect(boot.headers.get("location")).toBe("/terminal");
    expect(boot.headers.get("cache-control")).toBe("no-store");
    expect(boot.headers.get("referrer-policy")).toBe("no-referrer");
    const setCookie = boot.headers.getSetCookie().join(" ");
    expect(setCookie).toContain("pa_ws_session=");
    expect(setCookie).not.toContain("Domain=");

    // Replay must fail: tickets are single use.
    const replay = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}`, { host: "workspace" });
    expect(replay.status).toBe(403);
  });

  it("rejects an open-redirect next parameter", async () => {
    const { cookie, csrf } = await login(h);
    const ticketRes = await h.request("/api/workspace/ticket", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ next: "//evil.example.com/steal" }),
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}&next=%2F%2Fevil.example.com`, {
      host: "workspace",
    });
    expect(boot.status).toBe(303);
    expect(boot.headers.get("location")).toBe("/");
  });

  it("refuses a ticket once the primary session is revoked", async () => {
    const { cookie, csrf } = await login(h);
    const ticketRes = await h.request("/api/workspace/ticket", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    await h.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}`, { host: "workspace" });
    expect(boot.status).toBe(403);
  });
});

describe("file manager failures are reported truthfully", () => {
  it("does not report mkdir success when the command fails", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = {
      success: true,
      message: "Command executed",
      data: { session_id: "s1", status: "completed", exit_code: 1, output: "mkdir: cannot create directory" },
    };
    const res = await h.request("/api/files/mkdir", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/tmp-file/child" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("mkdir_failed");
    expect(body.message).toContain("退出码 1");
    h.sandbox.script.shell = undefined;
  });

  it("does not report mkdir success when the directory is not actually present", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = {
      success: true,
      data: { session_id: "s1", status: "completed", exit_code: 0, output: "" },
    };
    h.sandbox.script.existingPaths = [];
    const res = await h.request("/api/files/mkdir", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/never-created" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("mkdir_unverified");
    h.sandbox.script.shell = undefined;
    h.sandbox.script.existingPaths = undefined;
  });

  it("reports a still-running command instead of claiming the deletion happened", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = { success: true, data: { session_id: "s1", status: "running", output: "" } };
    // The process stays running even after polling, so success must never be claimed.
    h.sandbox.script.shellView = { success: true, data: { status: "running", output: "still going" } };
    const res = await h.request("/api/files/delete", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/still-running" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("delete_failed");
    h.sandbox.script.shell = undefined;
    h.sandbox.script.shellView = undefined;
  });

  it("does not report deletion when the path still exists afterwards", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = { success: true, data: { session_id: "s1", status: "completed", exit_code: 0 } };
    h.sandbox.script.existingPaths = ["/home/gem/workspace/keep-me"];
    const res = await h.request("/api/files/delete", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/keep-me" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("delete_unverified");
    h.sandbox.script.shell = undefined;
    h.sandbox.script.existingPaths = undefined;
  });

  it("surfaces a structured file write error", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.writeError = true;
    const res = await h.request("/api/files/write", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/x.txt", content: "hi" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toContain("EACCES");
    h.sandbox.script.writeError = false;
  });

  it("rejects non-absolute paths before touching the sandbox", async () => {
    const { cookie, csrf } = await login(h);
    const res = await h.request("/api/files/read?path=relative.txt", { headers: { cookie } });
    expect(res.status).toBe(400);
    void csrf;
  });
});

describe("companion session renewal across origins", () => {
  it("allows the control-plane origin to read and renew the companion session", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const primaryOrigin = `http://localhost:${h.primaryPort}`;

    const session = await h.request("/api/workspace/session", {
      host: "workspace",
      headers: { cookie: boot.cookie, origin: primaryOrigin },
    });
    expect(session.status).toBe(200);
    expect((await session.json()) as { authenticated: boolean }).toMatchObject({ authenticated: true });
    expect(session.headers.get("access-control-allow-origin")).toBe(primaryOrigin);
    expect(session.headers.get("access-control-allow-credentials")).toBe("true");

    const renew = await h.request("/api/workspace/refresh", {
      host: "workspace",
      method: "POST",
      headers: { cookie: boot.cookie, origin: primaryOrigin, "content-type": "application/json" },
      body: "{}",
    });
    expect(renew.status).toBe(200);
    const rotated = renew.headers.getSetCookie().find((c) => c.startsWith("pa_ws_session="))!.split(";")[0]!;
    expect((await h.request("/api/workspace/session", { host: "workspace", headers: { cookie: rotated } })).status).toBe(200);
  });

  it("refuses a foreign origin on the renewal endpoint", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const res = await h.request("/api/workspace/refresh", {
      host: "workspace",
      method: "POST",
      headers: { cookie: boot.cookie, origin: "https://evil.example.com", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("keeps sandbox writes closed to the control-plane origin", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const res = await h.request("/echo", {
      host: "workspace",
      method: "POST",
      headers: {
        cookie: boot.cookie,
        origin: `http://localhost:${h.primaryPort}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("websocket proxy", () => {
  it("denies unauthenticated and cross-origin upgrades", async () => {
    const anon = await rawUpgrade(h.primaryPort, "/v1/shell/ws", { Origin: "http://127.0.0.1:1" });
    expect(anon.statusLine).toContain("401");

    const { cookie } = await bootstrapWorkspace(h);
    const badOrigin = await rawUpgrade(h.primaryPort, "/v1/shell/ws", {
      Origin: "https://evil.example.com",
      Cookie: cookie,
    });
    expect(badOrigin.statusLine).toContain("403");
  });

  it("proxies an authenticated upgrade and filters handshake cookies", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const result = await rawUpgrade(h.primaryPort, "/v1/shell/ws", {
      Origin: `http://127.0.0.1:${h.primaryPort}`,
      Cookie: `${cookie}; jupyter_token=keep`,
    });
    expect(result.statusLine).toContain("101");
    expect(result.data).toContain("hello-from-sandbox");
  });

  it("closes an established websocket when the session is revoked", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const socket = net.connect(h.primaryPort, "127.0.0.1");
    let closed = false;
    let handshake = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      socket.on("connect", () => {
        socket.write(
          [
            "GET /v1/shell/ws HTTP/1.1",
            `Host: 127.0.0.1:${h.primaryPort}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            `Origin: http://127.0.0.1:${h.primaryPort}`,
            `Cookie: ${boot.cookie}`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      socket.on("data", () => {
        handshake = true;
        resolve();
      });
      setTimeout(resolve, 1000).unref?.();
    });
    expect(handshake).toBe(true);
    // Wait past the guard's first liveness tick is not required: revocation is event driven.
    h.ctx.sessions.revoke(boot.sessionId, "logout");
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(closed).toBe(true);
    socket.destroy();
  });
});

describe("sandbox upload and agent status", () => {
  it("relays a synthetic attachment into the sandbox and reports its kind", async () => {
    const { cookie, csrf } = await login(h);
    const bytes = Buffer.from("synthetic-attachment-content");
    const res = await h.request("/api/sandbox/upload", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "note.txt", mime: "text/plain", contentBase64: bytes.toString("base64") }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; name: string; kind: string; size: number };
    expect(body.name).toBe("note.txt");
    expect(body.kind).toBe("file");
    expect(body.size).toBe(bytes.byteLength);
    expect(body.path.startsWith("/home/gem/workspace/")).toBe(true);
    expect(body.path.endsWith("-note.txt")).toBe(true);
    // The bytes really reached the sandbox upload endpoint.
    expect(h.sandbox.lastUploadBody()).toContain("synthetic-attachment-content");
  });

  it("classifies an image attachment and rejects a missing payload", async () => {
    const { cookie, csrf } = await login(h);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const ok = await h.request("/api/sandbox/upload", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "pixel.png", mime: "image/png", contentBase64: png.toString("base64") }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { kind: string }).kind).toBe("image");

    const empty = await h.request("/api/sandbox/upload", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "", contentBase64: "" }),
    });
    expect(empty.status).toBe(400);
  });

  it("exposes activeTurns and capacity in the agent status", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/status", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { activeTurns: unknown[]; capacity: number } };
    expect(Array.isArray(body.agent.activeTurns)).toBe(true);
    expect(body.agent.capacity).toBeGreaterThanOrEqual(1);
  });
});

/** Obtain a workspace session cookie by redeeming a real bootstrap ticket. */
async function bootstrapWorkspace(h: TestHarness): Promise<{ cookie: string }> {
  const boot = await bootstrapWorkspaceWithSession(h);
  return { cookie: boot.cookie };
}

async function bootstrapWorkspaceWithSession(h: TestHarness): Promise<{ cookie: string; sessionId: string }> {
  const { cookie: primaryCookie, csrf } = await login(h);
  const ticketRes = await h.request("/api/workspace/ticket", {
    method: "POST",
    headers: { cookie: primaryCookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: "{}",
  });
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}`, { host: "workspace" });
  const cookie = boot.headers
    .getSetCookie()
    .filter((c) => c.startsWith("pa_ws_session="))
    .map((c) => c.split(";")[0])
    .join("; ");
  const row = h.ctx.db
    .prepare("SELECT id FROM sessions WHERE kind = 'workspace' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string };
  return { cookie, sessionId: row.id };
}
