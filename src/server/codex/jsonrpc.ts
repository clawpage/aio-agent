import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export type ServerRequestHandler = (
  method: string,
  params: unknown,
  id: number | string | null,
) => Promise<unknown> | unknown;

export interface PeerEvents {
  notification: [method: string, params: unknown];
  serverRequest: [method: string, params: unknown];
  closed: [reason: string];
  warning: [message: string];
}

/**
 * Minimal JSON-RPC 2.0 peer over a child process stdio pair.
 * Framing is newline-delimited JSON, which is what `codex app-server --listen stdio://` uses.
 */
export class JsonRpcPeer extends EventEmitter<PeerEvents> {
  #child: ChildProcess;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #handlers = new Map<string, ServerRequestHandler>();
  #fallbackHandler: ServerRequestHandler | null = null;
  #closed = false;
  #stderrTail: string[] = [];

  constructor(child: ChildProcess, label: string) {
    super();
    this.#child = child;
    this.label = label;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    // stdin can emit EPIPE asynchronously when the peer dies; without a listener
    // Node would turn that into an unhandled 'error' event and crash the server.
    child.stdin?.on("error", () => {
      this.#emitWarning("stdin error (peer likely exited)");
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (!text) return;
      this.#stderrTail.push(text);
      if (this.#stderrTail.length > 40) this.#stderrTail.shift();
    });
    child.on("exit", (code, signal) => this.#onExit(code, signal));
    child.on("error", (err) => {
      this.#emitWarning(`process error: ${err.message}`);
      this.#onExit(null, null);
    });
  }

  label: string;

  get alive(): boolean {
    return !this.#closed && this.#child.exitCode === null;
  }

  get stderrTail(): string {
    return this.#stderrTail.join("\n");
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.#handlers.set(method, handler);
  }

  onAnyServerRequest(handler: ServerRequestHandler): void {
    this.#fallbackHandler = handler;
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`${this.label} not running`));
    const id = this.#nextId++;
    const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.label} request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#child.stdin?.write(JSON.stringify(payload) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.alive) return;
    const payload: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    try {
      this.#child.stdin?.write(JSON.stringify(payload) + "\n");
    } catch {
      /* ignore write errors on a dying process */
    }
  }

  respond(id: number | string | null, result: unknown): void {
    if (id === null || id === undefined) return;
    this.#writeRaw({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string | null, code: number, message: string): void {
    if (id === null || id === undefined) return;
    this.#writeRaw({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #writeRaw(msg: JsonRpcMessage): void {
    try {
      this.#child.stdin?.write(JSON.stringify(msg) + "\n");
    } catch {
      /* ignore */
    }
  }

  #emitWarning(message: string): void {
    this.emit("warning", message);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.#emitWarning(`non-JSON line from ${this.label}: ${line.slice(0, 200)}`);
        continue;
      }
      this.#handleMessage(msg);
    }
  }

  #handleMessage(msg: JsonRpcMessage): void {
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      void this.#handleServerRequest(msg);
      return;
    }
    if (msg.method) {
      this.emit("notification", msg.method, msg.params);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const key = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  async #handleServerRequest(msg: JsonRpcMessage): Promise<void> {
    const method = msg.method as string;
    this.emit("serverRequest", method, msg.params);
    const handler = this.#handlers.get(method) ?? this.#fallbackHandler;
    if (!handler) {
      this.respondError(msg.id ?? null, -32601, `no handler for ${method}`);
      return;
    }
    try {
      const result = await handler(method, msg.params, msg.id ?? null);
      this.respond(msg.id ?? null, result ?? {});
    } catch (err) {
      this.respondError(msg.id ?? null, -32000, err instanceof Error ? err.message : String(err));
    }
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.label} exited during ${pending.method}`));
    }
    this.#pending.clear();
    this.emit("closed", `exit code=${code} signal=${signal}`);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.label} closed during ${pending.method}`));
    }
    this.#pending.clear();
    try {
      this.#child.stdin?.end();
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      try {
        this.#child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3000);
    timer.unref?.();
  }
}
