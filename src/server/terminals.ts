import WebSocket from "ws";
import type { Db } from "./db.js";

/** Session ids the sandbox hands out (UUIDs); anything else never reaches a URL. */
export const TERMINAL_ID = /^[a-zA-Z0-9_-]{1,160}$/;

export interface TerminalRecord {
  id: string;
  createdAt: number;
}

const KEY = "terminal_sessions";

/**
 * The interactive terminals this console created.
 *
 * The sandbox's terminal page attaches only to sessions from
 * `/v1/shell/terminal-url`, and nothing upstream lists those (the
 * `/v1/shell/sessions` list is the agent's command shells, which the page cannot
 * open). So the runtime remembers its own. A container start ends every
 * terminal, so records older than the container's current start are dropped.
 */
export class TerminalRegistry {
  constructor(private readonly db: Db) {}

  list(containerStartedAt: string | null, running: boolean): TerminalRecord[] {
    const all = this.#read();
    const started = containerStartedAt ? Date.parse(containerStartedAt) : Number.NaN;
    const live = running ? all.filter((t) => !Number.isFinite(started) || t.createdAt >= started) : [];
    if (live.length !== all.length) this.#write(live);
    return live;
  }

  has(id: string): boolean {
    return this.#read().some((t) => t.id === id);
  }

  add(id: string, now = Date.now()): void {
    this.#write([...this.#read().filter((t) => t.id !== id), { id, createdAt: now }]);
  }

  remove(id: string): void {
    this.#write(this.#read().filter((t) => t.id !== id));
  }

  #read(): TerminalRecord[] {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(KEY) as { value: string } | undefined;
    try {
      const parsed = JSON.parse(row?.value ?? "[]") as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((t): t is TerminalRecord => typeof t?.id === "string" && TERMINAL_ID.test(t.id) && typeof t?.createdAt === "number")
        : [];
    } catch {
      return [];
    }
  }

  #write(list: TerminalRecord[]): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, JSON.stringify(list));
  }
}

/** The sandbox allows one websocket per terminal; the console's own frame may still be closing. */
class TerminalBusy extends Error {}

/**
 * End a terminal: attach to it, interrupt whatever runs, and exit its shell.
 * Resolves "gone" when the sandbox no longer has it; rejects when it could not
 * be reached, so the caller never reports a close that did not happen.
 */
export async function exitTerminal(port: number, id: string, opts: { attempts?: number; retryMs?: number; timeoutMs?: number } = {}): Promise<"exited" | "gone"> {
  const attempts = opts.attempts ?? 6;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await exitOnce(port, id, opts.timeoutMs ?? 8000);
    } catch (err) {
      if (!(err instanceof TerminalBusy) || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, opts.retryMs ?? 600));
    }
  }
}

function exitOnce(port: number, id: string, timeoutMs: number): Promise<"exited" | "gone"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/shell/ws?session_id=${encodeURIComponent(id)}`);
    let settled = false;
    const finish = (err: Error | null, outcome?: "exited" | "gone") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(outcome!);
    };
    const timer = setTimeout(() => finish(new Error("terminal did not answer")), timeoutMs);
    ws.on("message", (raw) => {
      let message: { type?: unknown; data?: unknown };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return; // terminal output
      }
      if (message.type === "error") {
        const text = String(message.data ?? "");
        // "Session not found" / "Session is not active": the shell already ended.
        if (/not found|not active/i.test(text)) finish(null, "gone");
        else if (/active WebSocket/i.test(text)) finish(new TerminalBusy(text));
        else finish(new Error(text || "terminal refused"));
      } else if (message.type === "terminal_restored" || message.type === "ready") {
        // Attached ("ready" only for a brand-new session). Ctrl-C first, so a running command does not swallow the exit.
        ws.send(JSON.stringify({ type: "input", data: "\u0003exit\n" }), (err) => (err ? finish(err) : finish(null, "exited")));
      }
    });
    ws.on("error", (err) => finish(err));
    ws.on("close", () => finish(new Error("terminal connection closed")));
  });
}
