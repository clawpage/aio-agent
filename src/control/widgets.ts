import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { ShareError, safeSegments, CONTENT_TYPES, type ShareFile } from "./share.js";
import { WIDGET_RUNTIME_JS } from "./widgetRuntime.js";

/**
 * Widgets: components an account's executor builds for its main session.
 *
 * The sandbox `aio-widget` CLI publishes a folder (`index.html` plus its files) through the
 * member gateway with the runtime's share token; the control plane keeps it on the host, so
 * showing a message never wakes the sandbox. A message embeds one with a fenced
 * ```widget {"component": <name>, "data": {...}}``` block, and the console frames
 * `/widgets/<name>/` on the workspace origin, for the signed-in account only. Every response
 * runs in a CSP sandbox (an opaque origin: no workspace cookies, no same-origin calls), with
 * the runtime (widgetRuntime.ts) injected into its page. The runtime talks only to the console
 * frame around it, which hands it the message's data and the theme, and relays what the
 * account allows a widget: answers from the account's AI, web requests made from its sandbox,
 * and text put into the composer for the person to send.
 */

export const WIDGET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const WIDGET_LIMITS = { files: 50, bytes: 5 * 1024 * 1024, widgets: 100, example: 64 * 1024, description: 2000 };
const META = ".widget.json";

interface WidgetMeta { title: string; description: string; example: unknown; files: number; bytes: number; updatedAt: number }
export interface Widget { name: string; title: string; description: string; files: number; bytes: number; updatedAt: number }
export interface WidgetPublish { title?: unknown; description?: unknown; example?: unknown; files?: unknown }

/** Script, styles and media from anywhere; framed only by the console. */
function widgetCsp(cfg: Config): string {
  return `sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors ${cfg.primaryOrigins.join(" ")}`;
}

/** One line, at most `max` characters. */
function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max) : "";
}

/** JSON that is safe inside an inline script. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The runtime goes first in <head>, so the page's own scripts find `window.aio`; its example data lets the page open on its own. */
export function injectRuntime(html: string, example: unknown): string {
  const tag = `<script>window.__aioExample=${scriptJson(example)};${WIDGET_RUNTIME_JS}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length) : tag + html;
}

export class WidgetStore {
  #root: string;
  #cfg: Config;
  /** Requests a widget made of the account's AI and of its sandbox, per account, over the last minute. */
  #calls = new Map<string, number[]>();

  constructor(cfg: Config) {
    this.#cfg = cfg;
    this.#root = path.join(cfg.dataDir, "widgets");
  }

  #dir(userId: string, name?: string): string {
    return name ? path.join(this.#root, userId, name) : path.join(this.#root, userId);
  }

  #meta(userId: string, name: string): WidgetMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.#dir(userId, name), META), "utf8")) as WidgetMeta;
    } catch {
      return null;
    }
  }

  list(userId: string): Widget[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#dir(userId)).filter((n) => WIDGET_NAME.test(n));
    } catch {
      return [];
    }
    const out: Widget[] = [];
    for (const name of names) {
      const meta = this.#meta(userId, name);
      if (meta) out.push({ name, title: meta.title, description: meta.description, files: meta.files, bytes: meta.bytes, updatedAt: meta.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(userId: string, name: string): (Widget & { example: unknown }) | null {
    const meta = WIDGET_NAME.test(name) ? this.#meta(userId, name) : null;
    return meta && { name, title: meta.title, description: meta.description, files: meta.files, bytes: meta.bytes, updatedAt: meta.updatedAt, example: meta.example };
  }

  publish(userId: string, name: string, input: WidgetPublish): Widget {
    if (!WIDGET_NAME.test(name)) throw new ShareError(400, "The widget name can only use lowercase letters, digits, and hyphens (at most 63 characters)");
    if (!Array.isArray(input.files) || input.files.length === 0) throw new ShareError(400, "No files");
    if (input.files.length > WIDGET_LIMITS.files) throw new ShareError(413, `The number of files exceeds the limit of ${WIDGET_LIMITS.files}`);
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
      if (bytes > WIDGET_LIMITS.bytes) throw new ShareError(413, `The widget's files exceed the limit of ${WIDGET_LIMITS.bytes / 1024 / 1024} MB`);
      files.push({ segments, data });
    }
    if (!seen.has("index.html")) throw new ShareError(400, "The widget folder must contain index.html");
    const before = this.#meta(userId, name);
    const description = typeof input.description === "string" ? input.description.trim().slice(0, WIDGET_LIMITS.description) : "";
    if (!description && !before?.description) throw new ShareError(400, "Describe the widget: what it shows and the data it takes");
    const example = input.example === undefined ? before?.example ?? null : input.example;
    if (JSON.stringify(example ?? null).length > WIDGET_LIMITS.example) throw new ShareError(413, `The example data exceeds ${WIDGET_LIMITS.example / 1024} KB`);
    const userDir = this.#dir(userId);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    if (!before && this.list(userId).length >= WIDGET_LIMITS.widgets) {
      throw new ShareError(409, `The account has reached the limit of ${WIDGET_LIMITS.widgets} widgets; delete widgets that are no longer used first`);
    }
    const meta: WidgetMeta = {
      title: line(input.title, 200) || before?.title || name,
      description: description || before!.description,
      example,
      files: files.length,
      bytes,
      updatedAt: Math.max(Date.now(), (before?.updatedAt ?? 0) + 1),
    };
    // Build beside the target and swap, so a frame never loads a half-written widget.
    const staging = path.join(userDir, `.staging-${randomBytes(6).toString("hex")}`);
    const retired = path.join(userDir, `.retired-${randomBytes(6).toString("hex")}`);
    const target = this.#dir(userId, name);
    try {
      for (const f of files) {
        const file = path.join(staging, ...f.segments);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, f.data);
      }
      fs.writeFileSync(path.join(staging, META), JSON.stringify(meta));
      if (before) fs.renameSync(target, retired);
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(retired, { recursive: true, force: true });
    }
    return { name, title: meta.title, description: meta.description, files: meta.files, bytes: meta.bytes, updatedAt: meta.updatedAt };
  }

  /** The published files, for the sandbox to pull and change. */
  files(userId: string, name: string): ShareFile[] | null {
    if (!this.#meta(userId, name)) return null;
    const root = this.#dir(userId, name);
    const out: ShareFile[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push({ path: path.relative(root, full).split(path.sep).join("/"), data: fs.readFileSync(full).toString("base64") });
      }
    };
    walk(root);
    return out;
  }

  remove(userId: string, name: string): boolean {
    if (!WIDGET_NAME.test(name) || !this.#meta(userId, name)) return false;
    fs.rmSync(this.#dir(userId, name), { recursive: true, force: true });
    return true;
  }

  /** At most `perMinute` calls of one kind per account; false when this one is over. */
  allow(userId: string, kind: "ai" | "fetch", perMinute: number): boolean {
    const key = `${kind}:${userId}`;
    const now = Date.now();
    const recent = (this.#calls.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= perMinute) {
      this.#calls.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#calls.set(key, recent);
    return true;
  }

  /** `/widgets/<name>/...` on the workspace origin: the signed-in account's own widgets only. */
  serve() {
    return (req: Request, res: Response, next: NextFunction) => {
      const rec = req.paCtx;
      if (rec?.kind !== "workspace") return next();
      const m = /^\/widgets\/([^/?]*)(\/[^?]*)?(?:\?.*)?$/.exec(req.url);
      if (!m) return next();
      if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).end();
      const notFound = () => void res.status(404).set({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).send("Not Found");
      const userId = rec.workspaceUserId ?? rec.session?.ownerId;
      if (!rec.session || !userId || rec.session.ownerId !== userId) {
        res.status(401).set({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).send("Unauthorized");
        return;
      }
      const [, name, rest] = m;
      if (!WIDGET_NAME.test(name!)) return notFound();
      // Relative links inside the widget need the trailing slash; a member's address keeps its `/u/<username>`.
      if (rest === undefined) return res.redirect(301, `${req.originalUrl.slice(0, req.originalUrl.length - req.url.length)}/widgets/${name}/`);
      const meta = this.#meta(userId, name!);
      if (!meta) return notFound();
      let rel: string;
      try {
        rel = decodeURIComponent(rest.slice(1));
      } catch {
        return notFound();
      }
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      const segments = safeSegments(rel);
      if (!segments) return notFound();
      const dir = this.#dir(userId, name!);
      const file = path.join(dir, ...segments);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        return notFound();
      }
      if (!stat.isFile() || !file.startsWith(dir + path.sep)) return notFound();
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      res.status(200).set({
        "content-security-policy": widgetCsp(this.#cfg),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
        "cache-control": "private, no-cache",
        "content-type": type,
      });
      if (req.method === "HEAD") return res.end();
      if (type.startsWith("text/html")) return res.send(injectRuntime(fs.readFileSync(file, "utf8"), meta.example));
      const stream = fs.createReadStream(file).on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    };
  }
}
