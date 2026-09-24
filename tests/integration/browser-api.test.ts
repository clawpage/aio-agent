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
