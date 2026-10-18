import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClawpageData, DATA_LIMITS, DataError, OWNER_LINK_MS, RATE_LIMITS } from "../../src/control/clawpages.js";

const owner = { owner: true };
const visitor = { owner: false };
let dir: string;
let data: ClawpageData;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-clawpages-")); data = new ClawpageData(dir); });
afterEach(() => { data.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { if (err instanceof DataError) return `${err.status} ${err.code}`; throw err; }
  return "ok";
};

describe("clawpage tables", () => {
  it("holds each table to its permission: visitors never see a private table, read a read-public one, write a public one", () => {
    data.createTable("u1", "poll", "notes", "private");
    data.createTable("u1", "poll", "results", "read-public");
    data.createTable("u1", "poll", "votes", "public");
    for (const t of ["notes", "results", "votes"]) data.put("u1", "poll", t, "a", { n: 1 }, owner);

    expect(code(() => data.get("u1", "poll", "notes", "a", visitor))).toBe("404 TABLE_NOT_FOUND");
    expect(code(() => data.list("u1", "poll", "notes", visitor))).toBe("404 TABLE_NOT_FOUND");
    expect(data.get("u1", "poll", "results", "a", visitor).value).toEqual({ n: 1 });
    expect(code(() => data.put("u1", "poll", "results", "b", 1, visitor))).toBe("403 PERMISSION_DENIED");
    expect(data.post("u1", "poll", "votes", { choice: "rice" }, visitor).key).toMatch(/^rec_[A-Za-z0-9][A-Za-z0-9_-]{6}[A-Za-z0-9]$/);
    // A visitor cannot create tables by writing to them; the owner's first write creates one, private.
    expect(code(() => data.put("u1", "poll", "new-table", "k", 1, visitor))).toBe("404 TABLE_NOT_FOUND");
    data.put("u1", "poll", "drafts", "k", 1, owner);
    expect(data.tables("u1", "poll").find((t) => t.name === "drafts")?.permission).toBe("private");
  });

  it("keeps pages and accounts apart", () => {
    data.put("u1", "a", "t1", "k", "a", owner);
    data.put("u1", "b", "t1", "k", "b", owner);
    data.put("u2", "a", "t1", "k", "c", owner);
    expect([data.get("u1", "a", "t1", "k", owner).value, data.get("u1", "b", "t1", "k", owner).value, data.get("u2", "a", "t1", "k", owner).value]).toEqual(["a", "b", "c"]);
    data.dropPage("u1", "a");
    expect(data.tables("u1", "a")).toEqual([]);
    expect(data.get("u1", "b", "t1", "k", owner).value).toBe("b");
    expect([...data.overview("u1").keys()]).toEqual(["b"]);
  });

  it("merges, increments, lists in insertion order with a cursor, and keeps counts and sizes", () => {
    data.put("u1", "p", "items", "x", { a: { b: 1, c: [1, 2] }, keep: true }, owner);
    expect(data.patch("u1", "p", "items", "x", { a: { b: 2, c: [3] } }, owner).value).toEqual({ a: { b: 2, c: [3] }, keep: true });
    expect(code(() => data.patch("u1", "p", "items", "x", [1], owner))).toBe("400 PATCH_NOT_OBJECT");
    expect(code(() => data.patch("u1", "p", "items", "missing", {}, owner))).toBe("404 RECORD_NOT_FOUND");
    expect(data.incr("u1", "p", "items", "counter", "n", undefined, owner).value).toEqual({ n: 1 });
    expect(data.incr("u1", "p", "items", "counter", "n", -0.5, owner).value).toEqual({ n: 0.5 });
    expect(code(() => data.incr("u1", "p", "items", "x", "a", 1, owner))).toBe("400 INCR_FIELD_NOT_NUMBER");
    for (let i = 0; i < 5; i++) data.put("u1", "p", "items", `k${i}`, i, owner);
    // Rewriting a record keeps its place.
    data.put("u1", "p", "items", "x", { again: true }, owner);
    const first = data.list("u1", "p", "items", owner, { limit: 3 });
    expect(first.records.map((r) => r.key)).toEqual(["x", "counter", "k0"]);
    const rest = data.list("u1", "p", "items", owner, { limit: 10, after: first.nextCursor });
    expect(rest.records.map((r) => r.key)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(rest.nextCursor).toBeNull();
    expect(data.remove("u1", "p", "items", "k4", owner)).toBe(true);
    expect(data.remove("u1", "p", "items", "k4", owner)).toBe(false);
    const [t] = data.tables("u1", "p");
    expect(t!.records).toBe(6);
    const stored = (data.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM cp_records").get() as { n: number }).n;
    expect(t!.bytes).toBe(stored);
  });

  it("refuses bad names, keys and values, and holds the limits", () => {
    expect(code(() => data.createTable("u1", "p", "Bad", "private"))).toBe("400 INVALID_TABLE");
    expect(code(() => data.createTable("u1", "p", "ok", "everyone"))).toBe("400 INVALID_PERMISSION");
    expect(code(() => data.put("u1", "p", "ok", "../x", 1, owner))).toBe("400 INVALID_KEY");
    expect(code(() => data.put("u1", "p", "ok", "k", "x".repeat(DATA_LIMITS.valueBytes), owner))).toBe("413 VALUE_TOO_LARGE");
    let deep: unknown = 1;
    for (let i = 0; i < DATA_LIMITS.depth + 1; i++) deep = { d: deep };
    expect(code(() => data.put("u1", "p", "ok", "k", deep, owner))).toBe("400 VALUE_TOO_DEEP");
    for (let i = 0; i < DATA_LIMITS.tablesPerPage; i++) data.createTable("u1", "full", `t${i}x`, "private");
    expect(code(() => data.createTable("u1", "full", "one-more", "private"))).toBe("409 TOO_MANY_TABLES");
    expect(code(() => data.createTable("u1", "full", "t0x", "private"))).toBe("409 TABLE_EXISTS");
  });

  it("imports all or nothing and exports in insertion order", () => {
    data.importTable("u1", "p", "items", { b: 2, a: 1 });
    expect(code(() => data.importTable("u1", "p", "items", { c: 3, "bad key": 4 }))).toBe("400 INVALID_KEY");
    expect(data.exportTable("u1", "p", "items")).toEqual({ table: "items", permission: "private", records: { b: 2, a: 1 } });
  });
});

describe("owner links and visitor limits", () => {
  it("an owner token opens exactly one account's page, until it expires", () => {
    const token = data.ownerToken("u1", "poll", 1000);
    expect(data.isOwnerToken(token, "u1", "poll", 1000 + OWNER_LINK_MS - 1)).toBe(true);
    expect(data.isOwnerToken(token, "u1", "poll", 1000 + OWNER_LINK_MS)).toBe(false);
    expect(data.isOwnerToken(token, "u1", "other", 2000)).toBe(false);
    expect(data.isOwnerToken(token, "u2", "poll", 2000)).toBe(false);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "u1", p: "poll", e: 9e15 })).toString("base64url");
    expect(data.isOwnerToken(`${forged}.${sig}`, "u1", "poll", 2000)).toBe(false);
    expect(data.isOwnerToken(`${body}.x${sig!.slice(1)}`, "u1", "poll", 2000)).toBe(false);
    // Another deployment's key signs nothing here.
    const other = new ClawpageData(fs.mkdtempSync(path.join(os.tmpdir(), "pa-clawpages-other-")));
    expect(data.isOwnerToken(other.ownerToken("u1", "poll", 1000), "u1", "poll", 2000)).toBe(false);
    other.close();
  });

  it("counts anonymous traffic per address and page, per minute", () => {
    const at = 60_000 * 1000;
    for (let i = 0; i < RATE_LIMITS.writes; i++) expect(data.allow("1.1.1.1", "u1", "p", "writes", at)).toBe(true);
    expect(data.allow("1.1.1.1", "u1", "p", "writes", at)).toBe(false);
    expect(data.allow("1.1.1.1", "u1", "q", "writes", at)).toBe(true);
    expect(data.allow("2.2.2.2", "u1", "p", "writes", at)).toBe(true);
    expect(data.allow("1.1.1.1", "u1", "p", "reads", at)).toBe(true);
    expect(data.allow("1.1.1.1", "u1", "p", "writes", at + 60_000)).toBe(true);
  });
});
