import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { ClawpageData, DataError, type Caller, type TableSummary } from "./clawpages.js";

/**
 * Public share pages: clawpages.
 *
 * The sandbox `aio-share` CLI publishes a page directory to the member gateway
 * with its runtime's own share token; the control plane keeps a snapshot on the
 * host and serves it unauthenticated on the workspace origin at
 * `/u/<username>/share/<name>/`. Serving never touches the sandbox, so public
 * traffic cannot load or reach it, and every response runs in a CSP sandbox:
 * the page gets an opaque origin, so it can neither read the workspace session
 * nor make credentialed same-origin calls to the workspace.
 *
 * A page can keep data in tables of its own (clawpages.ts): visitors reach them
 * at `/u/<username>/share/<name>/.data/...` (no cookies; CORS open, since the
 * page's origin is opaque), the owner through an owner link's token, the
 * account's sandbox through the same share channel it publishes with.
 */

export const SHARE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SHARE_LIMITS = { files: 200, bytes: 20 * 1024 * 1024, pages: 100 };
const META = ".meta.json";
const TOKEN = /^[a-f0-9]{64}$/;

/** Only these types are labelled; anything else is served as opaque bytes. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
};

/** A data request's body: a record (64 KB) with room for the JSON around it; an import from the sandbox may be larger. */
const DATA_BODY = { visitor: 128 * 1024, owner: 16 * 1024 * 1024 };

/** The page's data API answers any origin (the page's own is opaque) and never involves cookies. */
const DATA_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

/** No script on the page shares the workspace origin; it still runs, opens links and submits forms. */
const PAGE_HEADERS = {
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "cache-control": "public, max-age=60",
};

export class ShareError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface SharePage { name: string; title: string; url: string; files: number; bytes: number; updatedAt: number; tables: TableSummary[] }
export interface ShareFile { path: string; data: string }

/** A relative path of plain segments: no traversal, no hidden files, no backslashes or control characters. */
function safeSegments(rel: string): string[] | null {
  if (!rel || rel.length > 512) return null;
  const segments = rel.split("/");
  if (segments.length > 8) return null;
  for (const s of segments) {
    if (!s || s.length > 128 || s.startsWith(".") || s.includes("\\") || /[\u0000-\u001f\u007f]/.test(s)) return null;
  }
  return segments;
}

export class ShareStore {
  #root: string;
  #cfg: Config;
  #port: number;
  #tokens = new Map<string, string>();
  #usernameOf: (userId: string) => string | null;
  #userIdOf: (username: string) => string | null;
  /** The pages' tables; absent where a store is built without data (tests of the page side only). */
  readonly data?: ClawpageData;

  constructor(opts: {
    cfg: Config; port: number;
    usernameOf: (userId: string) => string | null;
    userIdOf: (username: string) => string | null;
    data?: ClawpageData;
  }) {
    this.#cfg = opts.cfg;
    this.#root = path.join(opts.cfg.dataDir, "shares");
    this.#port = opts.port;
    this.#usernameOf = opts.usernameOf;
    this.#userIdOf = opts.userIdOf;
    this.data = opts.data;
  }

  /** Give a runtime its publish capability; its sandbox receives the token through `cfg.share`. */
  provision(cfg: Config): void {
    const userId = cfg.runtimeUserId!;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "share-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(userId, token);
    cfg.share = { token, endpoint: `http://host.docker.internal:${this.#port}/share/${userId}` };
  }

  pageUrl(userId: string, name: string): string {
    return `https://${this.#cfg.workspaceHost}/u/${this.#usernameOf(userId) ?? userId}/share/${name}/`;
  }

  #userDir(userId: string): string {
    return path.join(this.#root, userId);
  }

  list(userId: string): SharePage[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#userDir(userId)).filter((n) => SHARE_NAME.test(n));
    } catch {
      return [];
    }
    const tables = this.data?.overview(userId) ?? new Map<string, TableSummary[]>();
    return names.flatMap((name) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.#userDir(userId), name, META), "utf8")) as Omit<SharePage, "name" | "url">;
        return [{ name, url: this.pageUrl(userId, name), title: meta.title, files: meta.files, bytes: meta.bytes, updatedAt: meta.updatedAt, tables: tables.get(name) ?? [] }];
      } catch {
        return [];
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Create or replace a page as a whole; the URL stays the same across updates. */
  publish(userId: string, name: string, input: { title?: unknown; files?: unknown }): SharePage {
    if (!SHARE_NAME.test(name)) throw new ShareError(400, "The page name can only use lowercase letters, digits, and hyphens (at most 63 characters)");
    if (!Array.isArray(input.files) || input.files.length === 0) throw new ShareError(400, "No files");
    if (input.files.length > SHARE_LIMITS.files) throw new ShareError(413, `The number of files exceeds the limit of ${SHARE_LIMITS.files}`);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : name;
    const files: Array<{ segments: string[]; data: Buffer }> = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const f of input.files as ShareFile[]) {
      const segments = typeof f?.path === "string" ? safeSegments(f.path) : null;
      if (!segments || typeof f.data !== "string") throw new ShareError(400, `Invalid file path: ${String(f?.path).slice(0, 100)}`);
      const key = segments.join("/");
      if (seen.has(key)) throw new ShareError(400, `Duplicate file: ${key}`);
      seen.add(key);
      const data = Buffer.from(f.data, "base64");
      bytes += data.byteLength;
      if (bytes > SHARE_LIMITS.bytes) throw new ShareError(413, `The total page size exceeds the limit of ${SHARE_LIMITS.bytes / 1024 / 1024} MB`);
      files.push({ segments, data });
    }
    if (!seen.has("index.html")) throw new ShareError(400, "The page folder must contain index.html");

    const userDir = this.#userDir(userId);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const target = path.join(userDir, name);
    if (!fs.existsSync(target) && this.list(userId).length >= SHARE_LIMITS.pages) {
      throw new ShareError(409, `The number of shared pages has reached the limit of ${SHARE_LIMITS.pages}; delete pages that are no longer used first`);
    }
    // Build beside the target and swap, so a reader never sees a half-written page.
    const staging = path.join(userDir, `.staging-${randomBytes(6).toString("hex")}`);
    try {
      for (const f of files) {
        const file = path.join(staging, ...f.segments);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, f.data);
      }
      const updatedAt = Date.now();
      fs.writeFileSync(path.join(staging, META), JSON.stringify({ title, files: files.length, bytes, updatedAt }));
      const retired = path.join(userDir, `.retired-${randomBytes(6).toString("hex")}`);
      if (fs.existsSync(target)) fs.renameSync(target, retired);
      fs.renameSync(staging, target);
      fs.rmSync(retired, { recursive: true, force: true });
      return { name, title, url: this.pageUrl(userId, name), files: files.length, bytes, updatedAt, tables: this.data?.tables(userId, name) ?? [] };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  exists(userId: string, name: string): boolean {
    return SHARE_NAME.test(name) && fs.existsSync(path.join(this.#userDir(userId), name, META));
  }

  /** A page goes with its data. */
  remove(userId: string, name: string): boolean {
    if (!SHARE_NAME.test(name)) return false;
    const target = path.join(this.#userDir(userId), name);
    const existed = fs.existsSync(target);
    fs.rmSync(target, { recursive: true, force: true });
    const hadData = (this.data?.tables(userId, name).length ?? 0) > 0;
    this.data?.dropPage(userId, name);
    return existed || hadData;
  }

  /** The published files of a page, to work on it again in the sandbox (`aio-share pull`). */
  files(userId: string, name: string): ShareFile[] | null {
    if (!this.exists(userId, name)) return null;
    const root = path.join(this.#userDir(userId), name);
    const out: ShareFile[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) out.push({ path: rel, data: fs.readFileSync(path.join(dir, entry.name)).toString("base64") });
      }
    };
    walk(root, "");
    return out;
  }

  /**
   * One request to a page's data, after the caller is known. `rest` is the path below
   * `.data` (public) or `data` (sandbox): nothing (the tables), a table, a record, or a
   * record's `incr`. Managing tables is the owner's.
   */
  dataRequest(userId: string, page: string, rest: string[], method: string, query: URLSearchParams, body: Record<string, unknown>, caller: Caller): { status: number; body?: unknown } {
    const data = this.data;
    if (!data) throw new DataError(404, "NOT_FOUND", "This deployment has no page data");
    const ownerOnly = () => { if (!caller.owner) throw new DataError(403, "PERMISSION_DENIED", "Only the page's owner can do this"); };
    const [table, key, action] = rest;
    if (rest.length > 3 || (action !== undefined && action !== "incr")) throw new DataError(404, "NOT_FOUND", "No such data path");
    if (table === undefined) {
      if (method === "GET") return { status: 200, body: { tables: data.tables(userId, page).filter((t) => caller.owner || t.permission !== "private") } };
      if (method === "POST") { ownerOnly(); return { status: 201, body: data.createTable(userId, page, String(body.name ?? ""), body.permission ?? "private") }; }
    } else if (key === undefined) {
      if (method === "GET" && query.get("export")) { ownerOnly(); return { status: 200, body: data.exportTable(userId, page, table) }; }
      if (method === "GET") return { status: 200, body: data.list(userId, page, table, caller, { limit: query.get("limit"), after: query.get("after") }) };
      if (method === "POST") return { status: 201, body: data.post(userId, page, table, body.value, caller) };
      if (method === "PUT") { ownerOnly(); return { status: 200, body: data.importTable(userId, page, table, body.records) }; }
      if (method === "PATCH") { ownerOnly(); return { status: 200, body: data.setPermission(userId, page, table, body.permission) }; }
      if (method === "DELETE") { ownerOnly(); return data.dropTable(userId, page, table) ? { status: 204 } : { status: 404, body: { error: "TABLE_NOT_FOUND", message: `Table ${table} does not exist` } }; }
    } else if (action === "incr") {
      if (method === "POST") return { status: 200, body: data.incr(userId, page, table, key, body.field, body.by, caller) };
    } else {
      if (method === "GET") return { status: 200, body: data.get(userId, page, table, key, caller) };
      if (method === "PUT") return { status: 200, body: data.put(userId, page, table, key, body.value, caller) };
      if (method === "PATCH") return { status: 200, body: data.patch(userId, page, table, key, body.value, caller) };
      if (method === "DELETE") return data.remove(userId, page, table, key, caller) ? { status: 204 } : { status: 404, body: { error: "RECORD_NOT_FOUND", message: `No record ${key}` } };
    }
    throw new DataError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`);
  }

  /**
   * The sandbox side: `/share/<userId>/pages[/<name>]` on the member gateway,
   * authorized by that runtime's share token only.
   */
  async handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://gateway");
    const match = /^\/share\/([a-zA-Z0-9_]+)\/pages(?:\/([^/]+)(?:\/(files|data)((?:\/[^/]+)*))?)?$/.exec(url.pathname);
    const expected = match ? this.#tokens.get(match[1]!) : undefined;
    const supplied = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!match || !expected || !TOKEN.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      reply(403, { error: "forbidden" });
      return;
    }
    const [, userId, name, sub, tail] = match as unknown as [string, string, string | undefined, string | undefined, string | undefined];
    try {
      if (name && !SHARE_NAME.test(name)) return reply(400, { error: "Invalid page name" });
      if (sub === "files") {
        const files = req.method === "GET" ? this.files(userId, name!) : undefined;
        return files === undefined ? reply(405, { error: "method_not_allowed" }) : files ? reply(200, { name, files }) : reply(404, { error: "The page does not exist" });
      }
      if (sub === "data") {
        const rest = (tail ?? "").split("/").filter(Boolean).map((s) => decodeURIComponent(s));
        const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req, DATA_BODY.owner);
        const out = this.dataRequest(userId, name!, rest, req.method ?? "GET", url.searchParams, body, { owner: true });
        return reply(out.status, out.body);
      }
      if (req.method === "GET" && !name) return reply(200, { pages: this.list(userId) });
      if (req.method === "DELETE" && name) return this.remove(userId, name) ? reply(204) : reply(404, { error: "The page does not exist" });
      if (req.method !== "POST" || !name) return reply(405, { error: "method_not_allowed" });
      const chunks: Buffer[] = [];
      let size = 0;
      // base64 inflates the page by a third; leave room for the JSON around it.
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > SHARE_LIMITS.bytes * 1.5) return reply(413, { error: `The total page size exceeds the limit of ${SHARE_LIMITS.bytes / 1024 / 1024} MB` });
        chunks.push(chunk as Buffer);
      }
      let input: { title?: unknown; files?: unknown };
      try {
        input = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return reply(400, { error: "The request is not valid JSON" });
      }
      reply(200, this.publish(userId, name, input));
    } catch (err) {
      if (err instanceof ShareError) reply(err.status, { error: err.message });
      else if (err instanceof DataError) reply(err.status, { error: err.message, code: err.code });
      else reply(500, { error: "The request failed" });
    }
  }

  /** `/u/<username>/share/<name>/.data/...`: a page's data for its visitors and its owner's link. */
  async #serveData(req: Request, res: Response, userId: string, page: string, rest: string, query: string): Promise<void> {
    const reply = (status: number, body?: unknown) => {
      res.status(status).set(DATA_HEADERS);
      if (body === undefined) res.end();
      else res.send(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return reply(204);
    const data = this.data;
    if (!data || !this.exists(userId, page)) return reply(404, { error: "PAGE_NOT_FOUND", message: "The page does not exist" });
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const owner = !!token && data.isOwnerToken(token, userId, page);
    const write = req.method !== "GET" && req.method !== "HEAD";
    if (!owner && !data.allow(req.paCtx?.ip ?? "unknown", userId, page, write ? "writes" : "reads")) {
      return reply(429, { error: "RATE_LIMITED", message: "Too many requests; try again in a minute" });
    }
    try {
      const segments = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
      const body = write && req.method !== "DELETE" ? await readJson(req, owner ? DATA_BODY.owner : DATA_BODY.visitor) : {};
      const out = this.dataRequest(userId, page, segments, req.method === "HEAD" ? "GET" : req.method, new URLSearchParams(query), body, { owner, ip: req.paCtx?.ip });
      reply(out.status, out.body);
    } catch (err) {
      if (err instanceof DataError) reply(err.status, { error: err.code, message: err.message });
      else if (err instanceof URIError) reply(400, { error: "INVALID_PATH", message: "Invalid path" });
      else reply(500, { error: "INTERNAL", message: "The request failed" });
    }
  }

  /** The public side: `/u/<username>/share/<name>/...` on the workspace origin, no session involved. */
  serve() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.paCtx?.kind !== "workspace") return next();
      const url = req.originalUrl;
      const q = url.indexOf("?");
      const pathname = q < 0 ? url : url.slice(0, q);
      const query = q < 0 ? "" : url.slice(q + 1);
      const m = /^\/u\/([A-Za-z0-9_-]{2,40})\/share(?:\/([^/]*)(\/.*)?)?$/.exec(pathname);
      if (!m) return next();
      const [, username, rawName, rest] = m;
      const dataPath = rawName && SHARE_NAME.test(rawName) && rest !== undefined ? /^\/\.data(\/.*)?$/.exec(rest) : null;
      if (dataPath) {
        const userId = this.#userIdOf(username!);
        if (!userId) return void res.status(404).set(DATA_HEADERS).send(JSON.stringify({ error: "PAGE_NOT_FOUND", message: "The page does not exist" }));
        void this.#serveData(req, res, userId, rawName!, dataPath[1] ?? "", query);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      const notFound = () => {
        res.status(404).set({ ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).send("页面不存在或已删除");
      };
      const userId = this.#userIdOf(username!);
      if (!userId) return notFound();
      // `share?<name>` is the short form of the page address.
      if (rawName === undefined) {
        return SHARE_NAME.test(query) ? res.redirect(302, `/u/${username}/share/${query}/`) : notFound();
      }
      if (!SHARE_NAME.test(rawName)) return notFound();
      // Relative links inside the page need the trailing slash.
      if (rest === undefined) return res.redirect(301, `/u/${username}/share/${rawName}/${q < 0 ? "" : url.slice(q)}`);
      let rel: string;
      try {
        rel = decodeURIComponent(rest.slice(1));
      } catch {
        return notFound();
      }
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      const segments = safeSegments(rel);
      if (!segments) return notFound();
      const pageDir = path.join(this.#userDir(userId), rawName);
      const file = path.join(pageDir, ...segments);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        return notFound();
      }
      if (!stat.isFile() || !file.startsWith(pageDir + path.sep)) return notFound();
      res.status(200).set({
        ...PAGE_HEADERS,
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(stat.size),
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    };
  }
}

/** A JSON object body, at most `limit` bytes. */
async function readJson(req: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DataError(413, "BODY_TOO_LARGE", "The request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new DataError(400, "INVALID_JSON", "The request body must be a JSON object");
  }
}
