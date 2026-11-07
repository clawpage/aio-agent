import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ClawpageData } from "../../src/control/clawpages.js";
import { openDb } from "../../src/control/db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it("gives every account a public id, existing ones on the next open and new ones as they are made", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "public-id-")), "db.sqlite");
  const before = openDb(file);
  before.prepare("INSERT INTO owners (id,username,password_hash,password_salt,password_params,created_at) VALUES ('user_a','a','h','s','{}',0)").run();
  // A database from before public ids.
  before.exec("DROP TRIGGER owners_public_id; DROP INDEX idx_owners_public_id; ALTER TABLE owners DROP COLUMN public_id;");
  before.close();
  const db = openDb(file);
  db.prepare("INSERT INTO owners (id,username,password_hash,password_salt,password_params,created_at) VALUES ('user_b','b','h','s','{}',0)").run();
  const ids = (db.prepare("SELECT public_id FROM owners ORDER BY id").all() as Array<{ public_id: string }>).map((r) => r.public_id);
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(UUID);
  expect(new Set(ids).size).toBe(2);
  // Stable: opening again changes nothing.
  db.close();
  expect((openDb(file).prepare("SELECT public_id FROM owners ORDER BY id").all() as Array<{ public_id: string }>).map((r) => r.public_id)).toEqual(ids);
});

it("moves grants, authors and per-user keys made before public ids onto them, keeping each person's records theirs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-visitors-"));
  // The tables as they were: visitors named by account id, with their email.
  const old = new DatabaseSync(path.join(dir, "clawpages.sqlite"));
  old.exec(`CREATE TABLE cp_tables (user_id TEXT NOT NULL, page TEXT NOT NULL, name TEXT NOT NULL, permission TEXT NOT NULL, records INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, page, name));
    CREATE TABLE cp_records (user_id TEXT NOT NULL, page TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, bytes INTEGER NOT NULL, seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, author TEXT, PRIMARY KEY (user_id, page, tbl, key));
    CREATE TABLE cp_grants (user_id TEXT NOT NULL, page TEXT NOT NULL, visitor_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
      granted_at INTEGER NOT NULL, last_seen_at INTEGER, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, page, visitor_id));`);
  const record = old.prepare("INSERT INTO cp_records VALUES ('owner_1','quiz',?,?,?,?,1,0,0,?)");
  old.prepare("INSERT INTO cp_tables VALUES ('owner_1','quiz','progress','per-user',2,0,2,0,0)").run();
  old.prepare("INSERT INTO cp_tables VALUES ('owner_1','quiz','board','signed-in',2,0,2,0,0)").run();
  old.prepare("INSERT INTO cp_grants VALUES ('owner_1','quiz','user_rui','rui','rui@example.com',0,0,1)").run();
  old.prepare("INSERT INTO cp_grants VALUES ('owner_1','quiz','user_gone','gone','gone@example.com',0,0,0)").run();
  for (const [tbl, key, value, author] of [
    ["progress", "user_rui.state", '{"day":3}', "user_rui"],
    ["progress", "user_gone.state", '{"day":1}', "user_gone"],
    // A page that kept `cp.user.id` itself, as a key and in a value.
    ["board", "user_rui", '{"by":"user_rui","text":"hi"}', "user_rui"],
    ["board", "note", '{"text":"user_rui is not an id here"}', null],
  ] as const) record.run(tbl, key, value, Buffer.byteLength(value), author);
  old.close();

  const rui = { id: "8b1f8f5e-2b8a-4a51-9c11-0f6b8f3e4a10", name: "小睿" };
  const data = new ClawpageData(dir, (id) => (id === "user_rui" ? rui : null));
  const visitors = data.visitors("owner_1", "quiz");
  expect(visitors.find((v) => v.id === rui.id)).toMatchObject({ name: "小睿" });
  // An account deleted since gets an id of its own and a name made from it.
  const gone = visitors.find((v) => v.id !== rui.id)!;
  expect(gone.id).toMatch(UUID);
  expect(gone.name).toMatch(/^Clawpage user [0-9A-F]{4}$/);
  const all = JSON.stringify(data.db.prepare("SELECT * FROM cp_grants").all()) + JSON.stringify(data.db.prepare("SELECT key,value,author FROM cp_records").all());
  expect(all).not.toContain("@example.com");
  expect(data.db.prepare("SELECT account_id FROM cp_grants WHERE visitor_id=?").get(rui.id)).toEqual({ account_id: "user_rui" });
  expect(data.accountOf("owner_1", "quiz", rui.id)).toBe("user_rui");
  // The deleted account's grant was revoked: it answers nothing.
  expect(data.accountOf("owner_1", "quiz", gone.id)).toBeNull();

  // Each person still reads their own per-user record, now under their public id.
  expect(data.get("owner_1", "quiz", "progress", "state", { owner: false, visitor: rui }).value).toEqual({ day: 3 });
  const owned = data.list("owner_1", "quiz", "progress", { owner: true }).records.map((r) => [r.key, r.by]);
  expect(owned).toEqual(expect.arrayContaining([[`${rui.id}.state`, rui], [`${gone.id}.state`, { id: gone.id, name: gone.name }]]));
  // Keys and string values that were the account id follow it; other text does not.
  const board = data.list("owner_1", "quiz", "board", { owner: true }).records;
  expect(board.find((r) => r.key === rui.id)).toMatchObject({ value: { by: rui.id, text: "hi" }, by: rui });
  expect(board.find((r) => r.key === "note")!.value).toEqual({ text: "user_rui is not an id here" });
  // The signed-in visitor still owns what they wrote.
  expect(data.list("owner_1", "quiz", "board", { owner: false, visitor: rui }).records.find((r) => r.key === rui.id)).toMatchObject({ mine: true });
  // Sizes follow the rewritten values.
  const bytes = data.db.prepare("SELECT bytes, length(CAST(value AS BLOB)) AS actual FROM cp_records").all() as Array<{ bytes: number; actual: number }>;
  for (const b of bytes) expect(b.bytes).toBe(b.actual);
  data.close();

  // Once only: opening again leaves everything as it is.
  const again = new ClawpageData(dir, () => { throw new Error("not asked again"); });
  expect(again.visitors("owner_1", "quiz").map((v) => v.id).sort()).toEqual([rui.id, gone.id].sort());
  again.close();
});

it("leaves the data as it was when the move fails part way, and moves it on the next start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-visitors-fail-"));
  const old = new DatabaseSync(path.join(dir, "clawpages.sqlite"));
  old.exec(`CREATE TABLE cp_records (user_id TEXT NOT NULL, page TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, bytes INTEGER NOT NULL, seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, author TEXT, PRIMARY KEY (user_id, page, tbl, key));
    CREATE TABLE cp_grants (user_id TEXT NOT NULL, page TEXT NOT NULL, visitor_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
      granted_at INTEGER NOT NULL, last_seen_at INTEGER, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, page, visitor_id));
    INSERT INTO cp_grants VALUES ('owner_1','a','user_one','one','one@example.com',0,0,1), ('owner_1','b','user_two','two',NULL,0,0,1);
    INSERT INTO cp_records VALUES ('owner_1','a','t','user_one.k','{}',2,1,0,0,'user_one');`);
  old.close();
  const snapshot = () => {
    const db = new DatabaseSync(path.join(dir, "clawpages.sqlite"));
    try { return JSON.stringify([db.prepare("PRAGMA table_info(cp_grants)").all(), db.prepare("SELECT * FROM cp_grants ORDER BY page").all(), db.prepare("SELECT * FROM cp_records").all()]); } finally { db.close(); }
  };
  const before = snapshot();
  // The second account cannot be looked up: nothing of the first account's move stays either.
  expect(() => new ClawpageData(dir, (id) => { if (id === "user_two") throw new Error("lookup failed"); return { id: "11111111-1111-4111-8111-111111111111", name: "One" }; })).toThrow("lookup failed");
  expect(snapshot()).toBe(before);
  const data = new ClawpageData(dir, (id) => ({ id: id === "user_one" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", name: id }));
  expect(data.accountOf("owner_1", "a", "11111111-1111-4111-8111-111111111111")).toBe("user_one");
  expect(data.db.prepare("SELECT key, author FROM cp_records").get()).toEqual({ key: "11111111-1111-4111-8111-111111111111.k", author: "11111111-1111-4111-8111-111111111111" });
  data.close();
});
