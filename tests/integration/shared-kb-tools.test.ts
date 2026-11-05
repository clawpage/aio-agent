import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { TASK_KB_POLICY, TaskKbGateway } from "../../src/control/taskKb/gateway.js";
import { LIBRARY_POLICY } from "../../src/control/taskKb/libraryTools.js";
import { SharedKbs } from "../../src/control/taskKb/shared.js";
import { getKbNode } from "../../src/control/taskKb/read.js";
import { t } from "../../src/control/i18n/index.js";

type Result = { content: Array<{ text: string }>; isError?: boolean };

/** Three accounts (owner, cr, yz), each with its own aio_task_kb URL on one gateway, sharing one set of libraries. */
async function setup() {
  const h = await startHarness();
  await createMember(h.ctx.db, "cr", "member-secret-123");
  await createMember(h.ctx.db, "yz", "member-secret-123");
  const idOf = (name: string) => (h.ctx.db.prepare("SELECT id FROM owners WHERE username=?").get(name) as { id: string }).id;
  const ids = { owner: "owner_1", cr: idOf("cr"), yz: idOf("yz") };
  const kbs = new SharedKbs({ db: h.ctx.db, dataDir: h.dataDir, log: h.ctx.log });
  const track = vi.fn();
  const container = { async execInSandbox() { return { code: 0, stdout: "", stderr: "" }; }, async writeFileInSandbox() {} };
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, primaryHost: "agent.example.com" };
  const runtimes = new Map(Object.values(ids).map((id) => [id, { db: h.ctx.db, tasks: h.ctx.tasks, cfg: { ...cfg, runtimeUserId: id, dataDir: path.join(h.dataDir, id) }, container, sharedKb: kbs, analytics: { track, trackOnce: vi.fn() } }]));
  const taskKb = new TaskKbGateway({ port: 0, log: h.ctx.log, runtimeFor: async (id) => runtimes.get(id)! });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, taskKb);
  await gateway.start();
  for (const rt of runtimes.values()) taskKb.provision(rt.cfg);
  const as = (who: keyof typeof ids) => async (name: string, args: Record<string, unknown> = {}) => (await (await fetch(runtimes.get(ids[who])!.cfg.taskKb!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })).json()).result as Result;
  const json = <T,>(r: Result) => { expect(r.isError, r.content[0]!.text).toBeFalsy(); return JSON.parse(r.content[0]!.text) as T; };
  const done = async () => { gateway.close(); kbs.close(); await h.shutdown(); };
  return { h, ids, kbs, track, as, json, done };
}

it("lets an agent set up a shared library, invite people and keep its entries, as the person could in the console", async () => {
  const { h, ids, kbs, track, as, json, done } = await setup();
  const owner = as("owner"), cr = as("cr");
  try {
    expect(TASK_KB_POLICY).toContain(LIBRARY_POLICY);
    expect(LIBRARY_POLICY).toContain("Never open the console");
    expect((await owner("kb_libraries")).content[0]!.text).toContain("belongs to no shared knowledge base");

    // Create from a preset, in the account's language, with the person as administrator.
    const created = json<{ id: string; name: string; rules: string }>(await owner("kb_library_create", { name: "家庭日用品 · 待购与消耗", preset: "family" }));
    expect(created.name).toBe("家庭日用品 · 待购与消耗");
    expect(created.rules).toBe(t(h.ctx.tasks.locale()).knowledge.presets.family);
    const lib = created.id;
    expect(kbs.library(lib)).toMatchObject({ admin_id: ids.owner, created_by: ids.owner });
    expect(json<Array<Record<string, unknown>>>(await owner("kb_libraries"))).toEqual([expect.objectContaining({
      id: lib, name: "家庭日用品 · 待购与消耗", admin: "owner", you_are_admin: true, members: ["owner"], invites: [], domains: expect.arrayContaining(["shopping", "other"]),
    })]);

    // An invitation link on the console's address, valid as long as the console's.
    const invite = json<{ invite: string; url: string; expires: string; message: string }>(await owner("kb_library_manage", { library: "家庭日用品 · 待购与消耗", action: "invite" }));
    expect(invite.url).toMatch(/^https:\/\/agent\.example\.com\/knowledge\?join=[A-Za-z0-9_-]{32}$/);
    // What the person forwards names the library, says to hand it to one's own agent, and ends with the whole link.
    expect(invite.message).toBe(t(h.ctx.tasks.locale()).knowledge.inviteMessage("家庭日用品 · 待购与消耗", invite.url));
    expect(invite.message).toContain("Clawpage Agent");
    expect(invite.message.endsWith(`\n${invite.url}`)).toBe(true);
    expect(LIBRARY_POLICY).toContain("never open the link in a browser");
    const row = h.ctx.db.prepare("SELECT created_at, expires_at, created_by FROM kb_library_invites WHERE id=?").get(invite.invite) as { created_at: number; expires_at: number; created_by: string };
    expect(row).toMatchObject({ created_by: ids.owner, expires_at: row.created_at + 7 * 86_400_000 });

    // Another account's agent joins from the link the person passed on.
    expect((await cr("kb_library_join", { link: invite.message })).content[0]!.text).toContain(`Joined the shared knowledge base "家庭日用品 · 待购与消耗" (${lib})`);
    // Handing in the same link again (or the whole forwarded message's link) says so instead of claiming a new join.
    expect((await cr("kb_library_join", { link: invite.url })).content[0]!.text).toBe(`The person is already a member of the shared knowledge base "家庭日用品 · 待购与消耗" (${lib}).`);
    expect(json<Array<Record<string, unknown>>>(await cr("kb_libraries"))).toMatchObject([{ id: lib, admin: "owner", you_are_admin: false, members: ["owner", "cr"], invites: [{ id: invite.invite, by: "owner", uses: 1 }] }]);

    // Entries are written as each person's own words, refused when they would hold secrets or a domain the library lacks.
    const { node } = json<{ node: string }>(await cr("kb_library_edit", { library: lib, action: "create_entry", title: "洗衣液", domain: "shopping", summary: "家里常用的洗衣液", claims: ["还剩半瓶"] }));
    expect((await cr("kb_library_edit", { library: lib, action: "create_entry", title: "门禁", claims: ["门禁密码是 123456"] })).isError).toBe(true);
    expect((await cr("kb_library_edit", { library: lib, action: "create_entry", title: "x", domain: "nonsense", claims: ["y"] })).isError).toBe(true);
    const { claim } = json<{ claim: string }>(await owner("kb_library_edit", { library: lib, action: "add_claim", node, text: "Costco 买 Tide 大桶" }));
    expect(json<{ library: string; claims: Array<{ text: string; sources: Array<{ from: string; kind: string }> }> }>(await owner("kb_get", { id: node }))).toMatchObject({
      library: "家庭日用品 · 待购与消耗",
      claims: expect.arrayContaining([expect.objectContaining({ text: "还剩半瓶", sources: [expect.objectContaining({ from: "cr", kind: "manual" })] })]),
    });
    expect((await cr("kb_library_edit", { library: lib, action: "update_claim", claim, text: "Costco 买 Tide 大桶（92 次装）" })).isError).toBeFalsy();
    expect((await owner("kb_library_edit", { library: lib, action: "update_entry", node, title: "洗衣液 Tide" })).isError).toBeFalsy();
    expect(getKbNode(kbs.db(lib), lib, node)!.title).toBe("洗衣液 Tide");

    // History, undo and putting one entry back, as the console's.
    const history = json<Array<{ id: number; by: string; kind: string }>>(await owner("kb_library_history", { library: lib }));
    expect(history.map((c) => `${c.by}:${c.kind}`)).toEqual(["owner:edit", "cr:edit", "owner:edit", "cr:edit"]);
    expect((await owner("kb_library_undo", { library: lib, change: history[1]!.id })).isError).toBe(true); // the rename came after it
    expect((await owner("kb_library_undo", { library: lib, change: history[0]!.id })).content[0]!.text).toMatch(/^Done, as change \d+\.$/);
    expect(getKbNode(kbs.db(lib), lib, node)!.title).toBe("洗衣液");
    expect((await owner("kb_library_undo", { library: lib, change: history[1]!.id })).content[0]!.text).toMatch(/^Done, as change \d+\.$/);
    expect(getKbNode(kbs.db(lib), lib, node)!.claims.map((c) => c.text).sort()).toEqual(["Costco 买 Tide 大桶", "还剩半瓶"]);
    expect((await owner("kb_library_undo", { library: lib, change: history[3]!.id })).isError).toBe(true); // later changes touched it
    // kb_get above counted a read on the entry; that is not a later change and does not block putting it back.
    const restored = await cr("kb_library_undo", { library: lib, change: history[3]!.id, node }); expect(restored.isError, restored.content[0]!.text).toBeFalsy();
    expect(getKbNode(kbs.db(lib), lib, node)!.claims.map((c) => c.text)).toEqual(["还剩半瓶"]);
    expect(json<unknown[]>(await cr("kb_library_history", { library: lib, node })).length).toBeGreaterThan(0);
    expect((await cr("kb_library_edit", { library: lib, action: "delete_entry", node })).isError).toBeFalsy();
    expect(getKbNode(kbs.db(lib), lib, node)).toBeNull();

    // Rules and name belong to every member.
    expect((await cr("kb_library_manage", { library: lib, action: "set_rules", rules: "只收日用品的库存和购买渠道" })).content[0]!.text).toBe("Rules saved as version 2.");
    expect((await cr("kb_library_manage", { library: lib, action: "rename", name: "日用品" })).isError).toBeFalsy();
    expect(kbs.library(lib)!.name).toBe("日用品");

    // The administrator hands over, then may leave; the last one out dissolves it.
    expect((await owner("kb_library_manage", { library: lib, action: "leave" })).isError).toBe(true);
    expect((await owner("kb_library_manage", { library: lib, action: "make_admin", member: "cr" })).isError).toBeFalsy();
    expect((await owner("kb_library_manage", { library: lib, action: "leave" })).content[0]!.text).toContain("Left the library");
    expect((await owner("kb_libraries")).content[0]!.text).toContain("belongs to no shared knowledge base");
    expect((await cr("kb_library_manage", { library: lib, action: "leave" })).content[0]!.text).toContain("dissolved");
    expect(kbs.library(lib)).toBeNull();
    expect(fs.existsSync(path.join(h.dataDir, "kbs", `${lib}.sqlite`))).toBe(false);

    // Recorded as the console records them, marked as done by an agent.
    expect(track.mock.calls.map(([name, e]) => `${name}:${e.userId === ids.owner ? "owner" : "cr"}:${e.props.via}`)).toEqual(["shared_kb_create:owner:agent", "shared_kb_invite:owner:agent", "shared_kb_join:cr:agent"]);
  } finally { await done(); }
});

it("gives an agent no more than the person has: members only, the administrator's acts to the administrator, the console's limits", async () => {
  const { h, ids, kbs, track, as, json, done } = await setup();
  const owner = as("owner"), cr = as("cr"), yz = as("yz");
  try {
    const lib = json<{ id: string }>(await owner("kb_library_create", { name: "张家", rules: "收：家里的事" })).id;
    const entry = json<{ node: string }>(await owner("kb_library_edit", { library: lib, action: "create_entry", title: "Roy 的作息", domain: "family", claims: ["每晚 8 点睡"] })).node;
    const theirs = json<{ id: string }>(await yz("kb_library_create", { name: "王家" })).id;
    const theirEntry = json<{ node: string }>(await yz("kb_library_edit", { library: theirs, action: "create_entry", title: "王家的事", claims: ["只给王家看"] })).node;

    // Limits are the console's: name length, secrets in the rules.
    expect((await owner("kb_library_create", { name: "" })).isError).toBe(true);
    expect((await owner("kb_library_create", { name: "名".repeat(41) })).isError).toBe(true);
    expect((await owner("kb_library_create", { name: "x", rules: "门禁密码是 123456" })).isError).toBe(true);
    expect((await owner("kb_library_create", { name: "x", rules: "长".repeat(4001) })).isError).toBe(true);

    // A library the account is not in does not exist for its agent, by id or by name, and nothing of it shows.
    for (const library of [lib, "张家"]) {
      for (const [name, args] of [
        ["kb_library_manage", { action: "invite" }], ["kb_library_manage", { action: "set_rules", rules: "x" }], ["kb_library_manage", { action: "dissolve" }],
        ["kb_library_edit", { action: "create_entry", title: "x", claims: ["y"] }], ["kb_library_edit", { action: "delete_entry", node: entry }],
        ["kb_library_history", {}], ["kb_library_undo", { change: 1 }],
      ] as const) {
        const r = await cr(name, { library, ...args });
        expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
        expect(r.content[0]!.text).toContain("belongs to no shared knowledge base");
        expect(r.content[0]!.text).not.toContain(lib === library ? "张家" : lib);
      }
    }
    expect(getKbNode(kbs.db(lib), lib, entry)!.claims.map((c) => c.text)).toEqual(["每晚 8 点睡"]);
    expect(h.ctx.db.prepare("SELECT count(*) AS n FROM kb_library_invites").get()).toEqual({ n: 0 });

    // Being in one library reaches only that library's entries: another library's ids are not found in it.
    const invite = json<{ url: string; invite: string }>(await owner("kb_library_manage", { library: lib, action: "invite" }));
    json(await owner("kb_library_manage", { library: lib, action: "invite" }));
    await cr("kb_library_join", { link: invite.url });
    expect((await owner("kb_library_edit", { library: lib, action: "delete_entry", node: theirEntry })).isError).toBe(true);
    expect((await owner("kb_library_edit", { library: lib, action: "add_claim", node: theirEntry, text: "写进别人的库" })).isError).toBe(true);
    expect((await owner("kb_library_manage", { library: theirs, action: "invite" })).isError).toBe(true);
    expect(getKbNode(kbs.db(theirs), theirs, theirEntry)!.claims.map((c) => c.text)).toEqual(["只给王家看"]);
    expect(json<Array<{ name: string }>>(await owner("kb_libraries")).map((l) => l.name)).toEqual(["张家"]);

    // A revoked or made-up link joins nobody.
    expect((await cr("kb_library_manage", { library: lib, action: "revoke_invite", invite: invite.invite })).isError).toBeFalsy();
    expect((await yz("kb_library_join", { link: invite.url })).isError).toBe(true);
    expect((await yz("kb_library_join", { link: "https://agent.example.com/knowledge?join=made-up" })).isError).toBe(true);
    expect(kbs.isMember(lib, ids.yz)).toBe(false);
    expect(json<Array<{ invites: unknown[] }>>(await owner("kb_libraries"))[0]!.invites).toHaveLength(1);

    // Removing, handing over and dissolving are the administrator's; a member of another library cannot be named.
    expect((await cr("kb_library_manage", { library: lib, action: "remove_member", member: "owner" })).content[0]!.text).toBe(t().knowledge.adminOnly);
    expect((await cr("kb_library_manage", { library: lib, action: "make_admin", member: "cr" })).isError).toBe(true);
    expect((await cr("kb_library_manage", { library: lib, action: "dissolve" })).isError).toBe(true);
    expect((await owner("kb_library_manage", { library: lib, action: "remove_member", member: "yz" })).content[0]!.text).toContain('"yz" is not a member of this library');
    expect((await owner("kb_library_manage", { library: lib, action: "remove_member", member: "owner" })).isError).toBe(true);
    expect(kbs.library(lib)).toMatchObject({ admin_id: ids.owner });
    expect((await owner("kb_library_manage", { library: lib, action: "remove_member", member: "cr" })).content[0]!.text).toBe("Removed from the library.");
    expect(kbs.isMember(lib, ids.cr)).toBe(false);
    expect((await cr("kb_library_history", { library: lib })).isError).toBe(true);

    // Two libraries of the same name need an id.
    json(await owner("kb_library_create", { name: "张家" }));
    expect((await owner("kb_library_history", { library: "张家" })).content[0]!.text).toContain("pass its id");
    expect((await owner("kb_library_history", { library: lib })).isError).toBeFalsy();

    expect((await owner("kb_library_manage", { library: lib, action: "dissolve" })).isError).toBeFalsy();
    expect(kbs.library(lib)).toBeNull();
    expect(track.mock.calls.filter(([name]) => name === "shared_kb_dissolve").map(([, e]) => e.userId)).toEqual([ids.owner]);
  } finally { await done(); }
});
