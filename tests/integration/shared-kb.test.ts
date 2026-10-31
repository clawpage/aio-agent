import { it, expect, vi } from "vitest";
import path from "node:path";
import { startHarness, login } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { workspaceConfig } from "../../src/control/auth/workspaceHost.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { TaskKbGateway } from "../../src/control/taskKb/gateway.js";
import { TaskKbMaintainer } from "../../src/control/taskKb/maintainer.js";
import { SharedKbs } from "../../src/control/taskKb/shared.js";
import { SharedKbMaintainer } from "../../src/control/taskKb/sharedMaintainer.js";
import { getKbNode, listKb, searchKb } from "../../src/control/taskKb/read.js";

type Result = { content: Array<{ text: string }>; isError?: boolean };

it("keeps a shared library to its members over HTTP: invite, join, edit, undo, leave", async () => {
  const root = await startHarness(), member = await startHarness();
  try {
    const user = await createMember(root.ctx.db, "cr", "member-secret-123");
    member.ctx.db.prepare("INSERT INTO owners(id,username,role,password_hash,password_salt,password_params,created_at) VALUES (?,?,'member','x','x','{}',0)").run(user.id, user.username);
    member.ctx.sessions = root.ctx.sessions; member.ctx.tickets = root.ctx.tickets;
    member.ctx.cfg = { ...member.ctx.cfg, ...workspaceConfig(root.ctx.cfg), sandbox: member.ctx.cfg.sandbox };
    root.ctx.sharedKb = member.ctx.sharedKb = new SharedKbs({ db: root.ctx.db, dataDir: root.dataDir, log: root.ctx.log });
    root.ctx.runtimeForUser = async (id) => { if (id === "owner_1") return root.ctx; if (id === user.id) return member.ctx; throw Error("unknown"); };
    const owner = await login(root);
    const m = root.ctx.sessions.create(user.id, "primary");
    const as = (who: "owner" | "member") => (pathname: string, method = "GET", body?: unknown) => root.request(`/api${pathname}`, {
      method, headers: who === "owner" ? { cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/json" } : { cookie: `pa_session=${m.token}; pa_csrf=${m.csrfToken}`, "x-csrf-token": m.csrfToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const o = as("owner"), c = as("member");

    const presets = (await (await o("/knowledge/libraries")).json()) as { presets: { family: string } };
    expect(presets.presets.family.length).toBeGreaterThan(20);
    const { id } = (await (await o("/knowledge/libraries", "POST", { name: "张家", rules: presets.presets.family })).json()) as { id: string };
    const entry = (await (await o(`/knowledge/libraries/${id}/nodes`, "POST", { title: "Roy 的饮食", domain: "family", claims: ["不吃鸡蛋"] })).json()) as { id: string };

    // Not a member yet: the library does not exist for them, to read or to write.
    expect((await c(`/knowledge/libraries/${id}`)).status).toBe(404);
    expect((await c(`/knowledge/libraries/${id}/nodes/${entry.id}`)).status).toBe(404);
    expect((await c(`/knowledge/libraries/${id}/nodes`, "POST", { title: "x", claims: ["y"] })).status).toBe(404);
    expect((await c(`/knowledge/libraries/${id}/invites`, "POST")).status).toBe(404);

    const invite = (await (await o(`/knowledge/libraries/${id}/invites`, "POST")).json()) as { token: string };
    expect(await (await c(`/knowledge/invites/${invite.token}`)).json()).toMatchObject({ name: "张家", inviter: "owner", member: false });
    expect(await (await c("/knowledge/join", "POST", { token: invite.token })).json()).toEqual({ library: id });
    expect(((await (await c("/knowledge/libraries")).json()) as { libraries: unknown[] }).libraries).toEqual([{ id, name: "张家", admin: false }]);

    // A member edits; the other member sees who wrote it and can undo it.
    const view = (await (await c(`/knowledge/libraries/${id}`)).json()) as { library: { members: Array<{ username: string }>; rules: { text: string; by: string } }; nodes: Array<{ id: string }> };
    expect(view.library.members.map((x) => x.username)).toEqual(["owner", "cr"]);
    expect(view.library.rules.by).toBe("owner");
    const node = (await (await c(`/knowledge/libraries/${id}/nodes/${entry.id}`)).json()) as { node: { claims: Array<{ id: string; sources: Array<{ from: string; mine: boolean }> }> } };
    expect(node.node.claims[0]!.sources[0]).toMatchObject({ from: "owner", mine: false });
    expect((await c(`/knowledge/libraries/${id}/claims/${node.node.claims[0]!.id}`, "PATCH", { text: "可以吃鸡蛋了" })).status).toBe(200);
    expect((await c(`/knowledge/libraries/${id}/claims/${node.node.claims[0]!.id}`, "PATCH", { text: "门禁密码是 123456" })).status).toBe(400);
    const changes = (await (await o(`/knowledge/libraries/${id}/changes`)).json()) as { changes: Array<{ id: number; by: string }> };
    expect(changes.changes[0]!.by).toBe("cr");
    expect((await o(`/knowledge/libraries/${id}/changes/${changes.changes[0]!.id}/undo`, "POST")).status).toBe(200);
    const back = (await (await o(`/knowledge/libraries/${id}/nodes/${entry.id}`)).json()) as { node: { claims: Array<{ text: string }> } };
    expect(back.node.claims.map((x) => x.text)).toEqual(["不吃鸡蛋"]);

    // Rules belong to everyone; dissolving belongs to the administrator.
    expect((await c(`/knowledge/libraries/${id}/rules`, "PUT", { text: "只收 Roy 的事" })).status).toBe(200);
    expect((await c(`/knowledge/libraries/${id}`, "DELETE")).status).toBe(403);

    // Leaving takes the access away at once; what they wrote stays.
    expect((await c(`/knowledge/libraries/${id}/leave`, "POST")).status).toBe(200);
    expect((await c(`/knowledge/libraries/${id}`)).status).toBe(404);
    expect((await o(`/knowledge/libraries/${id}/rules`)).status).toBe(200);
    expect(((await (await o(`/knowledge/libraries/${id}/rules`)).json()) as { versions: Array<{ by: string }> }).versions[0]!.by).toBe("cr");
    expect((await o(`/knowledge/libraries/${id}`, "DELETE")).status).toBe(200);
    expect((await o(`/knowledge/libraries/${id}`)).status).toBe(404);
  } finally { await member.shutdown(); await root.shutdown(); }
});

it("reads shared libraries beside the personal one, and sends what fits to the library through both judgements", async () => {
  const h = await startHarness();
  try {
    Object.assign(h.codex, { planTask: async () => JSON.stringify({ title: "test", related: [], dependencies: [], resources: [] }) });
    await createMember(h.ctx.db, "cr", "member-secret-123");
    const cr = (h.ctx.db.prepare("SELECT id FROM owners WHERE username='cr'").get() as { id: string }).id;
    const kbs = new SharedKbs({ db: h.ctx.db, dataDir: h.dataDir, log: h.ctx.log });
    h.ctx.sharedKb = kbs;
    const lib = kbs.create(cr, "张家", "收：家里的事和孩子的事。不收：工作。");
    const other = kbs.create(cr, "别人家", "");
    kbs.join(kbs.createInvite(lib, cr).token, "owner_1");
    const existing = kbs.createEntry(lib, cr, { title: "Roy 的作息", domain: "family", claims: ["每晚 8 点睡"] });
    kbs.createEntry(other, cr, { title: "别人的作息", domain: "family", claims: ["每晚 8 点睡"] });

    const container = { async execInSandbox() { return { code: 0, stdout: "", stderr: "" }; }, async writeFileInSandbox() {} };
    const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    const runtime = { db: h.ctx.db, tasks: h.ctx.tasks, cfg: owner, container, taskKb: { nudge: vi.fn() }, sharedKb: kbs };
    const taskKb = new TaskKbGateway({ port: 0, log: h.ctx.log, runtimeFor: async () => runtime });
    const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, taskKb);
    await gateway.start();
    taskKb.provision(owner);
    const call = async (name: string, args: unknown) => (await (await fetch(owner.taskKb!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })).json()).result as Result;
    try {
      // Reads cover the libraries the account belongs to, and only those.
      const hits = JSON.parse((await call("kb_search", { query: "作息" })).content[0]!.text) as Array<{ library: string; title: string }>;
      expect(hits.map((x) => `${x.library}:${x.title}`)).toEqual(["张家:Roy 的作息"]);
      const node = JSON.parse((await call("kb_get", { id: existing })).content[0]!.text) as { library: string; claims: Array<{ id: string; sources: Array<{ id: string; from: string }> }> };
      expect(node.library).toBe("张家");
      expect(node.claims[0]!.sources[0]!.from).toBe("cr");
      expect(JSON.parse((await call("kb_source", { id: node.claims[0]!.sources[0]!.id })).content[0]!.text)).toMatchObject({ library: "张家", from: "cr", state: "shared", quote: "每晚 8 点睡" });
      expect(JSON.parse((await call("kb_libraries", {})).content[0]!.text)).toEqual([{ name: "张家", members: ["cr", "owner"], rules: "收：家里的事和孩子的事。不收：工作。" }]);

      // A finished task the personal maintainer reads: one thing for the person, one passed on to the library.
      const text = "记一下 Roy 午睡时间";
      h.ctx.tasks.submit({ userId: "owner_1", text, clientMessageId: "kb-share" });
      await vi.waitFor(() => expect(h.codex.startedTurns.some((t) => t.text.includes(text))).toBe(true));
      const turn = h.codex.startedTurns.find((t) => t.text.includes(text))!;
      h.codex.emitNotification("item/completed", { threadId: turn.threadId, turnId: turn.turnId, item: { id: "c1", type: "commandExecution", command: "true", aggregatedOutput: "" } });
      await h.codex.runTurn(turn.turnId, { text: "好的，Roy 每天中午 12 点到 2 点午睡。" });
      const task = (h.ctx.db.prepare("SELECT id FROM tasks WHERE input_text=?").get(text) as { id: string }).id;
      await vi.waitFor(() => expect(h.ctx.tasks.get(task)!.status).toBe("completed"));

      // Corrections and named additions go straight to the library's mailbox.
      const flagged = await call("kb_propose", { type: "correct", task, target: node.claims[0]!.id, text: "现在 8 点半睡", evidence: [{ quote: "Roy 每天中午 12 点到 2 点午睡" }] });
      expect(flagged.isError).toBeFalsy();
      expect(getKbNode(kbs.db(lib), lib, existing)!.pendingCorrections).toHaveLength(1);
      expect((await call("kb_propose", { type: "add", task, library: "王家", text: "x", evidence: [{ quote: "Roy 每天中午 12 点到 2 点午睡" }] })).isError).toBe(true);
      expect((await call("kb_propose", { type: "add", task, library: "别人家", text: "x", evidence: [{ quote: "Roy 每天中午 12 点到 2 点午睡" }] })).isError).toBe(true);
      kbs.db(lib).prepare("DELETE FROM kb_packets").run();

      let prompt = "";
      const codex = { maintainKb: vi.fn(async (p: string) => {
        prompt = p;
        const packet = (h.ctx.db.prepare("SELECT id FROM kb_packets WHERE task_id=? AND status='pending'").get(task) as { id: string }).id;
        return { text: JSON.stringify({ decisions: [{ packet, status: "accepted" }], ops: [
          { op: "node", ref: "n", kind: "fact", domain: "family", title: "Roy 午睡", summary: "" },
          { op: "claim", node: "n", text: "中午 12 点到 2 点午睡", certainty: "user_said", sources: [{ task, quote: "Roy 每天中午 12 点到 2 点午睡" }] },
          { op: "share", library: lib, title: "Roy 午睡", text: "Roy 每天中午 12 点到 2 点午睡", sources: [{ task, quote: "Roy 每天中午 12 点到 2 点午睡" }] },
        ] }), error: null };
      }) };
      const m = new TaskKbMaintainer({ db: h.ctx.db, cfg: owner, log: h.ctx.log, codex, container, busy: async () => false, idleState: () => "running", shared: () => kbs });
      m.taskCompleted(task);
      expect(await m.run()).toBe(1);
      expect(prompt).toContain(`${lib} "张家"`);
      expect(prompt).toContain("收：家里的事和孩子的事");
      expect(prompt).not.toContain("别人家");
      expect(searchKb(h.ctx.db, "owner_1", { query: "午睡" }).map((x) => x.title)).toEqual(["Roy 午睡"]);
      const shared = kbs.db(lib).prepare("SELECT id, payload_json FROM kb_packets WHERE status='pending'").all() as Array<{ id: string; payload_json: string }>;
      expect(shared).toHaveLength(1);
      expect(JSON.parse(shared[0]!.payload_json)).toMatchObject({ from: "owner_1", title: "Roy 午睡", evidence: [{ excerpt: "Roy 每天中午 12 点到 2 点午睡", contributor: "owner_1" }] });

      // The library's maintainer: its rules in the prompt, a quote it cannot find refused, then written as one change.
      const asks: Array<{ user: string; prompt: string }> = [];
      const answers = [
        { decisions: [{ packet: shared[0]!.id, status: "accepted" }], ops: [{ op: "claim", node: existing, text: "中午 12 点到 2 点午睡", certainty: "user_said", sources: [{ packet: shared[0]!.id, quote: "编出来的话" }] }] },
        { decisions: [{ packet: shared[0]!.id, status: "accepted" }], ops: [{ op: "claim", node: existing, text: "中午 12 点到 2 点午睡", certainty: "user_said", sources: [{ packet: shared[0]!.id, quote: "12 点到 2 点午睡" }] }] },
      ];
      const sm = new SharedKbMaintainer({ kbs, log: h.ctx.log, ask: async (user, _system, p) => { asks.push({ user, prompt: p }); return JSON.stringify(answers.shift()); } });
      expect(await sm.run(lib)).toBe(1);
      sm.stop();
      expect(asks.map((a) => a.user)).toEqual(["owner_1", "owner_1"]);
      expect(asks[0]!.prompt).toContain("收：家里的事和孩子的事");
      expect(asks[1]!.prompt).toContain("does not appear in the quotes");
      const after = getKbNode(kbs.db(lib), lib, existing)!;
      expect(after.claims.map((x) => x.text).sort()).toEqual(["中午 12 点到 2 点午睡", "每晚 8 点睡"]);
      expect(after.claims.find((x) => x.text.startsWith("中午"))!.sources[0]).toMatchObject({ contributor: "owner_1", excerpt: "12 点到 2 点午睡", task });
      expect(listKb(kbs.db(lib), lib).pending).toBe(0);
      expect(listKb(kbs.db(other), other).nodes.map((x) => x.title)).toEqual(["别人的作息"]);
    } finally { gateway.close(); }
  } finally { await h.shutdown(); }
});
