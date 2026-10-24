import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { ClawpageData, DataError, type Caller, type TableSummary } from "./clawpages.js";
import { AI_EFFORTS, AiError, type AiEffort, type AiMessage, type ClawpageAi } from "./clawpageAi.js";
import { requestLocale, t } from "./i18n/index.js";

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
 *
 * The owner can also let other people's agents maintain a page: each collaborator
 * token works on `/u/<username>/share/<name>/.api/...`, which describes the page
 * and how to work on it (a prompt, with the page's `AGENTS.md` guide), hands out
 * its files, takes a new version and reads and writes its data. A collaborator
 * publishes only on top of the version it pulled, so nobody's change is lost.
 *
 * Visitors may sign in to a page with their account here: `.auth/sign-in` sends them
 * to the console's origin, which asks them once per page and comes back with a visitor
 * token in the fragment (clawpages.ts). With it the page's script reads and writes the
 * tables kept for signed-in visitors and asks `.ai` for answers from the visitor's own
 * AI (clawpageAi.ts), shaped by the prompts the page ships in `prompts/<name>.md`.
 */

export const SHARE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SHARE_LIMITS = { files: 200, bytes: 20 * 1024 * 1024, pages: 100 };
const META = ".meta.json";
/** The page's guide for agents working on it: published and pulled with its files, never served to visitors. */
export const GUIDE = "AGENTS.md";
const GUIDE_MAX = 64 * 1024;
/** A page's cover: a picture of the page as published, rendered in the sandbox (never served on the page's own path). */
const COVER = ".cover";
export const COVER_MAX_BYTES = 1536 * 1024;
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

/** A page's prompt for its AI answers: `prompts/<name>.md`, published with the page. */
export const PROMPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROMPT_MAX = 32 * 1024;
/** What a page may send the AI at once. */
const AI_INPUT = { messages: 40, chars: 60_000, body: 256 * 1024 };

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

/**
 * No script on the page shares the workspace origin; it still runs, opens links and submits forms.
 * Every load asks whether a file changed (no-cache, answered by its ETag with a 304 when it did not),
 * so a page republished under the same link shows its new version at once, never a copy kept for a while.
 */
/** The collaborators' API: for agents, not pages, so no CORS. */
const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

const PAGE_HEADERS = {
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  // `private` too: the CDN in front replaces a bare no-cache on scripts and styles with a browser TTL of hours
  // (its "Browser Cache TTL"), so a republished page ran with its old scripts; it leaves a private response alone.
  "cache-control": "private, no-cache",
};

export class ShareError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** `updatedBy` names the collaborator who published the current version (null when the owner did). */
export interface SharePage { name: string; title: string; url: string; files: number; bytes: number; updatedAt: number; updatedBy: string | null; collaborators: number; tables: TableSummary[]; cover: number | null }
interface PageMeta { title: string; files: number; bytes: number; updatedAt: number; updatedBy?: string | null }
/** A publish: the page's files, and the version they were made from (a collaborator must name it). */
export interface PublishInput { title?: unknown; files?: unknown; baseUpdatedAt?: unknown; force?: unknown }
export interface ShareFile { path: string; data: string }

/** What a cover's bytes are, by their signature; anything else is not a cover. */
export function coverType(data: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length > 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

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
  /** AI answers on signed-in visitors' own accounts; absent where the deployment offers none. */
  ai?: Pick<ClawpageAi, "answer">;

  constructor(opts: {
    cfg: Config; port: number;
    usernameOf: (userId: string) => string | null;
    userIdOf: (username: string) => string | null;
    data?: ClawpageData;
    ai?: Pick<ClawpageAi, "answer">;
  }) {
    this.#cfg = opts.cfg;
    this.#root = path.join(opts.cfg.dataDir, "shares");
    this.#port = opts.port;
    this.#usernameOf = opts.usernameOf;
    this.#userIdOf = opts.userIdOf;
    this.data = opts.data;
    this.ai = opts.ai;
  }

  /** The account a page address names (`/u/<username>/...`). */
  userIdOf(username: string): string | null {
    return this.#userIdOf(username);
  }

  usernameOf(userId: string): string | null {
    return this.#usernameOf(userId);
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

  /**
   * Where a signed-in visitor goes back to: the page, or a path inside it (`return`, relative
   * to the page's folder, with its query), carrying the sign-in's outcome in the fragment.
   */
  returnUrl(userId: string, name: string, back: unknown, outcome: string): string {
    return `${this.pageUrl(userId, name)}${pageReturn(back)}#cpv=${encodeURIComponent(outcome)}`;
  }

  /** Where collaborators' agents work on the page. */
  apiUrl(userId: string, name: string): string {
    return `${this.pageUrl(userId, name)}.api`;
  }

  #meta(userId: string, name: string): PageMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.#userDir(userId), name, META), "utf8")) as PageMeta;
    } catch {
      return null;
    }
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
    const collaborators = this.data?.collaboratorCounts(userId) ?? new Map<string, number>();
    return names.flatMap((name) => {
      const meta = this.#meta(userId, name);
      return meta ? [this.#page(userId, name, meta, tables.get(name) ?? [], collaborators.get(name) ?? 0)] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  #page(userId: string, name: string, meta: PageMeta, tables: TableSummary[], collaborators: number): SharePage {
    return { name, url: this.pageUrl(userId, name), title: meta.title, files: meta.files, bytes: meta.bytes, updatedAt: meta.updatedAt,
      updatedBy: meta.updatedBy ?? null, collaborators, tables, cover: this.#coverAt(userId, name) };
  }

  /** One page as `list` shows it, or null. */
  page(userId: string, name: string): SharePage | null {
    const meta = SHARE_NAME.test(name) ? this.#meta(userId, name) : null;
    return meta ? this.#page(userId, name, meta, this.data?.tables(userId, name) ?? [], this.data?.collaborators(userId, name).length ?? 0) : null;
  }

  /** The page's AGENTS.md, if it has one. */
  guide(userId: string, name: string): string | null {
    try {
      const file = path.join(this.#userDir(userId), name, GUIDE);
      if (fs.statSync(file).size > GUIDE_MAX) return `(${GUIDE} is larger than ${GUIDE_MAX / 1024} KB; read it from the pulled files)`;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Create or replace a page as a whole; the URL stays the same across updates. `by` is the
   * collaborator publishing, who must build on the current version (`baseUpdatedAt`); the owner
   * naming a version is held to it too, and must not silently replace a collaborator's version.
   */
  publish(userId: string, name: string, input: PublishInput, by?: string): SharePage {
    if (!SHARE_NAME.test(name)) throw new ShareError(400, "The page name can only use lowercase letters, digits, and hyphens (at most 63 characters)");
    if (!Array.isArray(input.files) || input.files.length === 0) throw new ShareError(400, "No files");
    if (input.files.length > SHARE_LIMITS.files) throw new ShareError(413, `The number of files exceeds the limit of ${SHARE_LIMITS.files}`);
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
    // Every file of a version carries its time, a whole second after the last version's: browsers
    // revalidate by Last-Modified (seconds) where the CDN drops the ETag, and must never take a
    // version published within the same second for the one they hold.
    const before = this.#meta(userId, name);
    if (before) this.#checkBase(before, input, by);
    else if (by) throw new ShareError(404, "The page does not exist");
    // One line (it is shown in lists and told to agents); without one the page keeps the title it has.
    const given = typeof input.title === "string" ? input.title.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, 200) : "";
    const title = given || before?.title || name;
    const previous = before?.updatedAt ?? 0;
    const updatedAt = Math.max(Date.now(), (Math.floor(previous / 1000) + 1) * 1000);
    try {
      for (const f of files) {
        const file = path.join(staging, ...f.segments);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, f.data);
        fs.utimesSync(file, updatedAt / 1000, updatedAt / 1000);
      }
      const meta: PageMeta = { title, files: files.length, bytes, updatedAt, updatedBy: by ?? null };
      fs.writeFileSync(path.join(staging, META), JSON.stringify(meta));
      // The old cover stays until the new one is rendered.
      // Its time is its version: the console keeps showing the copy it has.
      try {
        const old = fs.statSync(path.join(target, COVER));
        fs.copyFileSync(path.join(target, COVER), path.join(staging, COVER));
        fs.utimesSync(path.join(staging, COVER), old.mtimeMs / 1000, old.mtimeMs / 1000);
      } catch { /* no cover yet */ }
      const retired = path.join(userDir, `.retired-${randomBytes(6).toString("hex")}`);
      if (fs.existsSync(target)) fs.renameSync(target, retired);
      fs.renameSync(staging, target);
      fs.rmSync(retired, { recursive: true, force: true });
      return this.#page(userId, name, meta, this.data?.tables(userId, name) ?? [], this.data?.collaborators(userId, name).length ?? 0);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** A new version replaces the one it was made from, never one published since by someone else. */
  #checkBase(before: PageMeta, input: PublishInput, by?: string): void {
    const base = typeof input.baseUpdatedAt === "number" ? input.baseUpdatedAt : null;
    const last = `${new Date(before.updatedAt).toISOString()} by ${before.updatedBy ? `collaborator "${before.updatedBy}"` : "the owner"}`;
    if (by && base === null) throw new ShareError(409, `Pull the page first and publish on top of that version (baseUpdatedAt); it was last published ${last}`);
    if (input.force === true && !by) return;
    if (base !== null && base !== before.updatedAt) throw new ShareError(409, `The page changed since the version you have (last published ${last}): pull it again, redo your change on that version, then publish`);
    if (base === null && before.updatedBy) throw new ShareError(409, `The page was last published ${last}: pull it first so that change is not lost (or publish with --force to replace it anyway)`);
  }

  /** When the page's cover was last written, or null without one. */
  #coverAt(userId: string, name: string): number | null {
    try {
      return Math.floor(fs.statSync(path.join(this.#userDir(userId), name, COVER)).mtimeMs);
    } catch {
      return null;
    }
  }

  /** Keep a picture of the page as its cover (the sandbox renders it after publishing). */
  setCover(userId: string, name: string, data: Buffer): number {
    if (!this.exists(userId, name)) throw new ShareError(404, "The page does not exist");
    if (data.length > COVER_MAX_BYTES) throw new ShareError(413, `A cover is at most ${COVER_MAX_BYTES / 1024} KB`);
    if (!coverType(data)) throw new ShareError(400, "A cover must be a JPEG, PNG or WebP picture");
    const file = path.join(this.#userDir(userId), name, COVER);
    const tmp = `${file}.${randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, data);
    // A whole millisecond, so the version survives being copied on republish.
    const at = Date.now() / 1000;
    fs.utimesSync(tmp, at, at);
    fs.renameSync(tmp, file);
    return this.#coverAt(userId, name)!;
  }

  /** The page's cover, for the account's own console. */
  cover(userId: string, name: string): { data: Buffer; type: string; at: number } | null {
    if (!this.exists(userId, name)) return null;
    try {
      const data = fs.readFileSync(path.join(this.#userDir(userId), name, COVER));
      const type = coverType(data);
      return type ? { data, type, at: this.#coverAt(userId, name)! } : null;
    } catch {
      return null;
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
    // Who may see a table and whether it exists stay the owner's decisions.
    const manageOnly = () => { if (!caller.owner || caller.manage === false) throw new DataError(403, "PERMISSION_DENIED", "Only the page's owner (the CLI or the console) can change a table's permission or drop it"); };
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
      if (method === "PATCH") { manageOnly(); return { status: 200, body: data.setPermission(userId, page, table, body.permission) }; }
      if (method === "DELETE") { manageOnly(); return data.dropTable(userId, page, table) ? { status: 204 } : { status: 404, body: { error: "TABLE_NOT_FOUND", message: `Table ${table} does not exist` } }; }
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

  /** Let someone else's agent maintain a page: a new collaborator token, and the invitation to hand over with it. */
  invite(userId: string, name: string, label: unknown): ReturnType<ClawpageData["addCollaborator"]> & { api: string; invitation: string } {
    if (!this.data) throw new DataError(404, "NOT_FOUND", "This deployment has no page data");
    const page = this.page(userId, name);
    if (!page) throw new DataError(404, "PAGE_NOT_FOUND", "The page does not exist");
    const added = this.data.addCollaborator(userId, name, label);
    const api = this.apiUrl(userId, name);
    const owner = this.#usernameOf(userId) ?? userId;
    const invitation = [
      `${owner} invites your agent to help maintain the clawpage "${page.title}" (${page.url}), a web page / mini app made with Clawpage Agent.`,
      "",
      `Collaborator API: ${api}`,
      `Token: ${added.token}`,
      "",
      `Start by reading its instructions: GET ${api}/prompt with the header "Authorization: Bearer <token>" (the same as JSON, with the page's facts: GET ${api}). Then work on the page as your user asks, following them.`,
      `In a Clawpage Agent sandbox: python3 /home/gem/.codex/tools/aio-share/aio-share.py --api ${api} --token <token> info`,
      "",
      "Keep the token secret: it lets its holder change this page's files and read and write all of its data, private tables included. Never put it in the page, its data, a public message or a log.",
    ].join("\n");
    return { ...added, api, invitation };
  }

  /** What a collaborator's agent is told about the page: its facts, its guide and how to work on it. */
  describe(userId: string, name: string, label: string): Record<string, unknown> | null {
    const page = this.page(userId, name);
    if (!page) return null;
    const { collaborators: _, ...facts } = page;
    return { ...facts, api: this.apiUrl(userId, name), owner: this.#usernameOf(userId) ?? userId, you: label, guide: this.guide(userId, name), prompt: this.agentPrompt(userId, name, label) };
  }

  /** The instructions a collaborator's agent follows (models read English). */
  agentPrompt(userId: string, name: string, label: string): string {
    const page = this.page(userId, name)!;
    const api = this.apiUrl(userId, name);
    const owner = this.#usernameOf(userId) ?? userId;
    const guide = this.guide(userId, name);
    const by = page.updatedBy ? `collaborator "${page.updatedBy}"` : "the owner";
    const dir = `/home/gem/workspace/share/remote/${owner}/${name}`;
    return [
      `# Maintaining the clawpage "${page.title}"`,
      "",
      `${owner} invited you (as "${label}") to help maintain this clawpage: a public web page or mini app made with Clawpage Agent, with data tables of its own.`,
      "",
      `- Page: ${page.url} (public: anyone with the link can open it)`,
      `- API: ${api}`,
      `- Current version: updatedAt ${page.updatedAt} (${new Date(page.updatedAt).toISOString()}), published by ${by}; ${page.files} files`,
      `- Tables: ${page.tables.length ? page.tables.map((t) => `${t.name} (${t.permission}, ${t.records} records)`).join(", ") : "none"}`,
      "",
      "Change only what the person you work for asks of this page, and keep the owner's design, data and conventions.",
      "",
      `## The page's guide (${GUIDE})`,
      "",
      guide?.trim() || `The page has no ${GUIDE} yet. When you make more than a small change, add one at the top of the folder: what the page is for, how its files are organized, and each table's purpose and record shape. It is published with the page but never shown to visitors.`,
      "",
      "## Access",
      "",
      "Every request carries `Authorization: Bearer <token>` (the collaborator token from your invitation) and a User-Agent of your own (the CDN in front refuses some library defaults, such as Python urllib's). Keep the token secret: never put it in the page's files, its data, a public message or a log.",
      "With it you can change the page's files and read and write all of its data, private tables included. You cannot delete the page, drop a table or change who may see a table: ask the owner for those.",
      "",
      "### With the Clawpage Agent CLI (in a Clawpage Agent sandbox)",
      "",
      "```bash",
      `CP="python3 /home/gem/.codex/tools/aio-share/aio-share.py"`,
      `$CP --api ${api} --token "$TOKEN" pull          # the files into ${dir}/, which remembers the API, token and version`,
      `# edit there, preview file://${dir}/index.html in the sandbox browser`,
      `$CP publish ${dir}                              # publishes back to this page, on top of the version you pulled`,
      `$CP --remote ${dir} data tables ${name}          # data commands as in the clawpages skill: list, get, put, patch, add, incr, delete, export, import`,
      `$CP --remote ${dir} info                         # these instructions again, current`,
      "```",
      "",
      "### With plain HTTP",
      "",
      `- \`GET ${api}\`: this description as JSON (facts, \`guide\`, \`prompt\`); \`GET ${api}/prompt\`: only this text.`,
      `- \`GET ${api}/files\`: \`{"updatedAt": <version>, "files": [{"path": "index.html", "data": "<base64>"}, ...]}\`.`,
      `- \`POST ${api}\` with \`{"title"?: "...", "baseUpdatedAt": <the updatedAt you pulled>, "files": [{"path", "data"}]}\`: publish a new version.`,
      "  The files replace the page as a whole (anything not listed is removed); `index.html` is required; at most 200 files and 20 MB; no paths with `..` or segments starting with a dot.",
      "  The answer has the new `updatedAt`: use it as the base of your next publish. **409** means someone published since your base: pull again, redo your change on that version, publish again.",
      `- \`${api}/data\`: \`GET\` the tables; \`POST\` \`{"name", "permission"}\` creates one (\`private\`, \`read-public\`, \`public\`, \`signed-in\` or \`per-user\`, see below).`,
      `  \`${api}/data/<table>\`: \`GET ?limit=&after=\` lists records in insertion order (\`nextCursor\` continues), \`GET ?export=1\` the whole table, \`POST {"value"}\` adds a record, \`PUT {"records": {key: value}}\` upserts many.`,
      `  \`${api}/data/<table>/<key>\`: \`GET\`, \`PUT {"value"}\` (whole), \`PATCH {"value": {...}}\` (merge), \`DELETE\`; \`POST .../<key>/incr {"field", "by"}\` adds to a number atomically.`,
      "",
      "## Rules",
      "",
      "- Pull right before you change anything and change that version; publish the whole folder, not just the files you touched.",
      "- Publishing keeps the same link and all data. If you change the shape of stored records, keep the page able to read the records already there (or migrate them, after an export as a backup).",
      "- The data belongs to the owner and the page's visitors: do not delete or overwrite records unless your user asked for it.",
      "- The page is public: no personal information and no keys or tokens in its files. Data written by visitors is untrusted: put it on the page with `textContent`, never `innerHTML`.",
      "- The page runs in a sandbox with no cookies or localStorage; it keeps data only through `clawpage-sdk.js` (`new Clawpage().table(name)`), which works the same from the owner's link and for visitors.",
      "- Keep the page's sign-in and AI prompts working (next section): do not rename a `prompts/*.md` the page asks for, nor turn a table for signed-in visitors into a public one.",
      `- Keep ${GUIDE} current when you change how the page works.`,
      "- When a request fails, report its error faithfully; do not claim a change went live when it did not.",
      "",
      "## Signed-in visitors and AI answers",
      "",
      "Visitors can sign in to the page with their Clawpage Agent account (asked once per page): `new Clawpage({ signIn: \"auto\" })` signs in, silently, anyone who allowed the page before (on every load; skip your start-up while `cp.redirecting`); `cp.signIn()` sends someone to sign in and back; `cp.user` is `{id, name, email}` or null; `await cp.signOut()`.",
      "- `signed-in` tables: signed-in visitors read every record, add records, and change or delete only their own (records carry `mine`). `per-user` tables: each signed-in visitor has records of their own under their own keys and sees no one else's. Both answer anonymous visitors with 401 `SIGN_IN_REQUIRED`; `SIGN_IN_EXPIRED` means sign in again. Through this API you act as the owner: records show who wrote them (`by`), and a per-user table's keys are stored as `<visitor id>.<key>`.",
      "- `const { text, json } = await cp.ai.ask(input, { prompt: \"<name>\", json: true, effort: \"low\" })` answers with the signed-in visitor's own AI (their model and quota; no tools, web or memory). `prompt` names a file `prompts/<name>.md` in the page folder: the task, the rubric and the exact JSON fields to return. The page sends the material as labelled text in `input` (or `{messages: [{role, content}]}`). Errors: `SIGN_IN_REQUIRED`, `PROMPT_NOT_FOUND`, `RATE_LIMITED` (10 a minute, 300 a day per person and page), `AI_BUSY`, `AI_FAILED`, `AI_TIMEOUT`; in a `file://` preview, `PREVIEW`.",
      "",
    ].join("\n");
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
    const match = /^\/share\/([a-zA-Z0-9_]+)\/pages(?:\/([^/]+)(?:\/(files|data|cover|collaborators)((?:\/[^/]+)*))?)?$/.exec(url.pathname);
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
        return files === undefined ? reply(405, { error: "method_not_allowed" }) : files ? reply(200, { name, updatedAt: this.#meta(userId, name!)?.updatedAt, files }) : reply(404, { error: "The page does not exist" });
      }
      if (sub === "collaborators") {
        const id = (tail ?? "").split("/").filter(Boolean);
        if (req.method === "GET" && !id.length) return this.exists(userId, name!) ? reply(200, { collaborators: this.data?.collaborators(userId, name!) ?? [] }) : reply(404, { error: "The page does not exist" });
        if (req.method === "POST" && !id.length) return reply(201, this.invite(userId, name!, (await readJson(req, 4096)).label));
        if (req.method === "DELETE" && id.length === 1) return this.data?.removeCollaborator(userId, name!, id[0]!) ? reply(204) : reply(404, { error: "No such collaborator" });
        return reply(405, { error: "method_not_allowed" });
      }
      if (sub === "cover") {
        if (req.method !== "POST" || tail) return reply(405, { error: "method_not_allowed" });
        const body = await readJson(req, Math.ceil(COVER_MAX_BYTES * 1.4) + 1024).catch((err: unknown) => {
          if (err instanceof DataError) throw new ShareError(err.status, err.message);
          throw err;
        });
        if (typeof body.data !== "string") return reply(400, { error: "No cover data" });
        return reply(200, { name, cover: this.setCover(userId, name!, Buffer.from(body.data, "base64")) });
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
      reply(200, this.publish(userId, name, await readPublish(req)));
    } catch (err) {
      if (err instanceof ShareError) reply(err.status, { error: err.message });
      else if (err instanceof DataError) reply(err.status, { error: err.message, code: err.code });
      else reply(500, { error: "The request failed" });
    }
  }

  /** `/u/<username>/share/<name>/.api/...`: the page for the agents of the collaborators its owner invited. */
  async #serveApi(req: Request, res: Response, userId: string, page: string, rest: string, query: string): Promise<void> {
    const reply = (status: number, body?: unknown) => {
      res.status(status).set(API_HEADERS);
      if (body === undefined) res.end();
      else res.send(JSON.stringify(body));
    };
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const collaborator = token && this.exists(userId, page) ? this.data?.collaboratorOf(token, userId, page) : null;
    if (!collaborator) return reply(401, { error: "UNAUTHORIZED", message: "This needs a collaborator token for this page: Authorization: Bearer cpc_..." });
    const method = req.method ?? "GET";
    try {
      const [sub, ...tail] = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
      if (sub === undefined && method === "GET") return reply(200, this.describe(userId, page, collaborator.label));
      if (sub === undefined && method === "POST") return reply(200, this.publish(userId, page, await readPublish(req), collaborator.label));
      if (sub === "prompt" && !tail.length && method === "GET") {
        res.status(200).set({ ...API_HEADERS, "content-type": "text/markdown; charset=utf-8" }).send(this.agentPrompt(userId, page, collaborator.label));
        return;
      }
      if (sub === "files" && !tail.length && method === "GET") return reply(200, { name: page, updatedAt: this.#meta(userId, page)?.updatedAt, files: this.files(userId, page) });
      if (sub === "cover" && !tail.length && method === "POST") {
        const body = await readJson(req, Math.ceil(COVER_MAX_BYTES * 1.4) + 1024);
        if (typeof body.data !== "string") return reply(400, { error: "MISSING_COVER", message: "No cover data" });
        return reply(200, { name: page, cover: this.setCover(userId, page, Buffer.from(body.data, "base64")) });
      }
      if (sub === "data") {
        const body = method === "GET" || method === "DELETE" ? {} : await readJson(req, DATA_BODY.owner);
        const out = this.dataRequest(userId, page, tail, method, new URLSearchParams(query), body, { owner: true, manage: false, collaborator: collaborator.label });
        return reply(out.status, out.body);
      }
      reply(sub === undefined || ["prompt", "files", "cover"].includes(sub) ? 405 : 404, { error: "NOT_FOUND", message: `${method} ${sub ?? ""} is not part of this API; GET it for the instructions` });
    } catch (err) {
      if (err instanceof ShareError) reply(err.status, { error: SHARE_CODES[err.status] ?? "FAILED", message: err.message });
      else if (err instanceof DataError) reply(err.status, { error: err.code, message: err.message });
      else if (err instanceof URIError) reply(400, { error: "INVALID_PATH", message: "Invalid path" });
      else reply(500, { error: "INTERNAL", message: "The request failed" });
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
    const visitor = !owner && data.isVisitorToken(token) ? data.visitorOf(token, userId, page) : null;
    // A page holding a stale sign-in is told so, never quietly treated as anonymous (its writes would lose their author).
    if (!owner && data.isVisitorToken(token) && !visitor) return reply(401, { error: "SIGN_IN_EXPIRED", message: "The sign-in has expired or was signed out; sign in again" });
    const write = req.method !== "GET" && req.method !== "HEAD";
    if (!owner && !data.allow(req.paCtx?.ip ?? "unknown", userId, page, write ? "writes" : "reads")) {
      return reply(429, { error: "RATE_LIMITED", message: "Too many requests; try again in a minute" });
    }
    try {
      const segments = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
      const body = write && req.method !== "DELETE" ? await readJson(req, owner ? DATA_BODY.owner : DATA_BODY.visitor) : {};
      // The page's script holds an owner link's token: it uses the tables, never manages them (a collaborator may have written it).
      const out = this.dataRequest(userId, page, segments, req.method === "HEAD" ? "GET" : req.method, new URLSearchParams(query), body, { owner, manage: false, ip: req.paCtx?.ip, visitor });
      reply(out.status, out.body);
    } catch (err) {
      if (err instanceof DataError) reply(err.status, { error: err.code, message: err.message });
      else if (err instanceof URIError) reply(400, { error: "INVALID_PATH", message: "Invalid path" });
      else reply(500, { error: "INTERNAL", message: "The request failed" });
    }
  }

  /**
   * `/u/<username>/share/<name>/.auth[/sign-in]`: a page's visitors signing in.
   * `sign-in` sends the browser to the console's origin (which knows the person and asks them once
   * per page); `GET .auth` with a visitor token says who it names, `DELETE` signs them out of the page.
   */
  #serveAuth(req: Request, res: Response, userId: string, page: string, rest: string, query: string): void {
    const reply = (status: number, body?: unknown) => {
      res.status(status).set(DATA_HEADERS);
      if (body === undefined) res.end();
      else res.send(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return reply(204);
    if (!this.data || !this.exists(userId, page)) return reply(404, { error: "PAGE_NOT_FOUND", message: "The page does not exist" });
    if (rest === "/sign-in") {
      if (req.method !== "GET") return reply(405, { error: "METHOD_NOT_ALLOWED", message: "GET only" });
      const params = new URLSearchParams(query);
      const target = new URLSearchParams({ owner: this.#usernameOf(userId) ?? userId, page, return: pageReturn(params.get("return")) });
      if (params.get("silent") === "1") target.set("silent", "1");
      res.status(302).set({ location: `https://${this.#cfg.primaryHost}/api/clawpage-sso/authorize?${target}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
      return;
    }
    if (rest !== "" && rest !== "/") return reply(404, { error: "NOT_FOUND", message: "No such path" });
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const visitor = this.data.visitorOf(token, userId, page);
    if (!visitor) return reply(401, { error: "SIGN_IN_REQUIRED", message: "Not signed in to this page" });
    if (req.method === "GET") return reply(200, { user: visitor });
    if (req.method === "DELETE") { this.data.revokeGrant(userId, page, visitor.id); return reply(204); }
    reply(405, { error: "METHOD_NOT_ALLOWED", message: `${req.method} is not allowed here` });
  }

  /** The page's prompt for its AI answers, or null when it has none of that name. */
  prompt(userId: string, page: string, name: string): string | null {
    if (!PROMPT_NAME.test(name)) return null;
    try {
      const file = path.join(this.#userDir(userId), page, "prompts", `${name}.md`);
      if (fs.statSync(file).size > PROMPT_MAX) throw new DataError(413, "PROMPT_TOO_LARGE", `prompts/${name}.md is larger than ${PROMPT_MAX / 1024} KB`);
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err instanceof DataError) throw err;
      return null;
    }
  }

  /**
   * `/u/<username>/share/<name>/.ai`: an answer from the signed-in visitor's own AI. The page names
   * one of its published prompts (`prompts/<name>.md`) and sends the conversation; nothing else of
   * the visitor's account is involved, and the page never learns which model answered beyond its name.
   */
  async #serveAi(req: Request, res: Response, userId: string, page: string, rest: string): Promise<void> {
    const reply = (status: number, body?: unknown) => {
      res.status(status).set(DATA_HEADERS);
      if (body === undefined) res.end();
      else res.send(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return reply(204);
    if (!this.data || !this.exists(userId, page)) return reply(404, { error: "PAGE_NOT_FOUND", message: "The page does not exist" });
    if (rest !== "" && rest !== "/") return reply(404, { error: "NOT_FOUND", message: "No such path" });
    if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED", message: "POST only" });
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const visitor = this.data.visitorOf(token, userId, page);
    if (!visitor) return reply(401, { error: this.data.isVisitorToken(token) ? "SIGN_IN_EXPIRED" : "SIGN_IN_REQUIRED", message: "AI answers need the visitor to sign in to this page" });
    if (!this.ai) return reply(503, { error: "AI_UNAVAILABLE", message: "This deployment offers no AI answers" });
    try {
      const body = await readJson(req, AI_INPUT.body);
      const ask = aiInput(body);
      const instructions = ask.prompt === null ? null : this.prompt(userId, page, ask.prompt);
      if (ask.prompt !== null && instructions === null) throw new DataError(404, "PROMPT_NOT_FOUND", `The page has no prompts/${ask.prompt}.md`);
      if (!this.data.allowAi(visitor.id, userId, page)) return reply(429, { error: "RATE_LIMITED", message: "Too many AI requests; try again in a minute" });
      const meta = this.#meta(userId, page);
      const answer = await this.ai.answer(visitor.id, { system: aiSystem(meta?.title ?? page, this.#usernameOf(userId) ?? userId, instructions, ask.json), messages: ask.messages, effort: ask.effort });
      reply(200, { text: answer.text, ...(ask.json ? { json: parseJsonAnswer(answer.text) } : {}), model: answer.model });
    } catch (err) {
      if (err instanceof DataError || err instanceof AiError) reply(err.status, { error: err.code, message: err.message });
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
      const apiPath = rawName && SHARE_NAME.test(rawName) && rest !== undefined ? /^\/\.api(\/.*)?$/.exec(rest) : null;
      const authPath = rawName && SHARE_NAME.test(rawName) && rest !== undefined ? /^\/\.auth(\/.*)?$/.exec(rest) : null;
      const aiPath = rawName && SHARE_NAME.test(rawName) && rest !== undefined ? /^\/\.ai(\/.*)?$/.exec(rest) : null;
      if (authPath || aiPath) {
        const userId = this.#userIdOf(username!);
        if (!userId) return void res.status(404).set(DATA_HEADERS).send(JSON.stringify({ error: "PAGE_NOT_FOUND", message: "The page does not exist" }));
        if (authPath) return this.#serveAuth(req, res, userId, rawName!, authPath[1] ?? "", query);
        void this.#serveAi(req, res, userId, rawName!, aiPath![1] ?? "");
        return;
      }
      if (apiPath) {
        const userId = this.#userIdOf(username!);
        if (!userId) return void res.status(401).set(API_HEADERS).send(JSON.stringify({ error: "UNAUTHORIZED", message: "This needs a collaborator token for this page" }));
        void this.#serveApi(req, res, userId, rawName!, apiPath[1] ?? "", query);
        return;
      }
      if (dataPath) {
        const userId = this.#userIdOf(username!);
        if (!userId) return void res.status(404).set(DATA_HEADERS).send(JSON.stringify({ error: "PAGE_NOT_FOUND", message: "The page does not exist" }));
        void this.#serveData(req, res, userId, rawName!, dataPath[1] ?? "", query);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      const notFound = () => {
        res.status(404).set({ ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).send(t(requestLocale(req.headers)).http.share.notFound);
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
      // The guide is for the agents working on the page, not its visitors (any case: the disk may not care).
      if (!segments || segments.join("/").toLowerCase() === GUIDE.toLowerCase()) return notFound();
      const pageDir = path.join(this.#userDir(userId), rawName);
      const file = path.join(pageDir, ...segments);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        return notFound();
      }
      if (!stat.isFile() || !file.startsWith(pageDir + path.sep)) return notFound();
      // Publishing writes every file anew, so a file's size and time name its version. Weak, because the
      // CDN in front compresses pages and drops a strong ETag when it does (a weak one it keeps).
      const tag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      const etag = `W/${tag}`;
      const ifNoneMatch = req.headers["if-none-match"];
      const known = String(ifNoneMatch ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
      const since = ifNoneMatch === undefined ? Date.parse(String(req.headers["if-modified-since"] ?? "")) : NaN;
      if (known.includes(tag) || Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
        res.status(304).set({ ...PAGE_HEADERS, etag, "last-modified": stat.mtime.toUTCString() }).end();
        return;
      }
      res.status(200).set({
        ...PAGE_HEADERS,
        etag,
        "last-modified": stat.mtime.toUTCString(),
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(stat.size),
      });
      if (req.method === "HEAD") return res.end();
      const stream = fs.createReadStream(file).on("error", () => res.destroy());
      res.on("close", () => stream.destroy()); // an aborted download would otherwise keep the fd open
      stream.pipe(res);
    };
  }
}

/** The `error` code of a ShareError on the collaborators' API, by its status. */
const SHARE_CODES: Record<number, string> = { 400: "BAD_REQUEST", 404: "PAGE_NOT_FOUND", 409: "PAGE_CHANGED", 413: "TOO_LARGE" };

/** A publish's body: the page's files in base64, which inflates them by a third; room is left for the JSON around them. */
async function readPublish(req: http.IncomingMessage): Promise<PublishInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > SHARE_LIMITS.bytes * 1.5) throw new ShareError(413, `The total page size exceeds the limit of ${SHARE_LIMITS.bytes / 1024 / 1024} MB`);
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as PublishInput;
  } catch {
    throw new ShareError(400, "The request is not valid JSON");
  }
}

/**
 * A JSON object body, at most `limit` bytes. A larger one is read to its end (up to four times the
 * limit) before the 413, so the caller gets the answer instead of a connection cut mid-upload.
 */
async function readJson(req: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit * 4) throw new DataError(413, "BODY_TOO_LARGE", "The request body is too large");
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  if (size > limit) throw new DataError(413, "BODY_TOO_LARGE", "The request body is too large");
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new DataError(400, "INVALID_JSON", "The request body must be a JSON object");
  }
}

/**
 * A path inside a page to come back to after signing in: relative to the page's folder, with its
 * query; anything that could lead elsewhere (an absolute path, `..`, a scheme, a fragment) is dropped.
 */
export function pageReturn(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512 || /[\u0000-\u001f\u007f\\#]/.test(raw)) return "";
  const [rel, query] = [raw.split("?")[0]!, raw.includes("?") ? raw.slice(raw.indexOf("?")) : ""];
  if (rel && !safeSegments(rel.endsWith("/") ? `${rel}index.html` : rel)) return "";
  // The browser decodes %2e%2e as "..": check each segment as it will be resolved.
  try {
    const decoded = rel.split("/").map(decodeURIComponent);
    if (decoded.some((s) => /[/\\]/.test(s))) return "";
    const plain = decoded.join("/");
    if (plain && !safeSegments(plain.endsWith("/") ? `${plain}index.html` : plain)) return "";
  } catch {
    return "";
  }
  return rel + query;
}

/** What a page asks the AI: its prompt's name, the conversation (or one `input`), JSON or text, how hard to think. */
function aiInput(body: Record<string, unknown>): { prompt: string | null; messages: AiMessage[]; json: boolean; effort: AiEffort } {
  const prompt = body.prompt === undefined || body.prompt === null ? null : String(body.prompt);
  if (prompt !== null && !PROMPT_NAME.test(prompt)) throw new DataError(400, "INVALID_PROMPT", "prompt names a file prompts/<name>.md: lowercase letters, digits, - or _");
  const raw = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.messages;
  if (!Array.isArray(raw) || !raw.length || raw.length > AI_INPUT.messages) throw new DataError(400, "INVALID_MESSAGES", `Send input (text) or messages (1-${AI_INPUT.messages} of {role: "user"|"assistant", content: text})`);
  let chars = 0;
  const messages = raw.map((m: unknown) => {
    const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) throw new DataError(400, "INVALID_MESSAGES", "Each message is {role: \"user\"|\"assistant\", content: non-empty text}");
    chars += content.length;
    return { role, content } as AiMessage;
  });
  if (chars > AI_INPUT.chars) throw new DataError(413, "INPUT_TOO_LARGE", `The messages hold at most ${AI_INPUT.chars} characters`);
  if (messages.at(-1)!.role !== "user") throw new DataError(400, "INVALID_MESSAGES", "The last message is the user's");
  const effort = body.effort === undefined ? "low" : body.effort;
  if (!AI_EFFORTS.includes(effort as AiEffort)) throw new DataError(400, "INVALID_EFFORT", `effort is one of ${AI_EFFORTS.join(", ")}`);
  return { prompt, messages, json: body.json === true, effort: effort as AiEffort };
}

/** The frame around a page's prompt (models read English): who is asking, what the model cannot do, the answer's form. */
function aiSystem(title: string, owner: string, instructions: string | null, json: boolean): string {
  return [
    `You answer requests from "${title}", a web page / mini app made by ${owner} with Clawpage Agent, for the person using it, on their own AI.`,
    "You have no tools: you cannot browse, run code, look anything up or remember earlier requests; everything you know about the task is in this prompt and the messages.",
    "Answer only what the page asks, in the language its instructions or the person's text call for.",
    ...(json ? ["Reply with exactly one JSON object and nothing else: no code fences, no text before or after it."] : []),
    ...(instructions?.trim() ? ["", "The page's instructions:", "", instructions.trim()] : []),
  ].join("\n");
}

/** The JSON object an answer holds (models sometimes fence it anyway), or null when it holds none. */
export function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{"), end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
