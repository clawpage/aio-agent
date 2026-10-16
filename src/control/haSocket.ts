import type { Logger } from "../common/logger.js";

/** A failure worth telling the executor as is (HA unreachable, refused, a bad argument). */
export class HaError extends Error {}

export type HaCall = (message: Record<string, unknown>) => Promise<unknown>;

export interface HaEndpoint {
  baseUrl: string;
  token: () => string | null;
  log: Logger;
}

/** One connection to HA's WebSocket API: authenticate, then any number of commands until `work` settles. */
export async function withHaSocket<T>(ha: HaEndpoint, work: (call: HaCall) => Promise<T>, timeoutMs = 25_000): Promise<T> {
  const token = ha.token();
  if (!token) throw new HaError("Home Assistant is not configured");
  const ws = new WebSocket(`${ha.baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/websocket`);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let fail: (err: Error) => void = () => {};
  const broken = new Promise<never>((_, reject) => { fail = reject; });
  broken.catch(() => {});
  const abort = (err: Error) => {
    fail(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  let authed: () => void = () => {};
  const ready = new Promise<void>((resolve) => { authed = resolve; });
  ws.onerror = () => abort(new HaError("Cannot reach Home Assistant"));
  ws.onclose = () => abort(new HaError("Home Assistant closed the connection"));
  ws.onmessage = (ev) => {
    let m: { type?: string; id?: number; success?: boolean; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
    else if (m.type === "auth_ok") authed();
    else if (m.type === "auth_invalid") {
      ha.log.warn("Home Assistant rejected the token");
      abort(new HaError("Home Assistant refused the request"));
    } else if (m.type === "result" && typeof m.id === "number") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.success) p.resolve(m.result);
      else p.reject(new HaError(m.error?.message ?? "Home Assistant refused the request"));
    }
  };
  let nextId = 0;
  const call: HaCall = (message) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, ...message }));
  });
  const timer = setTimeout(() => abort(new HaError("Home Assistant did not answer in time")), timeoutMs);
  try {
    await Promise.race([ready, broken]);
    return await Promise.race([work(call), broken]);
  } finally {
    clearTimeout(timer);
    ws.onclose = null;
    try { ws.close(); } catch { /* already closed */ }
  }
}
