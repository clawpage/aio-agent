import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../src/control/db.js";

it("keeps every device link when an older database learns Android links", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "device-link-kinds-"));
  const file = path.join(dir, "control.sqlite");
  try {
    let db = openDb(file);
    db.prepare("INSERT INTO owners (id,username,role,password_hash,password_salt,password_params,created_at) VALUES ('owner_1','owner','owner','x','x','{}',0)").run();
    // The table as it was before Android: its kind allowed only the Mac and the iPhone.
    db.exec(`DROP TABLE device_links;
      CREATE TABLE device_links (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_seen_at INTEGER, kind TEXT NOT NULL DEFAULT 'mac' CHECK (kind IN ('mac','ios')));
      INSERT INTO device_links (id,owner_id,token_hash,name,created_at,last_seen_at,kind) VALUES ('dl_mac','owner_1','h1','MacBook',1,2,'mac'), ('dl_ios','owner_1','h2','iPhone',3,null,'ios');`);
    expect(() => db.prepare("INSERT INTO device_links (id,owner_id,token_hash,name,created_at,kind) VALUES ('x','owner_1','h3','Pixel',4,'android')").run()).toThrow();
    db.close();
    db = openDb(file);
    db.prepare("INSERT INTO device_links (id,owner_id,token_hash,name,created_at,kind) VALUES ('dl_android','owner_1','h3','Pixel',4,'android')").run();
    expect(db.prepare("SELECT id,name,created_at,last_seen_at,kind FROM device_links ORDER BY created_at").all()).toEqual([
      { id: "dl_mac", name: "MacBook", created_at: 1, last_seen_at: 2, kind: "mac" },
      { id: "dl_ios", name: "iPhone", created_at: 3, last_seen_at: null, kind: "ios" },
      { id: "dl_android", name: "Pixel", created_at: 4, last_seen_at: null, kind: "android" },
    ]);
    expect(() => db.prepare("INSERT INTO device_links (id,owner_id,token_hash,name,created_at,kind) VALUES ('y','owner_1','h4','Watch',5,'watch')").run()).toThrow();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
