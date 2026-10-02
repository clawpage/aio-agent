import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import WebSocket from "ws";
import {
  NODE_TOKEN_HEADER,
  PROTOCOL_HEADER,
  SANDBOX_HEADER,
  STREAM_STDERR,
  STREAM_STDOUT,
  type ContainerState,
  type EnsureRequest,
  type ExecRequest,
  type ExecResult,
  type NodeInfo,
  type NodeVersion,
  type SpawnServerMessage,
} from "../../common/protocol.js";
import { SANDBOX_PROTOCOL_MAX, SANDBOX_PROTOCOL_MIN, sandboxCompatible } from "../../common/version.js";

/** Where and how to reach one sandbox's web port through its node. */
export interface SandboxUpstream {
  url: URL;
  headers: Record<string, string>;
}

/** The outcome of the last version check against a node. */
export interface NodeCompatibility {
  ok: boolean;
  version: string | null;
  protocol: number | null;
  error: string | null;
}

/**
 * The control plane's connection to one sandbox node (sandboxd). Everything the
 * control plane does to a container goes through here: fixed operations as
 * JSON calls, streamed commands over a WebSocket, and web traffic through the
 * node's proxy. See common/protocol.ts.
 */
export class SandboxNode {
  readonly name: string;
  readonly url: URL;
  #token: string;
  #compat: NodeCompatibility | null = null;
  #checkedAt = 0;

  constructor(name: string, url: string, token: string) {
    this.name = name;
    this.url = new URL(url.endsWith("/") ? url : `${url}/`);
    this.#token = token;
  }

  headers(): Record<string, string> {
    return { [NODE_TOKEN_HEADER]: this.#token, [PROTOCOL_HEADER]: `${SANDBOX_PROTOCOL_MIN}-${SANDBOX_PROTOCOL_MAX}` };
  }

  /** Version handshake, cached for `maxAgeMs`; an unreachable node is not "incompatible", only unknown. */
  async check(maxAgeMs = 30_000): Promise<NodeCompatibility> {
    if (this.#compat && Date.now() - this.#checkedAt < maxAgeMs) return this.#compat;
    try {
      const v = await this.#call<NodeVersion>("GET", "v1/version", undefined, 10_000);
      const ok = v.component === "sandbox" && sandboxCompatible(v.protocol, SANDBOX_PROTOCOL_MIN, SANDBOX_PROTOCOL_MAX);
      this.#compat = { ok, version: v.version, protocol: v.protocol, error: ok ? null : `沙箱节点 ${this.name} 的协议 ${v.protocol} 不在本控制面支持的 ${SANDBOX_PROTOCOL_MIN}-${SANDBOX_PROTOCOL_MAX} 内` };
    } catch (err) {
      this.#compat = { ok: false, version: null, protocol: null, error: `沙箱节点 ${this.name} 无法连接：${err instanceof Error ? err.message : String(err)}` };
    }
    this.#checkedAt = Date.now();
    return this.#compat;
  }

  info(): Promise<NodeInfo> {
    return this.#call("GET", "v1/node", undefined, 20_000);
  }

  ensure(name: string, req: EnsureRequest): Promise<ContainerState> {
    return this.#call("POST", `v1/sandboxes/${encodeURIComponent(name)}/ensure`, req, req.readyTimeoutMs + 300_000);
  }

  inspect(name: string): Promise<ContainerState> {
    return this.#call("GET", `v1/sandboxes/${encodeURIComponent(name)}`, undefined, 20_000);
  }

  async stop(name: string): Promise<void> {
    await this.#call("POST", `v1/sandboxes/${encodeURIComponent(name)}/stop`, {}, 90_000);
  }

  restart(name: string, readyTimeoutMs: number): Promise<ContainerState> {
    return this.#call("POST", `v1/sandboxes/${encodeURIComponent(name)}/restart`, { readyTimeoutMs }, readyTimeoutMs + 200_000);
  }

  async peerPorts(name: string, ports: number[]): Promise<void> {
    await this.#call("POST", `v1/sandboxes/${encodeURIComponent(name)}/peer-ports`, { ports }, 90_000);
  }

  exec(name: string, req: ExecRequest): Promise<ExecResult> {
    return this.#call("POST", `v1/sandboxes/${encodeURIComponent(name)}/exec`, req, (req.timeoutMs ?? 60_000) + 15_000);
  }

  /** A command streamed through the node, shaped like a local child process. */
  spawn(name: string, req: Omit<ExecRequest, "stdin" | "timeoutMs" | "detached">): ChildProcess {
    const ws = new URL(`v1/sandboxes/${encodeURIComponent(name)}/spawn`, this.url);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    return new RemoteProcess(ws.toString(), this.headers(), req) as unknown as ChildProcess;
  }

  upstream(name: string): SandboxUpstream {
    return { url: this.url, headers: { ...this.headers(), [SANDBOX_HEADER]: name } };
  }

  /** `fetch` against the sandbox's own web port, through the node. */
  async fetch(name: string, pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(this.upstream(name).headers)) headers.set(k, v);
    return await fetch(new URL(pathname.replace(/^\//, ""), this.url), { ...init, headers });
  }

  async #call<T>(method: string, pathname: string, body: unknown, timeoutMs: number): Promise<T> {
    const res = await fetch(new URL(pathname, this.url), {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* a proxy in between answered */
    }
    if (!res.ok) {
      const message = (parsed as { message?: string } | null)?.message;
      throw new Error(message || `沙箱节点 ${this.name} 返回 HTTP ${res.status}`);
    }
    return parsed as T;
  }
}

/**
 * A command running inside a sandbox, streamed over a WebSocket and presented
 * like a ChildProcess (stdin/stdout/stderr streams, `exit`/`close`/`error`,
 * `exitCode`, `kill`). Losing the connection ends it like a closed pipe would.
 */
class RemoteProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  #ws: WebSocket;
  #queue: Array<string | Buffer> = [];
  #ended = false;

  constructor(url: string, headers: Record<string, string>, req: Omit<ExecRequest, "stdin" | "timeoutMs" | "detached">) {
    super();
    this.#ws = new WebSocket(url, { headers, maxPayload: 64 * 1024 * 1024 });
    this.#queue.push(JSON.stringify({ type: "start", ...req }));
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, done) => {
        this.#send(Buffer.from(chunk));
        done();
      },
      final: (done) => {
        this.#send(JSON.stringify({ type: "eof" }));
        done();
      },
    });
    this.#ws.on("open", () => {
      for (const m of this.#queue.splice(0)) this.#ws.send(m);
      this.emit("spawn");
    });
    this.#ws.on("message", (data, binary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (binary) {
        if (buf[0] === STREAM_STDOUT) this.stdout.write(buf.subarray(1));
        else if (buf[0] === STREAM_STDERR) this.stderr.write(buf.subarray(1));
        return;
      }
      let msg: SpawnServerMessage;
      try {
        msg = JSON.parse(buf.toString("utf8")) as SpawnServerMessage;
      } catch {
        return;
      }
      if (msg.type === "exit") this.#end(msg.code, (msg.signal as NodeJS.Signals | null) ?? null);
      else if (msg.type === "error") {
        this.emit("error", new Error(msg.message));
        this.#end(null, "SIGHUP");
      }
    });
    this.#ws.on("error", (err) => {
      if (!this.#ended) this.emit("error", err);
    });
    this.#ws.on("close", () => this.#end(null, "SIGHUP"));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#ended) return false;
    this.killed = true;
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ type: "kill", signal: typeof signal === "number" ? "SIGTERM" : signal }));
    else this.#ws.terminate();
    return true;
  }

  #send(message: string | Buffer): void {
    if (this.#ended) return;
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(message);
    else if (this.#ws.readyState === WebSocket.CONNECTING) this.#queue.push(message);
  }

  #end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#ended) return;
    this.#ended = true;
    this.exitCode = code;
    this.signalCode = code === null ? signal : null;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", this.exitCode, this.signalCode);
    // Like a real child: `close` after the output streams have finished.
    setImmediate(() => this.emit("close", this.exitCode, this.signalCode));
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.close();
  }
}
