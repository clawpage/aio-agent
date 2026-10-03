import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import type { Logger } from "../common/logger.js";
import type { AppContext } from "./context.js";
import type { TabRecord } from "./browser/tabs.js";
import { randomId } from "./auth/passwords.js";

/**
 * The password vault: accounts a person saved so the agent can sign in for them
 * without ever being told the password.
 *
 * Passwords are kept in the account's own control database, encrypted
 * (AES-256-GCM) with a key that lives in a 0600 file beside it and never enters
 * a sandbox. They leave this module in two ways only: to the signed-in person
 * who asks to see one, and to the tab server, which types one into the page of
 * the site it was saved for.
 */
export interface VaultEntry {
  id: string;
  /** Host the account belongs to; it covers that host and its subdomains. */
  site: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface Row {
  id: string;
  site: string;
  username: string;
  secret: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export const VAULT_MAX_ENTRIES = 200;
const MAX_USERNAME = 200;
const MAX_PASSWORD = 1000;

/** A host from what a person typed (a host or a whole address), or null. */
export function normalizeSite(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim().toLowerCase();
  if (!text || text.length > 300) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
    return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** The host of a web page, or null for anything that is not one. */
export function siteOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A saved site covers its own host and its subdomains, never a look-alike. */
export function siteCovers(site: string, host: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

export class VaultError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export class Vault {
  readonly #db: Db;
  readonly #ownerId: string;
  readonly #keyFile: string;
  #key: Buffer | null = null;

  constructor(db: Db, dataDir: string, ownerId: string) {
    this.#db = db;
    this.#ownerId = ownerId;
    this.#keyFile = path.join(dataDir, "vault-key");
  }

  /** Created on first use; a vault nobody uses leaves no key behind. */
  #loadKey(): Buffer {
    if (this.#key) return this.#key;
    let hex: string;
    try {
      hex = fs.readFileSync(this.#keyFile, "utf8").trim();
    } catch {
      hex = randomBytes(32).toString("hex");
      fs.mkdirSync(path.dirname(this.#keyFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.#keyFile, `${hex}\n`, { mode: 0o600, flag: "wx" });
    }
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) throw new VaultError("bad_key", "密码器密钥文件损坏", 500);
    this.#key = key;
    return key;
  }

  /** The entry id is bound into the ciphertext, so a secret cannot be moved to another row. */
  #seal(id: string, password: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#loadKey(), iv);
    cipher.setAAD(Buffer.from(id));
    const body = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
  }

  #open(id: string, sealed: string): string | null {
    const [version, iv, tag, body] = sealed.split(":");
    if (version !== "v1" || !iv || !tag || body === undefined) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#loadKey(), Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  #view(row: Row): VaultEntry {
    return { id: row.id, site: row.site, username: row.username, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at };
  }

  #row(id: string): Row | null {
    return (this.#db.prepare("SELECT * FROM vault_entries WHERE id = ? AND owner_id = ?").get(id, this.#ownerId) as unknown as Row | undefined) ?? null;
  }

  /** Every saved account, without its password. */
  list(): VaultEntry[] {
    return (this.#db.prepare("SELECT * FROM vault_entries WHERE owner_id = ? ORDER BY site, username").all(this.#ownerId) as unknown as Row[]).map((r) => this.#view(r));
  }

  /** The accounts saved for the site a page is on. */
  matching(host: string): VaultEntry[] {
    return this.list().filter((e) => siteCovers(e.site, host));
  }

  get(id: string): VaultEntry | null {
    const row = this.#row(id);
    return row ? this.#view(row) : null;
  }

  /** The password itself: for the person who saved it, or for the page it was saved for. */
  secret(id: string): string | null {
    const row = this.#row(id);
    return row ? this.#open(row.id, row.secret) : null;
  }

  #checked(input: { site?: unknown; username?: unknown; password?: unknown }, required: boolean): { site?: string; username?: string; password?: string } {
    const out: { site?: string; username?: string; password?: string } = {};
    if (input.site !== undefined || required) {
      const site = normalizeSite(input.site);
      if (!site) throw new VaultError("bad_site", "网站写成域名或网址，例如 github.com");
      out.site = site;
    }
    if (input.username !== undefined || required) {
      if (typeof input.username !== "string" || input.username.length > MAX_USERNAME) throw new VaultError("bad_username", `账号最多 ${MAX_USERNAME} 个字`);
      out.username = input.username.trim();
    }
    if (input.password !== undefined || required) {
      if (typeof input.password !== "string" || !input.password || input.password.length > MAX_PASSWORD) throw new VaultError("bad_password", `密码不能为空，最多 ${MAX_PASSWORD} 个字`);
      out.password = input.password;
    }
    return out;
  }

  create(input: { site: unknown; username: unknown; password: unknown }): VaultEntry {
    const v = this.#checked(input, true);
    const count = (this.#db.prepare("SELECT COUNT(*) AS n FROM vault_entries WHERE owner_id = ?").get(this.#ownerId) as { n: number }).n;
    if (count >= VAULT_MAX_ENTRIES) throw new VaultError("full", `密码器最多保存 ${VAULT_MAX_ENTRIES} 个账号`, 409);
    const id = randomId("vault");
    const now = Date.now();
    this.#db
      .prepare("INSERT INTO vault_entries (id, owner_id, site, username, secret, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, this.#ownerId, v.site!, v.username!, this.#seal(id, v.password!), now, now);
    return this.get(id)!;
  }

  update(id: string, input: { site?: unknown; username?: unknown; password?: unknown }): VaultEntry | null {
    const row = this.#row(id);
    if (!row) return null;
    const v = this.#checked(input, false);
    this.#db
      .prepare("UPDATE vault_entries SET site = ?, username = ?, secret = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
      .run(v.site ?? row.site, v.username ?? row.username, v.password === undefined ? row.secret : this.#seal(id, v.password), Date.now(), id, this.#ownerId);
    return this.get(id);
  }

  remove(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM vault_entries WHERE id = ? AND owner_id = ?").run(id, this.#ownerId).changes) > 0;
  }

  used(id: string): void {
    this.#db.prepare("UPDATE vault_entries SET last_used_at = ? WHERE id = ? AND owner_id = ?").run(Date.now(), id, this.#ownerId);
  }
}

/** What a sign-in attempt came to; never the account or the password. */
export type VaultLoginResult = { ok: true; result: string } | { ok: false; status: number; error: string; message: string };

/** Sign in on a tab whose agent asked, with a saved account or with one the person just typed. */
export async function vaultLogin(
  ctx: Pick<AppContext, "tabs" | "vault">,
  tab: TabRecord,
  input: { entryId?: unknown; username?: unknown; password?: unknown; save?: unknown },
): Promise<VaultLoginResult> {
  const fail = (status: number, error: string, message: string): VaultLoginResult => ({ ok: false, status, error, message });
  if (!ctx.tabs || !ctx.vault) return fail(404, "not_found", "密码器不可用");
  const host = siteOfUrl(tab.url);
  if (tab.request?.kind !== "login" || tab.holder !== "ai" || !host) return fail(409, "no_request", "这个页面没有在等待登录");
  let username: string;
  let password: string;
  let entryId: string | null = null;
  if (typeof input.entryId === "string") {
    const entry = ctx.vault.get(input.entryId);
    const secret = entry ? ctx.vault.secret(entry.id) : null;
    // An account is only ever typed into the site it was saved for.
    if (!entry || !siteCovers(entry.site, host)) return fail(404, "no_entry", "密码器里没有这个网站的这个账号");
    if (secret === null) return fail(500, "unreadable", "这个账号的密码读不出来了，请在密码器里重新保存");
    username = entry.username;
    password = secret;
    entryId = entry.id;
  } else {
    if (typeof input.username !== "string" || typeof input.password !== "string" || !input.password) return fail(400, "bad_request", "请输入账号和密码");
    username = input.username.trim();
    password = input.password;
    if (input.save !== false) {
      const same = ctx.vault.matching(host).find((e) => e.username === username);
      entryId = same ? ctx.vault.update(same.id, { password })!.id : ctx.vault.create({ site: host, username, password }).id;
    }
  }
  const out = await ctx.tabs.login(tab.key, tab.id, { site: host, username, password });
  if (out.status !== 200) return fail(out.status, String(out.body.error ?? "failed"), String(out.body.message ?? "没能填入，请稍后重试"));
  if (entryId && out.body.result === "submitted") ctx.vault.used(entryId);
  return { ok: true, result: String(out.body.result ?? "") };
}

/**
 * Signs in by itself when exactly one saved account fits the page an agent is
 * waiting on. Anything less certain (no account, several, or a second request
 * right after a sign-in that did not take) is left for the person to decide.
 */
export function startVaultAutofill(ctx: AppContext, intervalMs = 2500, retryAfterMs = 10 * 60_000): { stop(): void; tick(): Promise<void> } {
  const seen = new Set<string>();
  const filled = new Map<string, number>();
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy || !ctx.tabs || !ctx.vault || !ctx.tasks.hasRunning()) return;
    busy = true;
    try {
      for (const tab of await ctx.tabs.list()) {
        if (tab.request?.kind !== "login" || tab.holder !== "ai") continue;
        const request = `${tab.id}:${tab.request.at}`;
        if (seen.has(request)) continue;
        seen.add(request);
        const host = siteOfUrl(tab.url);
        const entries = host ? ctx.vault.matching(host) : [];
        const again = `${tab.id}:${host}`;
        if (entries.length !== 1 || Date.now() - (filled.get(again) ?? 0) < retryAfterMs) continue;
        filled.set(again, Date.now());
        const out = await vaultLogin(ctx, tab, { entryId: entries[0]!.id });
        ctx.log.info("vault sign-in", { site: host, result: out.ok ? out.result : out.error });
      }
    } catch (err) {
      ctx.log.debug("vault autofill pass failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
