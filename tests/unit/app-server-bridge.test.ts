import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { APP_SERVER_BRIDGE_JS } from "../../src/control/codex/appServerBridge.js";
import { SandboxCodexSession } from "../../src/control/codex/sandboxCodex.js";
import type { SandboxContainer } from "../../src/control/sandbox/container.js";
import type { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig } from "../helpers/harness.js";

/**
 * A stand-in for `codex app-server`: answers requests, counts `initialize`, and on
 * `emit` sends what it is asked to, now or after a delay (as a running turn would
 * while no control plane is attached).
 */
const FAKE_CODEX = String.raw`
let buf = "", inits = 0; const answered = [];
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
function handle(m) {
  if (m.method === undefined) { answered.push(m); return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") { inits++; out({ jsonrpc: "2.0", id: m.id, result: { userAgent: "fake" } }); return; }
  if (m.method === "model/list") { setTimeout(() => out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "th", turn: { id: "turn-9", status: "completed" } } }), 300); out({ jsonrpc: "2.0", id: m.id, result: { data: [] } }); return; }
  if (m.method === "stats") { out({ jsonrpc: "2.0", id: m.id, result: { inits, answered } }); return; }
  if (m.method === "emit") { setTimeout(() => { for (const x of m.params.messages) out(x); }, m.params.delayMs || 0); out({ jsonrpc: "2.0", id: m.id, result: { ok: true } }); return; }
  out({ jsonrpc: "2.0", id: m.id, result: { echo: m.params } });
}
`;

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-bridge-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "bridge.mjs"), APP_SERVER_BRIDGE_JS);
  fs.writeFileSync(path.join(dir, "codex.mjs"), FAKE_CODEX);
  return { dir, bridge: path.join(dir, "bridge.mjs"), sock: path.join(dir, "b.sock") };
}

/** One control plane's attachment: send lines, and read what comes back. */
function attach(bridge: string, sock: string) {
  const child = spawn(process.execPath, [bridge, "attach", sock], { stdio: ["pipe", "pipe", "inherit"] });
  procs.push(child);
  const got: any[] = [];
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (c: string) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    got, child, exited,
    send: (m: unknown) => child.stdin!.write(JSON.stringify(m) + "\n"),
    waitFor: async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 200; i++) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
      throw new Error("timed out: " + JSON.stringify(got));
    },
  };
}

it("keeps Codex running for the next control plane, replaying what it did not acknowledge", async () => {
  const { dir, bridge, sock } = setup();
  const serve = spawn(process.execPath, [bridge, "serve", sock, "key-1", "--", process.execPath, path.join(dir, "codex.mjs")], { stdio: "ignore" });
  procs.push(serve);
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));

  const first = attach(bridge, sock);
  first.send({ jsonrpc: "2.0", method: "aio/bridge/attach", params: { after: 0 } });
  expect((await first.waitFor((m) => m.method === "aio/bridge/hello")).params).toMatchObject({ key: "key-1", fresh: true, gap: false });
  first.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(await first.waitFor((m) => m.id === 1)).toMatchObject({ result: { userAgent: "fake" } });
  first.send({ jsonrpc: "2.0", method: "initialized" });
  // Two notifications and an approval now, one more after this control plane has gone.
  first.send({ jsonrpc: "2.0", id: 2, method: "emit", params: { messages: [
    { jsonrpc: "2.0", method: "item/started", params: { n: 1 } },
    { jsonrpc: "2.0", method: "item/completed", params: { n: 2 } },
    { jsonrpc: "2.0", id: 900, method: "item/tool/requestUserInput", params: { n: 3 } },
  ] } });
  const approval = await first.waitFor((m) => m.id === 900);
  expect(approval.aioSeq).toBe(3);
  first.send({ jsonrpc: "2.0", method: "aio/bridge/ack", params: { seq: 1 } });
  first.send({ jsonrpc: "2.0", id: 3, method: "emit", params: { delayMs: 300, messages: [{ jsonrpc: "2.0", method: "turn/completed", params: { n: 4 } }] } });
  await first.waitFor((m) => m.id === 3);
  // A request still waiting when it goes: its answer must not reach the next one under the same id.
  first.send({ jsonrpc: "2.0", id: 4, method: "emit", params: { delayMs: 200, messages: [] } });
  first.child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));

  const second = attach(bridge, sock);
  second.send({ jsonrpc: "2.0", method: "aio/bridge/attach", params: { after: 0 } });
  expect((await second.waitFor((m) => m.method === "aio/bridge/hello")).params).toMatchObject({ key: "key-1", fresh: false, gap: false });
  await second.waitFor((m) => m.method === "turn/completed");
  // Unacknowledged ones again, in order, with the unanswered approval; not the acknowledged one.
  expect(second.got.filter((m) => m.aioSeq).map((m) => m.aioSeq)).toEqual([2, 3, 4]);
  second.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(await second.waitFor((m) => m.id === 1 && m.result)).toMatchObject({ result: { userAgent: "fake" } });
  second.send({ jsonrpc: "2.0", id: 900, result: { answers: {} } });
  second.send({ jsonrpc: "2.0", id: 4, method: "stats", params: {} });
  const stats = await second.waitFor((m) => m.id === 4 && m.result?.inits !== undefined);
  // Codex was initialized once, got the approval's answer, and the new id 4 got its own reply only.
  expect(stats.result).toEqual({ inits: 1, answered: [{ jsonrpc: "2.0", id: 900, result: { answers: {} } }] });
  expect(second.got.filter((m) => m.id === 4)).toHaveLength(1);

  // Retiring stops Codex and the bridge.
  const gone = new Promise((resolve) => serve.on("exit", resolve));
  second.send({ jsonrpc: "2.0", method: "aio/bridge/retire" });
  await gone;
  expect(fs.existsSync(sock)).toBe(false);
});

it("lets the control plane know at once when no bridge serves", async () => {
  const { bridge, sock } = setup();
  expect(await attach(bridge, sock).exited).toBe(3);
});

it("lets the next control plane's session join the same Codex, and rejoins it when only the connection broke", async () => {
  const { dir, bridge, sock } = setup();
  let attached: ChildProcess | null = null;
  // While sandboxd restarts, nothing in the sandbox can be reached.
  let nodeDown = false;
  const container = {
    codexAppServerArgv: () => [process.execPath, path.join(dir, "codex.mjs")],
    startCodexBridge: async (_extra: string[], _env: Record<string, string>, key: string) => {
      if (nodeDown) throw new Error("fetch failed");
      const serve = spawn(process.execPath, [bridge, "serve", sock, key, "--", process.execPath, path.join(dir, "codex.mjs")], { stdio: "ignore" });
      procs.push(serve);
      return { code: 0, stdout: "", stderr: "" };
    },
    attachCodexBridge: () => {
      if (nodeDown) { const gone = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] }); procs.push(gone); return gone; }
      attached = spawn(process.execPath, [bridge, "attach", sock], { stdio: ["pipe", "pipe", "pipe"] }); procs.push(attached); return attached;
    },
  } as unknown as SandboxContainer;
  const cfg = testConfig(dir, 1, {});
  cfg.hostCodex = { ...cfg.hostCodex, enabled: false };
  const session = () => {
    const s = new SandboxCodexSession(cfg, new Logger("error", undefined, false), container, {} as HostTokenSource);
    const seen: string[] = [];
    const closed: string[] = [];
    s.onNotification((method) => seen.push(method));
    s.onClosed((reason) => closed.push(reason));
    return { s, seen, closed };
  };

  const before = session();
  expect(before.s.reattaches).toBe(true);
  await before.s.listModels();
  expect(before.s.reattached).toBe(false);
  // The control plane stops while Codex is still working; what Codex says meanwhile waits in the bridge.
  before.s.close();
  await new Promise((r) => setTimeout(r, 500));
  expect(before.seen).not.toContain("turn/completed");

  const after = session();
  await after.s.start();
  expect(after.s.reattached).toBe(true);
  expect(after.s.stale).toBe(false);
  await waitUntil(() => after.seen.includes("turn/completed"));

  // Only the connection breaks: the session joins the same Codex again without giving its turns up.
  const broken = attached!;
  broken.kill("SIGKILL");
  await waitUntil(() => attached !== broken && after.s.ready);
  await after.s.listModels();
  expect(after.s.reattached).toBe(true);
  expect(after.closed).toEqual([]);

  // sandboxd itself restarts: the connection breaks and the sandbox stays out of reach for a while.
  nodeDown = true;
  const cut = attached!;
  cut.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 1_500));
  nodeDown = false;
  await waitUntil(() => attached !== cut && after.s.ready);
  expect(after.s.reattached).toBe(true);
  expect(after.closed).toEqual([]);
  after.s.restartIdle();
});

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 250 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
}
