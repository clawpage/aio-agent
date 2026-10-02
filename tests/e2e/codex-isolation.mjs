// Real sandbox metadata only: no model turn, mailbox read, or MCP tool execution.
// Run after building and starting production: npm run smoke:isolation.
import assert from "node:assert/strict";
import { loadConfig } from "../../dist/control/config.js";
import { SandboxContainer } from "../../dist/control/sandbox/container.js";
import { SandboxNodes } from "../../dist/control/sandbox/nodes.js";
import { HostTokenSource } from "../../dist/control/codex/hostTokens.js";
import { JsonRpcPeer } from "../../dist/control/codex/jsonrpc.js";
import { Logger } from "../../dist/common/logger.js";

const cfg = loadConfig();
const log = new Logger("error", undefined, false);
const sandbox = new SandboxContainer(cfg, log, new SandboxNodes(cfg).nodes[0]);
const host = new HostTokenSource(cfg, log);
let peer;
async function cli(args) {
  const result = await sandbox.execInSandbox(["env", `CODEX_HOME=${cfg.sandbox.containerCodexHome}`, cfg.sandbox.codexBin, ...args]);
  // Do not echo stderr or full configuration: it may contain personal settings.
  assert.equal(result.code, 0, "sandbox Codex metadata command must succeed");
  return result.stdout;
}
try {
  assert.equal((await sandbox.inspect()).managedLabel, "1", "the sandbox must be one this system manages");
  const features = await cli(["-c", "features.apps=true", "-c", "features.plugins=true", "-c", "features.remote_plugin=true", "features", "list"]);
  for (const name of ["apps", "plugins", "remote_plugin"]) {
    assert.match(features, new RegExp(`^${name}\\s+\\S+\\s+false$`, "m"), "system policy must override attempted re-enabling");
  }
  for (const name of ["isolation_probe", "aio_browser"]) {
    const servers = JSON.parse(await cli(["-c", `mcp_servers.${name}.url="http://127.0.0.1:9/mcp"`, "mcp", "list", "--json"]));
    const denied = servers.find(server => server.name === name);
    assert.equal(denied?.enabled, false, "unknown MCP and repointed AIO must both be denied");
    assert.match(denied.disabled_reason, /requirements/);
  }
  console.log("PASS managed feature pins and exact MCP URL allowlist");

  peer = new JsonRpcPeer(sandbox.spawnCodexAppServer(), "isolation-probe");
  await peer.request("initialize", { clientInfo: { name: "personal-agent-isolation-probe", version: "1" }, capabilities: { experimentalApi: true } });
  peer.notify("initialized");
  const token = await host.getTokens();
  await peer.request("account/login/start", { type: "chatgptAuthTokens", accessToken: token.accessToken, chatgptAccountId: token.chatgptAccountId, chatgptPlanType: token.planType });
  const config = await peer.request("config/read", { includeLayers: false });
  for (const name of ["apps", "plugins", "remote_plugin"]) assert.equal(config.config?.features?.[name], false);
  assert.equal(config.config?.apps?._default?.enabled, false);
  const status = await peer.request("mcpServerStatus/list", {});
  assert.ok(Array.isArray(status.data));
  assert.deepEqual(status.data.map(server => server.name), ["aio_browser"]);
  assert.ok(!status.nextCursor);
  const count = Object.keys(status.data[0].tools ?? {}).length;
  assert.ok(count > 0, "AIO tools must still load");
  const apps = await peer.request("app/list", {});
  assert.deepEqual(apps.data, []);
  assert.ok(!apps.nextCursor);
  console.log(`PASS authenticated sandbox: aio_browser (${count} tools), zero account apps`);
} finally {
  peer?.close();
  host.close();
}
