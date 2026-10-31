import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../src/control/db.js";
import { Logger } from "../../src/common/logger.js";
import { SharedKbs, SharedKbError } from "../../src/control/taskKb/shared.js";
import { getKbNode, listKb, searchKb } from "../../src/control/taskKb/read.js";
import { listChanges, nodeChanges, restoreNode, undoChange } from "../../src/control/taskKb/ledger.js";
import { applyKbAnswer } from "../../src/control/taskKb/kernel.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-kb-"));
  dirs.push(dir);
  const db = openDb(path.join(dir, "root.sqlite"));
  for (const [id, name] of [["owner_1", "owner"], ["user_cr", "cr"], ["user_x", "xjy"]]) {
    db.prepare("INSERT OR IGNORE INTO owners (id, username, role, password_hash, password_salt, password_params, created_at) VALUES (?,?,?,'x','x','{}',?)").run(id, name, id === "owner_1" ? "owner" : "member", Date.now());
  }
  const kbs = new SharedKbs({ db, dataDir: dir, log: new Logger("error", undefined, false) });
  return { db, kbs, dir };
}

const code = (fn: () => unknown) => { try { fn(); return null; } catch (err) { return err instanceof SharedKbError ? err.code : String(err); } };

describe("shared libraries: membership", () => {
  it("joins by an invitation link, keeps strangers out, and lets the last one dissolve it", () => {
    const { kbs, dir } = setup();
    const id = kbs.create("owner_1", "张家", "收：家里的事");
    expect(kbs.librariesOf("owner_1")).toEqual([{ id, name: "张家", admin: true }]);
    // A stranger cannot tell the library exists.
    expect(code(() => kbs.member(id, "user_cr"))).toBe("not_found");
    expect(code(() => kbs.createEntry(id, "user_cr", { title: "x", claims: ["y"] }))).toBe("not_found");

    const invite = kbs.createInvite(id, "owner_1");
    expect(kbs.previewInvite(invite.token, "user_cr")).toMatchObject({ library: id, name: "张家", inviter: "owner", member: false, members: 1 });
    expect(kbs.join(invite.token, "user_cr")).toBe(id);
    expect(kbs.join(invite.token, "user_x")).toBe(id);
    expect(kbs.members(id).map((m) => m.username)).toEqual(["owner", "cr", "xjy"]);
    expect(kbs.invites(id, "user_cr")[0]).toMatchObject({ createdBy: "owner", uses: 2 });

    // Anyone may revoke a link; a revoked link leads nowhere.
    kbs.revokeInvite(id, "user_cr", invite.id);
    expect(code(() => kbs.previewInvite(invite.token, "user_cr"))).toBe("invite_invalid");
    expect(code(() => kbs.join("nonsense", "user_cr"))).toBe("invite_invalid");

    // Only the administrator removes, hands over or dissolves; the administrator leaves last.
    expect(code(() => kbs.removeMember(id, "user_cr", "user_x"))).toBe("admin_only");
    kbs.removeMember(id, "owner_1", "user_x");
    expect(kbs.isMember(id, "user_x")).toBe(false);
    expect(code(() => kbs.leave(id, "owner_1"))).toBe("transfer_first");
    kbs.transfer(id, "owner_1", "user_cr");
    expect(kbs.leave(id, "owner_1")).toEqual({ dissolved: false });
    expect(kbs.librariesOf("owner_1")).toEqual([]);
    expect(fs.existsSync(path.join(dir, "kbs", `${id}.sqlite`))).toBe(true);
    expect(kbs.leave(id, "user_cr")).toEqual({ dissolved: true });
    expect(kbs.library(id)).toBeNull();
    expect(fs.existsSync(path.join(dir, "kbs", `${id}.sqlite`))).toBe(false);
  });

  it("keeps rule versions and restores an old one as a new version", () => {
    const { kbs } = setup();
    const id = kbs.create("owner_1", "项目", "v1");
    kbs.setRules(id, "owner_1", "v2");
    kbs.restoreRules(id, "owner_1", 1);
    expect(kbs.rules(id)).toMatchObject({ version: 3, text: "v1" });
    expect(kbs.ruleHistory(id, "owner_1").map((r) => [r.version, r.text, r.restoredFrom])).toEqual([[3, "v1", 1], [2, "v2", null], [1, "v1", null]]);
    expect(code(() => kbs.setRules(id, "owner_1", "wifi 密码是 hunter22"))).toBe("sensitive");
  });
});

describe("shared libraries: editing and rolling back", () => {
  it("records every edit, undoes one change, and restores an entry to an earlier version", () => {
    const { kbs } = setup();
    const id = kbs.create("owner_1", "张家", "");
    const invite = kbs.createInvite(id, "owner_1");
    kbs.join(invite.token, "user_cr");
    const db = kbs.db(id);

    const node = kbs.createEntry(id, "owner_1", { title: "Roy 的饮食", domain: "family", kind: "entity", summary: "一岁半", claims: ["不吃鸡蛋", "喜欢香蕉"] });
    const v1 = listChanges(db)[0]!.id;
    expect(searchKb(db, id, { query: "香蕉" }).map((h) => h.id)).toEqual([node]);
    const claim = getKbNode(db, id, node)!.claims.find((c) => c.text === "不吃鸡蛋")!;
    expect(claim.sources[0]).toMatchObject({ excerpt: "不吃鸡蛋" });

    kbs.updateClaim(id, "user_cr", claim.id, "鸡蛋过敏已好，可以吃鸡蛋");
    kbs.updateNode(id, "user_cr", node, { title: "Roy 的饮食习惯" });
    kbs.addClaim(id, "user_cr", node, "每天一杯奶");
    expect(getKbNode(db, id, node)!.claims.map((c) => c.text).sort()).toEqual(["喜欢香蕉", "每天一杯奶", "鸡蛋过敏已好，可以吃鸡蛋"]);
    expect(nodeChanges(db, node).length).toBe(4);

    // Undo the last change only: the added claim goes, the rest stays.
    const last = listChanges(db)[0]!;
    expect(last).toMatchObject({ by: "user_cr", kind: "edit" });
    expect(undoChange(db, last.id, "owner_1")).toMatchObject({ ok: true });
    expect(getKbNode(db, id, node)!.claims.map((c) => c.text).sort()).toEqual(["喜欢香蕉", "鸡蛋过敏已好，可以吃鸡蛋"]);
    expect(listChanges(db)[1]).toMatchObject({ id: last.id, undone: true });

    // An earlier change whose rows were changed again since cannot be undone on its own.
    const rename = listChanges(db).find((c) => c.summary === "Roy 的饮食习惯" && c.kind === "edit")!;
    const claimEdit = listChanges(db).find((c) => c.id < rename.id && c.kind === "edit" && c.id !== v1)!;
    kbs.updateClaim(id, "owner_1", claim.id, "可以吃鸡蛋");
    expect(undoChange(db, claimEdit.id, "owner_1")).toMatchObject({ ok: false });

    // The whole entry back to how it was first written.
    expect(restoreNode(db, node, v1, "owner_1")).toMatchObject({ ok: true });
    const back = getKbNode(db, id, node)!;
    expect(back.title).toBe("Roy 的饮食");
    expect(back.claims.map((c) => c.text).sort()).toEqual(["不吃鸡蛋", "喜欢香蕉"]);
    expect(back.claims.find((c) => c.text === "不吃鸡蛋")!.sources.map((s) => s.excerpt)).toEqual(["不吃鸡蛋"]);
    expect(searchKb(db, id, { query: "香蕉" }).map((h) => h.id)).toEqual([node]);

    // Deleting is a change too, and comes back with its claims.
    kbs.deleteNode(id, "user_cr", node);
    expect(listKb(db, id).nodes).toEqual([]);
    expect(undoChange(db, listChanges(db)[0]!.id, "user_cr")).toMatchObject({ ok: true });
    expect(getKbNode(db, id, node)!.claims.length).toBe(2);
    expect(searchKb(db, id, { query: "鸡蛋" }).map((h) => h.id)).toEqual([node]);

    // A restore can itself be undone.
    const restore = listChanges(db).find((c) => c.kind === "restore")!;
    expect(restore.summary).toBe("Roy 的饮食习惯");
  });

  it("records a maintainer answer as one change that can be undone whole", async () => {
    const { kbs } = setup();
    const id = kbs.create("owner_1", "张家", "");
    const db = kbs.db(id);
    const pid = kbs.enqueue(id, { from: "owner_1", type: "add", task: "task_1", target: null, text: "Costco 退货 90 天", evidence: [{ task: "task_1", path: null, url: null, sha256: null, excerpt: "电子产品 90 天内可退" }] });
    const r = await applyKbAnswer({
      db, ownerId: id, workspaceDir: "/w", readFile: async () => null, packets: [pid], noWiki: true,
      change: { by: "owner_1", kind: "maintainer", summary: "1 item" },
      verify: async (_where, input) => ({ task: "task_1", path: null, url: null, sha256: null, excerpt: String((input as { quote: string }).quote), kind: "task", contributor: "owner_1" }),
    }, { decisions: [{ packet: pid, status: "accepted" }], ops: [
      { op: "node", ref: "n1", kind: "procedure", domain: "shopping", title: "Costco 退货", summary: "" },
      { op: "claim", node: "n1", text: "电子产品 90 天内可退", certainty: "observed", sources: [{ packet: pid, quote: "90 天内可退" }] },
    ] });
    expect(r.ok).toBe(true);
    const change = listChanges(db)[0]!;
    expect(change).toMatchObject({ kind: "maintainer", by: "owner_1" });
    const node = r.nodes[0]!;
    expect(getKbNode(db, id, node)!.claims[0]!.sources[0]).toMatchObject({ excerpt: "90 天内可退" });
    expect(undoChange(db, change.id, "user_cr")).toMatchObject({ ok: true });
    expect(listKb(db, id).nodes).toEqual([]);
  });
});
