import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/control/db.js";
import { Logger } from "../../src/common/logger.js";
import { normalizeSite, siteCovers, siteOfUrl, startVaultAutofill, Vault, VAULT_MAX_ENTRIES, vaultLogin } from "../../src/control/vault.js";
import type { AppContext } from "../../src/control/context.js";
import type { TabRecord } from "../../src/control/browser/tabs.js";

const SECRET = "correct horse 电池 staple";
let dir: string, db: Db, vault: Vault;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-vault-"));
  db = openDb(":memory:");
  vault = new Vault(db, dir, "owner_1");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("password vault", () => {
  it("keeps passwords encrypted, lists accounts without them, and gives one back only by id", () => {
    const entry = vault.create({ site: "https://GitHub.com/login", username: " max ", password: SECRET });
    expect(entry).toMatchObject({ site: "github.com", username: "max", lastUsedAt: null });
    expect(JSON.stringify(vault.list())).not.toContain(SECRET);
    expect(vault.secret(entry.id)).toBe(SECRET);
    // Nothing readable in the database, and the key is a private file beside it.
    const stored = db.prepare("SELECT secret FROM vault_entries").get() as { secret: string };
    expect(stored.secret.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(db.prepare("SELECT * FROM vault_entries").all())).not.toContain(SECRET);
    expect(fs.statSync(path.join(dir, "vault-key")).mode & 0o777).toBe(0o600);
    // Another process with the same key file reads it; one with another key, or a row moved to another id, does not.
    expect(new Vault(db, dir, "owner_1").secret(entry.id)).toBe(SECRET);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "aio-vault-"));
    expect(new Vault(db, other, "owner_1").secret(entry.id)).toBeNull();
    fs.rmSync(other, { recursive: true, force: true });
    db.prepare("UPDATE vault_entries SET id = 'vault_moved'").run();
    expect(vault.secret("vault_moved")).toBeNull();
  });

  it("belongs to one account", () => {
    const entry = vault.create({ site: "github.com", username: "max", password: SECRET });
    const member = new Vault(db, dir, "user_2");
    expect(member.list()).toEqual([]);
    expect(member.secret(entry.id)).toBeNull();
    expect(member.update(entry.id, { username: "x" })).toBeNull();
    expect(member.remove(entry.id)).toBe(false);
    expect(vault.list()).toHaveLength(1);
  });

  it("matches a page to the site an account was saved for, subdomains included, look-alikes not", () => {
    expect(normalizeSite("  Accounts.Google.com ")).toBe("accounts.google.com");
    expect(normalizeSite("https://example.com:8443/path?x=1")).toBe("example.com");
    for (const bad of ["", "not a host", "exa mple.com/login", "-bad-.com", 5, null]) expect(normalizeSite(bad), String(bad)).toBeNull();
    expect(siteOfUrl("https://www.github.com/login")).toBe("www.github.com");
    for (const url of ["data:text/html,x", "file:///etc/passwd", "about:blank", "nonsense"]) expect(siteOfUrl(url)).toBeNull();
    expect(siteCovers("github.com", "github.com")).toBe(true);
    expect(siteCovers("github.com", "gist.github.com")).toBe(true);
    expect(siteCovers("github.com", "evilgithub.com")).toBe(false);
    expect(siteCovers("github.com", "github.com.evil.io")).toBe(false);
    expect(siteCovers("www.github.com", "github.com")).toBe(false);
    vault.create({ site: "github.com", username: "max", password: "a" });
    vault.create({ site: "example.org", username: "max", password: "b" });
    expect(vault.matching("gist.github.com").map((e) => e.site)).toEqual(["github.com"]);
    expect(vault.matching("evilgithub.com")).toEqual([]);
  });

  it("edits and removes accounts, and refuses what it cannot store", () => {
    const entry = vault.create({ site: "github.com", username: "max", password: "old" });
    expect(vault.update(entry.id, { username: "max2" })).toMatchObject({ username: "max2", site: "github.com" });
    expect(vault.secret(entry.id)).toBe("old");
    vault.update(entry.id, { password: SECRET, site: "gitlab.com" });
    expect(vault.secret(entry.id)).toBe(SECRET);
    expect(vault.get(entry.id)?.site).toBe("gitlab.com");
    expect(() => vault.create({ site: "no spaces allowed", username: "u", password: "p" })).toThrow("网站");
    expect(() => vault.create({ site: "a.com", username: "u", password: "" })).toThrow("密码");
    expect(() => vault.update(entry.id, { password: "x".repeat(1001) })).toThrow("密码");
    expect(vault.remove(entry.id)).toBe(true);
    expect(vault.list()).toEqual([]);
    for (let i = 0; i < VAULT_MAX_ENTRIES; i += 1) vault.create({ site: `s${i}.example.com`, username: "u", password: "p" });
    expect(() => vault.create({ site: "one-too-many.com", username: "u", password: "p" })).toThrow("最多");
  });
});

describe("signing in from the vault", () => {
  const tabRecord = (over: Partial<TabRecord> = {}): TabRecord => ({
    id: "t1", key: "conv_1", title: "任务", url: "https://github.com/login", createdAt: 1, lastUsed: 1, finishedAt: null, holder: "ai", humanSince: null,
    request: { kind: "login", site: "github.com", reason: "需要登录 github.com", at: 100 }, ...over,
  });
  function world(tabs: TabRecord[]) {
    const logins: Array<{ key: string; tab: string; account: { site: string; username: string; password: string } }> = [];
    let result = "submitted";
    const ctx = {
      vault,
      log: new Logger("error", undefined, false),
      tasks: { hasRunning: () => true },
      tabs: {
        list: async () => tabs,
        login: async (key: string, tab: string, account: { site: string; username: string; password: string }) => {
          logins.push({ key, tab, account });
          return { status: 200, body: { result } };
        },
      },
    } as unknown as AppContext;
    return { ctx, logins, answer: (r: string) => { result = r; } };
  }

  it("types a saved account only into the site it was saved for, and says nothing about it", async () => {
    const github = vault.create({ site: "github.com", username: "max", password: SECRET });
    const other = vault.create({ site: "example.org", username: "max", password: "other" });
    const { ctx, logins } = world([]);
    const out = await vaultLogin(ctx, tabRecord(), { entryId: github.id });
    expect(out).toEqual({ ok: true, result: "submitted" });
    expect(logins).toEqual([{ key: "conv_1", tab: "t1", account: { site: "github.com", username: "max", password: SECRET } }]);
    expect(vault.get(github.id)?.lastUsedAt).not.toBeNull();
    // An account for another site, a page nobody asked to sign in on, a tab a person holds: nothing is typed.
    expect(await vaultLogin(ctx, tabRecord(), { entryId: other.id })).toMatchObject({ ok: false, error: "no_entry" });
    expect(await vaultLogin(ctx, tabRecord({ request: { reason: "请帮忙", at: 1 } }), { entryId: github.id })).toMatchObject({ ok: false, error: "no_request" });
    expect(await vaultLogin(ctx, tabRecord({ holder: "human" }), { entryId: github.id })).toMatchObject({ ok: false, error: "no_request" });
    expect(await vaultLogin(ctx, tabRecord({ url: "data:text/html,x" }), { entryId: github.id })).toMatchObject({ ok: false, error: "no_request" });
    expect(logins).toHaveLength(1);
  });

  it("saves an account typed for a sign-in under the page's site, once, unless told not to", async () => {
    const { ctx, logins } = world([]);
    const page = tabRecord({ url: "https://accounts.example.com/signin" });
    expect(await vaultLogin(ctx, page, { username: "max@example.com", password: SECRET })).toEqual({ ok: true, result: "submitted" });
    expect(vault.list()).toMatchObject([{ site: "accounts.example.com", username: "max@example.com" }]);
    // The same account again updates its password instead of piling up.
    await vaultLogin(ctx, page, { username: "max@example.com", password: "new password" });
    expect(vault.list()).toHaveLength(1);
    expect(vault.secret(vault.list()[0]!.id)).toBe("new password");
    await vaultLogin(ctx, page, { username: "one-off", password: "x", save: false });
    expect(vault.list()).toHaveLength(1);
    expect(logins.map((l) => l.account.username)).toEqual(["max@example.com", "max@example.com", "one-off"]);
    expect(await vaultLogin(ctx, page, { username: "max", password: "" })).toMatchObject({ ok: false, status: 400 });
  });

  it("signs in by itself when exactly one account fits, once per request, and leaves a second request to the person", async () => {
    vault.create({ site: "github.com", username: "max", password: SECRET });
    const tabs = [tabRecord()];
    const { ctx, logins } = world(tabs);
    const auto = startVaultAutofill(ctx, 60_000);
    try {
      await auto.tick();
      await auto.tick();
      expect(logins).toHaveLength(1);
      // The agent asks again on the same tab right after: the saved password did not work, so the person decides.
      tabs[0] = tabRecord({ request: { kind: "login", site: "github.com", reason: "需要登录 github.com", at: 200 } });
      await auto.tick();
      expect(logins).toHaveLength(1);
      // Two accounts for a site, no account, or a plain request for the person: never automatic.
      vault.create({ site: "github.com", username: "work", password: "x" });
      tabs[0] = tabRecord({ id: "t2", request: { kind: "login", site: "github.com", reason: "r", at: 300 } });
      tabs.push(tabRecord({ id: "t3", url: "https://unknown.example/login", request: { kind: "login", site: "unknown.example", reason: "r", at: 300 } }), tabRecord({ id: "t4", request: { reason: "验证码", at: 300 } }));
      await auto.tick();
      expect(logins).toHaveLength(1);
    } finally {
      auto.stop();
    }
  });
});
