import { afterAll, beforeAll, expect, it, vi } from "vitest";
import path from "node:path";
import { startHarness, login, type TestHarness } from "../helpers/harness.js";
import { ShareStore } from "../../src/control/share.js";
import { ClawpageData } from "../../src/control/clawpages.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { pageIdentity } from "../../src/control/profile.js";
import { getKbNode, searchKb } from "../../src/control/taskKb/read.js";
import { openDb } from "../../src/control/db.js";
import { syncProfileMemory } from "../../src/control/profile.js";
import type { AppContext } from "../../src/control/context.js";

let h: TestHarness;
let owner: Record<string, string>;
/** The accounts whose runtime the console asked for (a new account's starts at registration). */
const started: string[] = [];
const json = { "content-type": "application/json" };

beforeAll(async () => {
  h = await startHarness();
  const auth = await login(h);
  owner = { cookie: auth.cookie, "x-csrf-token": auth.csrf, ...json };
  // One runtime stands in for every account's (its database is the central one here).
  h.ctx.runtimeForUser = async (id: string): Promise<AppContext> => { started.push(id); return h.ctx; };
  const lookup = (sql: string, v: string) => (h.ctx.db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  h.ctx.share = new ShareStore({
    cfg: h.ctx.cfg, port: 0,
    usernameOf: (id) => lookup("SELECT username AS v FROM owners WHERE id=?", id),
    userIdOf: (name) => lookup("SELECT id AS v FROM owners WHERE username=?", name),
    data: new ClawpageData(path.join(h.dataDir, "clawpages")),
  });
  h.ctx.share.publish("owner_1", "toefl", { title: "每日托福", files: [{ path: "index.html", data: Buffer.from("<p>hi</p>").toString("base64") }] });
});
afterAll(async () => { await h?.shutdown(); });

async function register(email: string): Promise<{ id: string; username: string; headers: Record<string, string> }> {
  h.ctx.db.prepare("DELETE FROM login_failures").run();
  const res = await h.request("/api/auth/register", { method: "POST", headers: json, body: JSON.stringify({ email, password: "member-password-123" }) });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie();
  const csrf = decodeURIComponent(/pa_csrf=([^;]+)/.exec(setCookie.join(";"))?.[1] ?? "");
  const { username } = (await res.json()) as { username: string };
  const id = (h.ctx.db.prepare("SELECT id FROM owners WHERE username=?").get(username) as { id: string }).id;
  return { id, username, headers: { cookie: setCookie.map((c) => c.split(";")[0]!).join("; "), "x-csrf-token": csrf, ...json } };
}
const session = async (headers: Record<string, string>) => (await (await h.request("/api/auth/session", { headers })).json()) as { onboarding: boolean };
const getProfile = async (headers: Record<string, string>) => (await (await h.request("/api/profile", { headers })).json()) as { profile: Record<string, string>; onboarding: boolean };
const put = (headers: Record<string, string>, profile: unknown) => h.request("/api/profile", { method: "PUT", headers, body: JSON.stringify({ profile }) });
/** The account's profile node in its knowledge base (written in the background after a save). */
const profileNode = (id: string) => searchKb(h.ctx.db, id, { domain: "profile" });

it("starts a newly registered account on the profile step, once, while its runtime gets ready", async () => {
  const alice = await register("alice@example.com");
  // The account's runtime (sandbox, browser, agent session) was asked for at registration, before anything else.
  expect(started).toContain(alice.id);
  expect(await session(alice.headers)).toMatchObject({ onboarding: true });
  expect(await getProfile(alice.headers)).toEqual({ onboarding: true, profile: { nickname: "", preferredName: "", location: "", language: "", occupation: "", interests: "", notes: "" } });

  // Saving needs the session's CSRF token, like every other change.
  expect((await put({ ...alice.headers, "x-csrf-token": "wrong" }, { nickname: "A" })).status).toBe(403);
  const saved = await put(alice.headers, { nickname: "  小艾 ", preferredName: "艾老师", location: "Asia/Shanghai", notes: "回答简短\r\n\r\n\r\n先比价" });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ onboarding: false, profile: { nickname: "小艾", preferredName: "艾老师", location: "Asia/Shanghai", language: "", occupation: "", interests: "", notes: "回答简短\n\n先比价" } });
  expect(await session(alice.headers)).toMatchObject({ onboarding: false });
  expect((await getProfile(alice.headers)).profile.nickname).toBe("小艾");

  // Skipping instead: the step is over too, and the profile stays empty.
  const bob = await register("bob@example.com");
  expect(await session(bob.headers)).toMatchObject({ onboarding: true });
  expect((await h.request("/api/profile/skip", { method: "POST", headers: bob.headers, body: "{}" })).status).toBe(200);
  expect(await getProfile(bob.headers)).toMatchObject({ onboarding: false, profile: { nickname: "" } });

  // An account that never registered here (the owner) has no step to take.
  expect(await session(owner)).toMatchObject({ onboarding: false });
});

it("refuses what does not belong in a profile", async () => {
  const bad = async (profile: unknown) => { const r = await put(owner, profile); return [r.status, ((await r.json()) as { error: string }).error]; };
  expect(await bad({ nickname: "x".repeat(41) })).toEqual([400, "too_long"]);
  expect(await bad({ notes: "我的密码是 hunter2hunter2" })).toEqual([400, "sensitive"]);
  expect(await bad({ notes: "卡号 4111 1111 1111 1111" })).toEqual([400, "sensitive"]);
  expect(await bad({ nickname: 7 })).toEqual([400, "bad_request"]);
  expect(await bad("nickname")).toEqual([400, "bad_request"]);
  // The messages are the console's language.
  const r = await h.request("/api/profile", { method: "PUT", headers: { ...owner, "x-aio-locale": "zh-CN" }, body: JSON.stringify({ profile: { nickname: "x".repeat(41) } }) });
  expect(((await r.json()) as { message: string }).message).toBe("昵称最多 40 个字");
});

it("keeps one knowledge base entry for the profile, rewritten in place, gone when the profile is emptied", async () => {
  const carol = await register("carol@example.com");
  expect(profileNode(carol.id)).toEqual([]);
  expect((await put(carol.headers, { nickname: "Carol", interests: "photography, hiking", notes: "Keep answers short" })).status).toBe(200);
  await vi.waitFor(() => expect(profileNode(carol.id)).toHaveLength(1));
  const [first] = profileNode(carol.id);
  const node = getKbNode(h.ctx.db, carol.id, first!.id)!;
  // Named by the account's username, every claim the person's own words (no task behind them).
  expect(node.title).toBe(`${carol.username}'s profile`);
  expect(node.claims.map((c) => c.text)).toEqual([`${carol.username}'s nickname is "Carol"`, `${carol.username}'s interests: photography, hiking`, `${carol.username} would like the assistant to keep in mind: Keep answers short`]);
  expect(node.claims.every((c) => c.certainty === "user_said" && c.sources.every((s) => s.kind === "manual" && s.task === ""))).toBe(true);
  // Found by what is in it, as the executor searches.
  expect(searchKb(h.ctx.db, carol.id, { query: "hiking" }).map((n) => n.id)).toEqual([first!.id]);

  // A change rewrites the same entry: no second node, no claims left over from before.
  expect((await put(carol.headers, { nickname: "Caz", location: "Lisbon" })).status).toBe(200);
  await vi.waitFor(() => expect(getKbNode(h.ctx.db, carol.id, first!.id)!.claims.map((c) => c.text)).toEqual([`${carol.username}'s nickname is "Caz"`, `${carol.username}'s location or time zone: Lisbon`]));
  expect(profileNode(carol.id).map((n) => n.id)).toEqual([first!.id]);
  expect((h.ctx.db.prepare("SELECT count(*) AS n FROM kb_sources WHERE owner_id=?").get(carol.id) as { n: number }).n).toBe(2);
  expect(searchKb(h.ctx.db, carol.id, { query: "hiking" })).toEqual([]);

  // Emptied: the entry goes.
  expect((await put(carol.headers, {})).status).toBe(200);
  await vi.waitFor(() => expect(profileNode(carol.id)).toEqual([]));
  expect(h.ctx.db.prepare("SELECT 1 FROM kb_nodes WHERE id=?").get(first!.id)).toBeUndefined();
});

it("writes the copy in the account's language, and leaves a deleted copy deleted until the profile changes", () => {
  const central = openDb(":memory:"), account = openDb(":memory:");
  central.prepare("INSERT INTO owners (id,username,password_hash,password_salt,password_params,created_at) VALUES ('user_x','dana','h','s','{}',0)").run();
  central.prepare("INSERT INTO profiles (owner_id, preferred_name, updated_at) VALUES ('user_x','小丹',0)").run();
  account.prepare("INSERT INTO meta (key,value) VALUES ('account.locale','zh-CN')").run();
  expect(syncProfileMemory(central, account, "user_x")).toBe(true);
  const [hit] = searchKb(account, "user_x", { domain: "profile" });
  expect(hit).toMatchObject({ title: "dana 的个人资料", claims: ["dana 希望被称呼为「小丹」"] });
  // Nothing changed: nothing written (a runtime starting again does not touch it).
  expect(syncProfileMemory(central, account, "user_x")).toBe(false);
  account.prepare("DELETE FROM kb_nodes WHERE id=?").run(hit!.id);
  expect(syncProfileMemory(central, account, "user_x")).toBe(false);
  central.prepare("UPDATE profiles SET preferred_name='丹丹' WHERE owner_id='user_x'").run();
  expect(syncProfileMemory(central, account, "user_x")).toBe(true);
  expect(searchKb(account, "user_x", { domain: "profile" })[0]).toMatchObject({ claims: ["dana 希望被称呼为「丹丹」"] });
});

it("tells a clawpage only the account's public id and nickname, never its username or email", async () => {
  const erin = await register("erin.secret@example.com");
  const publicId = (h.ctx.db.prepare("SELECT public_id FROM owners WHERE id=?").get(erin.id) as { public_id: string }).public_id;
  const page = async () => ((await (await h.request("/api/clawpage-sso/page?owner=owner&page=toefl", { headers: erin.headers })).json()) as { account: unknown }).account;
  // No nickname yet: a name made from the public id.
  const before = await page();
  expect(before).toEqual({ id: publicId, name: expect.stringMatching(new RegExp(`${publicId.slice(0, 4)}$`, "i")) });
  expect((await put(erin.headers, { nickname: "Erin", preferredName: "Dr. E" })).status).toBe(200);
  expect(await page()).toEqual({ id: publicId, name: "Erin" });

  const granted = (await (await h.request("/api/clawpage-sso/grant", { method: "POST", headers: erin.headers, body: JSON.stringify({ owner: "owner", page: "toefl", return: "" }) })).json()) as { url: string };
  const token = decodeURIComponent(granted.url.split("#cpv=")[1]!);
  const who = await (await h.request("/u/owner/share/toefl/.auth", { host: "workspace", headers: { authorization: `Bearer ${token}` } })).text();
  expect(JSON.parse(who)).toEqual({ user: { id: publicId, name: "Erin" } });
  for (const leak of [erin.id, erin.username, "erin.secret", "@"]) {
    expect(who).not.toContain(leak);
    expect(Buffer.from(token.split(".")[1]!, "base64url").toString()).not.toContain(leak);
  }
  // The page owner sees the same: who wrote a record is the public id and the nickname.
  h.ctx.share!.data!.createTable("owner_1", "toefl", "notes", "signed-in");
  expect((await h.request("/u/owner/share/toefl/.data/notes", { host: "workspace", method: "POST", headers: { authorization: `Bearer ${token}`, ...json }, body: JSON.stringify({ value: { text: "hi" } }) })).status).toBe(201);
  const records = await (await h.request("/api/clawpages/toefl/tables/notes", { headers: owner })).text();
  expect(JSON.parse(records).records[0].by).toEqual({ id: publicId, name: "Erin" });
  for (const leak of [erin.id, erin.username, "@example"]) expect(records).not.toContain(leak);
});

it("moves an offline page's sign-ins and records too: back online, the same person is signed in to the same data", async () => {
  // A deployment from before public ids: rui signed in to owner's page, which is offline now.
  const rui = await register("rui@example.com");
  const dataDir = fs.mkdtempSync(path.join(h.dataDir, "offline-move-"));
  const old = new DatabaseSync(path.join(dataDir, "clawpages.sqlite"));
  old.exec(`CREATE TABLE cp_tables (user_id TEXT NOT NULL, page TEXT NOT NULL, name TEXT NOT NULL, permission TEXT NOT NULL, records INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, page, name));
    CREATE TABLE cp_records (user_id TEXT NOT NULL, page TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, bytes INTEGER NOT NULL, seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, author TEXT, PRIMARY KEY (user_id, page, tbl, key));
    CREATE TABLE cp_grants (user_id TEXT NOT NULL, page TEXT NOT NULL, visitor_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
      granted_at INTEGER NOT NULL, last_seen_at INTEGER, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, page, visitor_id));`);
  old.prepare("INSERT INTO cp_tables VALUES ('owner_1','quiz','progress','per-user',1,9,1,0,0)").run();
  old.prepare("INSERT INTO cp_records VALUES ('owner_1','quiz','progress',?,'{\"day\":3}',9,1,0,0,?)").run(`${rui.id}.state`, rui.id);
  old.prepare("INSERT INTO cp_grants VALUES ('owner_1','quiz',?,?,'rui@example.com',0,0,1)").run(rui.id, rui.username);
  old.close();
  const lookup = (sql: string, v: string) => (h.ctx.db.prepare(sql).get(v) as { v: string } | undefined)?.v ?? null;
  const store = new ShareStore({
    cfg: { ...h.ctx.cfg, dataDir }, port: 0,
    usernameOf: (id) => lookup("SELECT username AS v FROM owners WHERE id=?", id),
    userIdOf: (name) => lookup("SELECT id AS v FROM owners WHERE username=?", name),
    data: new ClawpageData(dataDir, (id) => pageIdentity(h.ctx.db, id)),
  });
  store.publish("owner_1", "quiz", { title: "Quiz", files: [{ path: "index.html", data: Buffer.from("<p>q</p>").toString("base64") }] });
  store.setOffline("owner_1", "quiz", true);
  const previous = h.ctx.share;
  h.ctx.share = store;
  try {
    const publicId = (h.ctx.db.prepare("SELECT public_id FROM owners WHERE id=?").get(rui.id) as { public_id: string }).public_id;
    const visitor = store.data!.visitors("owner_1", "quiz")[0]!;
    expect(visitor.id).toBe(publicId);
    expect(JSON.stringify(store.data!.db.prepare("SELECT * FROM cp_grants").all())).not.toMatch(new RegExp(`${rui.username}"|@example`));
    // Offline: nobody reaches it, signed in or not, and the console does not sign anyone in to it.
    const token = store.data!.visitorToken("owner_1", "quiz", visitor);
    expect((await h.request("/u/owner/share/quiz/.data/progress/state", { host: "workspace", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await h.request("/api/clawpage-sso/authorize?owner=owner&page=quiz&silent=1", { headers: rui.headers })).status).toBe(404);
    // Back online: the sign-in the person gave before still counts (no new question), and their record is theirs.
    store.setOffline("owner_1", "quiz", false);
    const back = (await h.request("/api/clawpage-sso/authorize?owner=owner&page=quiz&silent=1", { headers: rui.headers })).headers.get("location")!;
    const again = decodeURIComponent(back.split("#cpv=")[1]!);
    expect(again).toMatch(/^cpv1\./);
    expect(await (await h.request("/u/owner/share/quiz/.data/progress/state", { host: "workspace", headers: { authorization: `Bearer ${again}` } })).json()).toMatchObject({ key: "state", value: { day: 3 }, mine: true });
    // Deleting the page takes its sign-ins with it.
    store.remove("owner_1", "quiz");
    expect(store.data!.visitors("owner_1", "quiz")).toEqual([]);
  } finally {
    h.ctx.share = previous;
  }
});
