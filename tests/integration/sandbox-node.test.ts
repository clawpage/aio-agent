import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { Logger } from "../../src/common/logger.js";
import type { ExecResult } from "../../src/common/protocol.js";
import { createSandboxd } from "../../src/sandbox/server.js";
import { SandboxDriver } from "../../src/sandbox/driver.js";
import type { DockerCli } from "../../src/sandbox/docker.js";
import { SandboxNode } from "../../src/control/sandbox/node.js";

const TOKEN = "t".repeat(48);
const NAME = "aio-user-node-test";

/** `docker exec <flags> <name> argv...` -> the argv, run on this machine instead of in a container. */
function parseExec(args: string[]): string[] {
  let i = 1;
  while (i < args.length && args[i]!.startsWith("-")) i += ["-u", "-w", "-e"].includes(args[i]!) ? 2 : 1;
  return args.slice(i + 1);
}

/** A docker CLI whose one managed container is this machine, publishing `webPort`. */
class LocalDocker {
  constructor(private webPort: number) {}
  async run(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    if (args[0] === "inspect" && args[2]!.startsWith("{{json .State}}")) {
      return { code: args.at(-1) === NAME ? 0 : 1, stdout: args.at(-1) === NAME ? `{"Status":"running"}|img|1|[]` : "", stderr: "" };
    }
    if (args[0] === "inspect") return { code: 0, stdout: String(this.webPort), stderr: "" };
    if (args[0] === "exec") {
      const argv = parseExec(args);
      return await new Promise((resolve) => {
        const child = execFile(argv[0]!, argv.slice(1), { env: { ...process.env, ...opts.env } }, (err, stdout, stderr) =>
          resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
        );
        child.stdin?.end(opts.stdin ?? "");
      });
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  }
  spawn(args: string[], env: Record<string, string> = {}): ChildProcess {
    const argv = parseExec(args);
    return spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  }
}

let web: http.Server;
let sandboxd: http.Server;
let node: SandboxNode;
let base: string;
const seenHeaders: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  // The sandbox's own web port: an echo of what reached it, plus a WebSocket echo.
  web = http.createServer((req, res) => {
    seenHeaders.push(req.headers);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] }).end(JSON.stringify({ url: req.url, method: req.method, body })));
  });
  const wss = new WebSocketServer({ server: web });
  wss.on("connection", (ws, req) => {
    seenHeaders.push(req.headers);
    ws.on("message", (m) => ws.send(`echo:${String(m)}`));
  });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const webPort = (web.address() as AddressInfo).port;
  const log = new Logger("error", undefined, false);
  const driver = new SandboxDriver(
    { port: 0, bind: "127.0.0.1", tokenFile: "", images: ["img"], containerHost: "127.0.0.1", addHostGateway: false, logDir: null, gateway: null },
    log,
    new LocalDocker(webPort) as unknown as DockerCli,
  );
  sandboxd = createSandboxd({ driver, log, token: TOKEN, version: "9.9.9" });
  await new Promise<void>((resolve) => sandboxd.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(sandboxd.address() as AddressInfo).port}`;
  node = new SandboxNode("local", base, TOKEN);
});

afterAll(() => {
  sandboxd.closeAllConnections();
  sandboxd.close();
  web.closeAllConnections();
  web.close();
});

describe("control plane <-> sandbox node", () => {
  it("answers liveness openly, everything else only with the node token and a compatible protocol", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/version`)).status).toBe(401);
    expect((await fetch(`${base}/v1/node`, { headers: { "x-aio-node-token": TOKEN } })).status).toBe(409);
    expect((await fetch(`${base}/v1/node`, { headers: { "x-aio-node-token": TOKEN, "x-aio-protocol": "2-3" } })).status).toBe(409);
    expect(await node.check(0)).toEqual({ ok: true, version: "9.9.9", protocol: 1, error: null });
    const info = await node.info();
    expect(info).toMatchObject({ component: "sandbox", protocol: 1 });
    expect(await new SandboxNode("local", base, "x".repeat(48)).check(0)).toMatchObject({ ok: false, version: null });
  });

  it("refuses a node that speaks a protocol this control plane cannot drive", async () => {
    const odd = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ component: "sandbox", version: "0.0.1", protocol: 99 })));
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    try {
      const result = await new SandboxNode("old", `http://127.0.0.1:${(odd.address() as AddressInfo).port}`, TOKEN).check(0);
      expect(result).toMatchObject({ ok: false, protocol: 99 });
      expect(result.error).toContain("不在本控制面支持");
    } finally {
      odd.close();
    }
  });

  it("runs one-shot commands with stdin and secret env, and refuses unmanaged names and bad specs", async () => {
    const res = await node.exec(NAME, { argv: ["sh", "-c", 'printf "%s|" "$KEY"; cat'], user: "gem", env: { KEY: "s3cret" }, stdin: "from-stdin" });
    expect(res).toEqual({ code: 0, stdout: "s3cret|from-stdin", stderr: "" });
    await expect(node.exec("someone-else", { argv: ["id"], user: "gem" })).rejects.toThrow("不存在");
    await expect(node.exec(NAME, { argv: ["id"], user: "gem --privileged" })).rejects.toThrow("用户");
    await expect(
      node.ensure(NAME, { spec: { name: NAME, image: "alpine:latest", hostPort: 18099, workspaceVolume: "w", codexVolume: "c", browserVolume: "b", containerWorkspaceDir: "/w", containerCodexHome: "/c", containerUser: "gem", extraEnv: [] }, readyTimeoutMs: 1000 }),
    ).rejects.toThrow("不在本节点允许");
  });

  it("streams a long-lived command both ways and reports its exit like a child process", async () => {
    const child = node.spawn(NAME, { argv: ["sh", "-c", 'cat; echo "done:$KEY" >&2; exit 3'], user: "gem", env: { KEY: "k1" } });
    let out = "";
    let err = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (c: string) => (out += c));
    child.stderr!.on("data", (c: string) => (err += c));
    // Written before the socket is even open: nothing may be lost.
    child.stdin!.write("line one\n");
    child.stdin!.end("line two\n");
    const [code] = await new Promise<[number | null, string | null]>((resolve) => child.on("close", (c, s) => resolve([c, s])));
    expect(code).toBe(3);
    expect(child.exitCode).toBe(3);
    expect(out).toBe("line one\nline two\n");
    expect(err).toBe("done:k1\n");
  });

  it("ends the command when the control plane goes away", async () => {
    const child = node.spawn(NAME, { argv: ["sleep", "30"], user: "gem" });
    await new Promise((resolve) => child.once("spawn", resolve));
    const started = Date.now();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", resolve));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("proxies HTTP to the sandbox's web port without leaking the node's own headers", async () => {
    const res = await node.fetch(NAME, "/v1/file/read?x=1", { method: "POST", body: "payload", headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "/v1/file/read?x=1", method: "POST", body: "payload" });
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    const seen = seenHeaders.at(-1)!;
    expect(seen["x-aio-node-token"]).toBeUndefined();
    expect(seen["x-aio-sandbox"]).toBeUndefined();
    expect(seen["x-aio-protocol"]).toBeUndefined();
    // Without the token the proxy is closed like everything else.
    expect((await fetch(`${base}/v1/file/read`, { headers: { "x-aio-sandbox": NAME } })).status).toBe(401);
  });

  it("proxies WebSocket upgrades the same way", async () => {
    const upstream = node.upstream(NAME);
    const url = new URL("v1/shell/ws?session_id=abc", upstream.url);
    url.protocol = "ws:";
    const ws = new WebSocket(url, { headers: upstream.headers });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    ws.close();
    expect(reply).toBe("echo:hi");
    expect(seenHeaders.at(-1)!["x-aio-node-token"]).toBeUndefined();
    const denied = new WebSocket(url, { headers: { "x-aio-sandbox": NAME } });
    const status = await new Promise<number>((resolve) => denied.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });
});
