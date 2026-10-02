import { appVersion } from "../common/build.js";
import { Logger } from "../common/logger.js";
import { readSecretFile } from "../common/secrets.js";
import { loadSandboxdConfig, NODE_TOKEN_KEY } from "./config.js";
import { DockerCli } from "./docker.js";
import { SandboxDriver } from "./driver.js";
import { createGatewayRelay } from "./relay.js";
import { createSandboxd } from "./server.js";

/** sandboxd: the sandbox layer's node daemon. It owns Docker on this machine; see common/protocol.ts. */
async function main(): Promise<void> {
  const cfg = loadSandboxdConfig();
  const log = new Logger(process.env.PA_LOG_LEVEL === "debug" ? "debug" : "info", cfg.logDir ? `${cfg.logDir}/sandboxd.log` : undefined, true).child("sandboxd");
  const fromEnv = process.env[NODE_TOKEN_KEY]?.trim();
  const file = fromEnv ? null : cfg.tokenFile ? readSecretFile(cfg.tokenFile, NODE_TOKEN_KEY) : { ok: false as const, reason: "PA_SANDBOXD_TOKEN_FILE is not set" };
  const token = fromEnv ?? (file?.ok ? file.value : null);
  if (!token || token.length < 32) throw new Error(`node token unavailable: ${file && !file.ok ? file.reason : "shorter than 32 characters"}`);
  const driver = new SandboxDriver(cfg, log, new DockerCli());
  const version = appVersion();
  const server = createSandboxd({ driver, log, token, version });
  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.bind, resolve));
  log.info("sandboxd listening", { bind: cfg.bind, port: cfg.port, version, containerHost: cfg.containerHost });
  const relay = cfg.gateway ? createGatewayRelay(cfg.gateway.upstream, log) : null;
  if (relay && cfg.gateway) {
    await new Promise<void>((resolve) => relay.listen(cfg.gateway!.port, cfg.gateway!.bind, resolve));
    log.info("gateway relay listening", { bind: cfg.gateway.bind, port: cfg.gateway.port });
  }
  const close = (signal: string) => {
    log.info("shutting down", { signal });
    // Running sandboxes and the commands inside them are left alone; only connections end.
    server.closeAllConnections();
    server.close();
    relay?.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGTERM", () => close("SIGTERM"));
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: "error", msg: "fatal startup error", error: String(err) }));
    process.exit(1);
  });
}
