import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, rawUpgrade, startHarness, type TestHarness } from "../helpers/harness.js";
import type { SandboxIdle } from "../../src/server/docker/idle.js";

let h: TestHarness;

/** Stands in for the idle controller: the HTTP wiring is what is under test here. */
const idle = {
  state: "parked" as string,
  calls: [] as string[],
  get managing() { return this.state !== "running"; },
  hold() { this.calls.push("hold"); return () => { this.calls.push("release"); }; },
  touch() { this.calls.push("touch"); },
  foreground() { this.calls.push("foreground"); },
  async wake() { this.calls.push("wake"); this.state = "running"; },
  async enter(wakes: boolean) {
    this.calls.push(`enter:${wakes}`);
    if (this.state === "parked" && !wakes) return false;
    await this.wake();
    return true;
  },
};

beforeAll(async () => {
  h = await startHarness();
  h.ctx.idle = idle as unknown as SandboxIdle;
  // Production routes every account (the owner included) through its runtime.
  h.ctx.runtimeForUser = async () => h.ctx;
});
afterAll(async () => {
  await h.shutdown();
});

async function workspaceCookie(): Promise<string> {
  const { cookie, csrf } = await login(h);
  const ticket = (await (await h.request("/api/workspace/ticket", {
    method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: "{}",
  })).json()) as { ticket: string };
  const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket.ticket)}`, { host: "workspace" });
  return boot.headers.getSetCookie().filter((c) => c.startsWith("pa_ws_session=")).map((c) => c.split(";")[0]).join("; ");
}

describe("whole-container idle stop over HTTP", () => {
  it("records the console in the foreground", async () => {
    const { cookie, csrf } = await login(h);
    idle.calls = [];
    const res = await h.request("/api/presence", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(idle.calls).toEqual(["foreground"]);
  });

  it("refuses a background request to a stopped container without waking it", async () => {
    const cookie = await workspaceCookie();
    idle.state = "parked";
    idle.calls = [];
    const res = await h.request("/v1/file/list", { host: "workspace", headers: { cookie } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "sandbox_parked" });
    expect(idle.calls).toEqual(["enter:false"]);
    expect(idle.state).toBe("parked");

    const socket = await rawUpgrade(h.primaryPort, "/v1/shell/ws", { Origin: `http://127.0.0.1:${h.primaryPort}`, Cookie: cookie });
    expect(socket.statusLine).toContain("503");
    expect(idle.state).toBe("parked");
  });

  it("starts a stopped container for a page load, and holds it while the request runs", async () => {
    const cookie = await workspaceCookie();
    idle.state = "parked";
    idle.calls = [];
    const res = await h.request("/v1/file/list", { host: "workspace", headers: { cookie, "sec-fetch-mode": "navigate" } });
    expect(res.status).not.toBe(503);
    await res.text();
    expect(idle.calls.slice(0, 3)).toEqual(["enter:true", "wake", "hold"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(idle.calls).toContain("release");
  });

  it("starts a stopped container before a console call the sandbox serves", async () => {
    const { cookie, csrf } = await login(h);
    idle.state = "parked";
    idle.calls = [];
    await h.request("/api/files/list", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ path: "/home/gem/workspace" }) });
    expect(idle.calls.slice(0, 2)).toEqual(["hold", "wake"]);
    // Status polls never wake it.
    idle.state = "parked";
    idle.calls = [];
    const status = await h.request("/api/status", { headers: { cookie } });
    expect(((await status.json()) as { sandbox: { idle: string } }).sandbox.idle).toBe("parked");
    expect(idle.calls).toEqual([]);
  });
});
