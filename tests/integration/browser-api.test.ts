import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, rawUpgrade, startHarness, type TestHarness } from "../helpers/harness.js";

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.shutdown();
});

const jsonPost = (cookie: string, csrf?: string) => ({
  method: "POST" as const,
  headers: {
    cookie,
    "content-type": "application/json",
    ...(csrf ? { "x-csrf-token": csrf } : {}),
  },
});

describe("browser lifecycle API", () => {
  it("requires authentication and refuses to leak the snapshot path", async () => {
    const anon = await h.request("/api/browser/status");
    expect(anon.status).toBe(401);

    const { cookie } = await login(h);
    const res = await h.request("/api/browser/status", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: Record<string, unknown> };
    expect(body.status).toMatchObject({ enabled: expect.any(Boolean), state: expect.any(String) });
    // The snapshot path and any container message must never reach the client.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("snapshotPath");
    expect(serialized).not.toContain("/home/");
  });

  it("is a read-only poll that never wakes the browser or renews the lease", async () => {
    const { cookie } = await login(h);
    const runtime = h.browserRuntime;
    const before = { wake: runtime.calls.wake };
    const first = await h.request("/api/browser/status", { headers: { cookie } });
    const status = ((await first.json()) as { status: { leases: { calls: number; turns: number } } }).status;
    await h.request("/api/browser/status", { headers: { cookie } });
    await h.request("/api/browser/status", { headers: { cookie } });
    expect(runtime.calls.wake).toBe(before.wake);
    expect(status.leases.calls).toBe(0);
    expect(status.leases.turns).toBe(0);
  });

  it("accepts a viewer heartbeat and counts the viewer as occupancy", async () => {
    const { cookie, csrf } = await login(h);
    const res = await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ id: "win-1", generation: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generation: number; status: { viewers: number; leases: { viewers: number } } };
    expect(body.generation).toBe(1);
    expect(body.status.viewers).toBeGreaterThanOrEqual(1);

    // A second, independent window has its own lease.
    const second = await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ id: "win-2", generation: 1 }),
    });
    expect(((await second.json()) as { status: { viewers: number } }).status.viewers).toBeGreaterThanOrEqual(2);
  });

  it("rejects a heartbeat from an incarnation that was already released", async () => {
    const { cookie, csrf } = await login(h);
    await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ id: "win-late", generation: 5 }),
    });
    await h.request("/api/browser/viewer/release", { ...jsonPost(cookie, csrf), body: JSON.stringify({ id: "win-late" }) });
    // A heartbeat from the released incarnation must not resurrect the lease.
    const late = await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ id: "win-late", generation: 5 }),
    });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("stale_viewer");
    // A higher incarnation (the panel remounted) is accepted.
    const rejoined = await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ id: "win-late", generation: 6 }),
    });
    expect(rejoined.status).toBe(200);
  });

  it("requires CSRF for viewer mutation", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie),
      body: JSON.stringify({ id: "win-nocsrf", generation: 1 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_invalid");
  });

  it("drops every viewer lease the session held on logout", async () => {
    const { cookie, csrf } = await login(h);
    await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ id: "win-logout", generation: 1 }),
    });
    const before = (await (await h.request("/api/browser/status", { headers: { cookie } })).json()) as {
      status: { viewers: number };
    };
    expect(before.status.viewers).toBeGreaterThanOrEqual(1);

    await h.request("/api/auth/logout", { ...jsonPost(cookie, csrf), body: "{}" });

    // Viewers benchmarked by earlier tests belong to other sessions, so assert on
    // the delta for this session rather than a global zero.
    const again = await login(h);
    const after = (await (await h.request("/api/browser/status", { headers: { cookie: again.cookie } })).json()) as {
      status: { viewers: number };
    };
    expect(after.status.viewers).toBe(before.status.viewers - 1);
  });

  it("pins and unpins an explicit keep-alive hold", async () => {
    const { cookie, csrf } = await login(h);
    const pin = await h.request("/api/browser/pin", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ note: "手工排查" }),
    });
    expect(pin.status).toBe(200);
    const pinned = (await pin.json()) as { pin: { id: string; note: string }; status: { leases: { pins: number } } };
    expect(pinned.pin.note).toBe("手工排查");
    expect(pinned.status.leases.pins).toBeGreaterThanOrEqual(1);

    const unpin = await h.request("/api/browser/pin/release", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ id: pinned.pin.id }),
    });
    expect(((await unpin.json()) as { status: { leases: { pins: number } } }).status.leases.pins).toBe(0);
  });

  it("rejects a viewer heartbeat with no usable id", async () => {
    const { cookie, csrf } = await login(h);
    const res = await h.request("/api/browser/viewer/heartbeat", {
      ...jsonPost(cookie, csrf),
      body: JSON.stringify({ generation: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

/** Redeem a real workspace bootstrap ticket, as the companion origin does. */
async function bootstrapWorkspace(h: TestHarness): Promise<{ cookie: string }> {
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
  return { cookie };
}

describe("proxy browser lease", () => {
  it("never reserves a call lease for terminal, file or status traffic", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const before = (await statusCalls(h)).leases.calls;

    await h.request("/v1/shell/exec", { host: "workspace", method: "POST", headers: { cookie }, body: "{}" });
    await h.request("/v1/file/list", { host: "workspace", headers: { cookie } });

    // Ordinary sandbox traffic must leave the browser free to be released.
    expect((await statusCalls(h)).leases.calls).toBe(before);
  });

  it("releases the reserved lease when an upgrade is rejected on origin", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const before = (await statusCalls(h)).leases.calls;

    // A cross-origin CDP upgrade reserves a lease, then must give it back when
    // the origin check rejects the connection instead of leaking it forever.
    const denied = await rawUpgrade(h.primaryPort, "/json/version", {
      Origin: "https://evil.example.com",
      Cookie: cookie,
    });
    expect(denied.statusLine).toContain("403");

    expect((await statusCalls(h)).leases.calls).toBe(before);
  });

  it("releases the lease after a browser-bound HTTP proxy request finishes", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    await h.request("/v1/browser/tabs", { host: "workspace", headers: { cookie } });
    expect((await statusCalls(h)).leases.calls).toBe(0);
  });
});

/** Read the lease summary through the authenticated status endpoint. */
async function statusCalls(h: TestHarness): Promise<{ leases: { calls: number; turns: number; viewers: number } }> {
  const { cookie } = await login(h);
  const res = await h.request("/api/browser/status", { headers: { cookie } });
  const body = (await res.json()) as {
    status: { leases: { calls: number; turns: number; viewers: number } };
  };
  return body.status;
}

describe("proxy browser lease while the browser is being restored", () => {
  // A dedicated harness: these tests drive a real sleep/wake cycle, and the shared
  // fixture above still holds viewer leases from its own scenarios.
  let ph: TestHarness;
  beforeAll(async () => {
    ph = await startHarness();
  });
  afterAll(async () => {
    await ph?.shutdown();
  });

  /** Resolve once `promise` settles, with a hard bound so a stuck await fails loudly. */
  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
    ]);

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Poll `check` until it is true, or fail after a bound. */
  async function waitFor(check: () => Promise<boolean>, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error("condition never became true");
      await wait(10);
    }
  }

  /** A raw HTTP request whose socket this test can destroy mid-flight. */
  function openRequest(
    port: number,
    pathname: string,
    headers: Record<string, string>,
  ): { socket: import("node:net").Socket; done: Promise<string> } {
    const socket = net.connect(port, "127.0.0.1");
    const done = new Promise<string>((resolve) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      socket.on("close", () => resolve(buffer));
      socket.on("error", () => resolve(buffer));
    });
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${pathname} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Origin: http://127.0.0.1:${port}`,
          "Connection: close",
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          "",
          "",
        ].join("\r\n"),
      );
    });
    return { socket, done };
  }

  /** Run `fn` against a genuinely released browser, then leave it awake again. */
  async function whileAsleep(fn: () => Promise<void>): Promise<void> {
    const outcome = await ph.ctx.browser.sleepNow();
    expect(outcome.verdict).toBe("asleep");
    try {
      await fn();
    } finally {
      await ph.ctx.browser.wake();
    }
  }

  it("protects the raw VNC websocket path and proxies it at all", async () => {
    const { cookie } = await bootstrapWorkspace(ph);
    // `/ws` is the path the workspace VNC panel actually opens; it must reserve a
    // lease and be proxied, not rejected as an unknown path.
    const res = await rawUpgrade(ph.primaryPort, "/ws", {
      Origin: `http://127.0.0.1:${ph.primaryPort}`,
      Cookie: cookie,
    });
    expect(res.statusLine).toContain("101");
  });

  it("releases the lease exactly once when the client leaves while the browser restores", async () => {
    const { cookie } = await bootstrapWorkspace(ph);
    const before = (await statusCalls(ph)).leases.calls;
    await whileAsleep(async () => {
      // Hold the restore open: this is the window in which the proxy has reserved
      // a lease but has not opened an upstream yet.
      let releaseWake: () => void = () => undefined;
      ph.browserRuntime.wakeGate = new Promise<void>((resolve) => {
        releaseWake = resolve;
      });
      const requestsBefore = ph.sandbox.requests.length;

      const { socket, done } = openRequest(ph.primaryPort, "/v1/browser/tabs", { Cookie: cookie });
      // Wait until the proxy has actually reserved (guards are attached in the same
      // tick, right after the reserve): this is deterministic even under load,
      // unlike a fixed sleep that can elapse before the request is parsed.
      await waitFor(async () => (await statusCalls(ph)).leases.calls > before);
      socket.destroy();
      await done;
      // The local socket close precedes delivery of FIN to the server. Wait for
      // the server to observe the disconnect while the wake is still blocked.
      await waitFor(async () => (await statusCalls(ph)).leases.calls === before);

      ph.browserRuntime.wakeGate = null;
      releaseWake();
      await wait(150);

      // No ghost upstream request was started for the departed client...
      const proxied = ph.sandbox.requests.slice(requestsBefore).filter((r) => r.url.startsWith("/v1/browser/tabs"));
      expect(proxied.length).toBe(0);
    });
    // ...and the lease was handed back rather than leaked.
    expect((await statusCalls(ph)).leases.calls).toBe(before);
  });

  it("keeps terminal WebSockets usable while browser restoration is unavailable", async () => {
    const { cookie } = await bootstrapWorkspace(ph);
    await whileAsleep(async () => {
      const wakes = ph.browserRuntime.calls.wake;
      ph.browserRuntime.wakeError = "unavailable";
      try {
        const res = await rawUpgrade(ph.primaryPort, "/v1/shell/ws", {
          Origin: `http://127.0.0.1:${ph.primaryPort}`, Cookie: cookie,
        });
        expect(res.statusLine).toContain("101");
        expect(ph.browserRuntime.calls.wake).toBe(wakes);
      } finally { ph.browserRuntime.wakeError = null; }
    });
  });

  it("answers 503 and releases the lease when the restore fails", async () => {
    const { cookie } = await bootstrapWorkspace(ph);
    const before = (await statusCalls(ph)).leases.calls;
    await ph.ctx.browser.sleepNow();
    ph.browserRuntime.wakeError = "restore failed";
    try {
      const res = await ph.request("/v1/browser/tabs", { host: "workspace", headers: { cookie } });
      expect(res.status).toBe(503);
      expect((await statusCalls(ph)).leases.calls).toBe(before);
    } finally {
      ph.browserRuntime.wakeError = null;
      await ph.ctx.browser.wake();
    }
  });

  it("restores the browser for a direct CDP connection while it is asleep", async () => {
    const { cookie } = await bootstrapWorkspace(ph);
    const wakesBefore = ph.browserRuntime.calls.wake;
    await whileAsleep(async () => {
      // A direct CDP/VNC client must be able to connect to a released browser,
      // because the proxy restores it before opening upstream.
      const res = await withTimeout(
        rawUpgrade(ph.primaryPort, "/json/version", {
          Origin: `http://127.0.0.1:${ph.primaryPort}`,
          Cookie: cookie,
        }),
        4000,
      );
      expect(res.statusLine).toContain("101");
    });
    expect(ph.browserRuntime.calls.wake).toBeGreaterThan(wakesBefore);
  });
});
