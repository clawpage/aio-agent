import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type TestHarness } from "../helpers/harness.js";
import { createMember } from "../../src/control/auth/owner.js";
import { suspensionKey } from "../../src/control/auth/suspension.js";

let h: TestHarness;
let userId: string;
const json = { "content-type": "application/json" };
const signIn = () => h.request("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ username: "stopped", password: "member-password-123" }) });
beforeAll(async () => {
  h = await startHarness();
  userId = (await createMember(h.ctx.db, "stopped", "member-password-123")).id;
});
afterAll(async () => { await h?.shutdown(); });

it("signs a suspended account out and answers its sign-in with the account notice", async () => {
  const ok = await signIn();
  expect(ok.status).toBe(200);
  const cookie = ok.headers.getSetCookie().map(s => s.split(";")[0]).join("; ");
  h.ctx.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(suspensionKey(userId), String(Date.now()));
  expect(await (await h.request("/api/auth/session", { headers: { cookie } })).json()).toMatchObject({ authenticated: false });
  expect((await h.request("/api/tasks", { headers: { cookie } })).status).toBe(401);
  const refused = await signIn();
  expect(refused.status).toBe(403);
  expect(refused.headers.getSetCookie().join(";")).not.toContain("pa_session=");
  expect(await refused.json()).toMatchObject({ error: "account_suspended", message: expect.stringContaining("feedback@clawpage.ai") });
  // A wrong password still says only that, so the notice does not confirm which accounts exist.
  const wrong = await h.request("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ username: "stopped", password: "not-the-password-1" }) });
  expect(wrong.status).toBe(401);
});
