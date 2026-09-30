import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";

/**
 * Public share pages.
 *
 * The sandbox `aio-share` CLI publishes a page directory to the member gateway
 * with its runtime's own share token; the control plane keeps a snapshot on the
 * host and serves it unauthenticated on the workspace origin at
 * `/u/<username>/share/<name>/`. Serving never touches the sandbox, so public
 * traffic cannot load or reach it, and every response runs in a CSP sandbox:
 * the page gets an opaque origin, so it can neither read the workspace session
 * nor make credentialed same-origin calls to the workspace.
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

export interface SharePage { name: string; title: string; url: string; files: number; bytes: number; updatedAt: number }
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

  constructor(opts: {
    cfg: Config; port: number;
    usernameOf: (userId: string) => string | null;
    userIdOf: (username: string) => string | null;
  }) {
    this.#cfg = opts.cfg;
    this.#root = path.join(opts.cfg.dataDir, "shares");
    this.#port = opts.port;
    this.#usernameOf = opts.usernameOf;
    this.#userIdOf = opts.userIdOf;
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

  #pageUrl(userId: string, name: string): string {
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
    return names.flatMap((name) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.#userDir(userId), name, META), "utf8")) as Omit<SharePage, "name" | "url">;
        return [{ name, url: this.#pageUrl(userId, name), title: meta.title, files: meta.files, bytes: meta.bytes, updatedAt: meta.updatedAt }];
      } catch {
        return [];
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Create or replace a page as a whole; the URL stays the same across updates. */
  publish(userId: string, name: string, input: { title?: unknown; files?: unknown }): SharePage {
    if (!SHARE_NAME.test(name)) throw new ShareError(400, "页面名只能用小写字母、数字和连字符（最多 63 个字符）");
    if (!Array.isArray(input.files) || input.files.length === 0) throw new ShareError(400, "没有文件");
    if (input.files.length > SHARE_LIMITS.files) throw new ShareError(413, `文件数超过上限 ${SHARE_LIMITS.files}`);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : name;
    const files: Array<{ segments: string[]; data: Buffer }> = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const f of input.files as ShareFile[]) {
      const segments = typeof f?.path === "string" ? safeSegments(f.path) : null;
      if (!segments || typeof f.data !== "string") throw new ShareError(400, `文件路径不合法：${String(f?.path).slice(0, 100)}`);
      const key = segments.join("/");
      if (seen.has(key)) throw new ShareError(400, `文件重复：${key}`);
      seen.add(key);
      const data = Buffer.from(f.data, "base64");
      bytes += data.byteLength;
      if (bytes > SHARE_LIMITS.bytes) throw new ShareError(413, `页面总大小超过上限 ${SHARE_LIMITS.bytes / 1024 / 1024} MB`);
      files.push({ segments, data });
    }
    if (!seen.has("index.html")) throw new ShareError(400, "页面目录必须包含 index.html");

    const userDir = this.#userDir(userId);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const target = path.join(userDir, name);
    if (!fs.existsSync(target) && this.list(userId).length >= SHARE_LIMITS.pages) {
      throw new ShareError(409, `分享页面数已达上限 ${SHARE_LIMITS.pages}，请先删除不用的页面`);
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
      return { name, title, url: this.#pageUrl(userId, name), files: files.length, bytes, updatedAt };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  remove(userId: string, name: string): boolean {
    if (!SHARE_NAME.test(name)) return false;
    const target = path.join(this.#userDir(userId), name);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
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
    const match = /^\/share\/([a-zA-Z0-9_]+)\/pages(?:\/([^/?]+))?$/.exec(req.url ?? "");
    const expected = match ? this.#tokens.get(match[1]!) : undefined;
    const supplied = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!match || !expected || !TOKEN.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      reply(403, { error: "forbidden" });
      return;
    }
    const [, userId, name] = match as unknown as [string, string, string | undefined];
    try {
      if (req.method === "GET" && !name) return reply(200, { pages: this.list(userId) });
      if (req.method === "DELETE" && name) return this.remove(userId, name) ? reply(204) : reply(404, { error: "页面不存在" });
      if (req.method !== "POST" || !name) return reply(405, { error: "method_not_allowed" });
      const chunks: Buffer[] = [];
      let size = 0;
      // base64 inflates the page by a third; leave room for the JSON around it.
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > SHARE_LIMITS.bytes * 1.5) return reply(413, { error: `页面总大小超过上限 ${SHARE_LIMITS.bytes / 1024 / 1024} MB` });
        chunks.push(chunk as Buffer);
      }
      let input: { title?: unknown; files?: unknown };
      try {
        input = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return reply(400, { error: "请求不是合法 JSON" });
      }
      reply(200, this.publish(userId, name, input));
    } catch (err) {
      if (err instanceof ShareError) reply(err.status, { error: err.message });
      else reply(500, { error: "发布失败" });
    }
  }

  /** The public side: `/u/<username>/share/<name>/...` on the workspace origin, no session involved. */
  serve() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.paCtx?.kind !== "workspace" || (req.method !== "GET" && req.method !== "HEAD")) return next();
      const url = req.originalUrl;
      const q = url.indexOf("?");
      const pathname = q < 0 ? url : url.slice(0, q);
      const query = q < 0 ? "" : url.slice(q + 1);
      const m = /^\/u\/([A-Za-z0-9_-]{2,40})\/share(?:\/([^/]*)(\/.*)?)?$/.exec(pathname);
      if (!m) return next();
      const [, username, rawName, rest] = m;
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
