import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Logger } from "../../src/common/logger";

it("names the account on every line, also from children made after it was set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-"));
  const file = path.join(dir, "out.log");
  const log = new Logger("info", file, false);
  log.info("before");
  log.setAccount("cr");
  log.child("browser").error("browser restore failed", { reason: "mcp_unready" });
  await new Promise((r) => setTimeout(r, 50));
  const [before, after] = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(before.account).toBeUndefined();
  expect(after).toMatchObject({ account: "cr", scope: "browser", msg: "browser restore failed", fields: { reason: "mcp_unready" } });
  fs.rmSync(dir, { recursive: true, force: true });
});
