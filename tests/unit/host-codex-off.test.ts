import { expect, it } from "vitest";
import { HostTokenSource } from "../../src/control/codex/hostTokens.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig } from "../helpers/harness.js";

it("reports nothing to log in to and never starts the host Codex when it is off", async () => {
  const cfg = testConfig("/tmp/pa-host-codex-off", 1, { PA_HOST_CODEX: "off", PA_HOST_CODEX_BIN: "/nonexistent/codex" });
  const source = new HostTokenSource(cfg, new Logger("error", undefined, false));
  expect(await source.status()).toEqual({ ok: true, authMethod: "disabled", email: null, planType: null, expiresAt: null, error: null });
  await expect(source.getTokens()).rejects.toThrow("PA_HOST_CODEX=off");
  expect(testConfig("/tmp/pa-host-codex-on", 1).hostCodex.enabled).toBe(true);
});
