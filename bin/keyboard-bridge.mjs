#!/usr/bin/env node
/**
 * Keyboard bridge: types the voice gadget's dictation at the cursor on this Mac.
 * The typing is done by a small background app, "AIO Keyboard" (bin/keyboard-bridge/main.swift),
 * so that macOS's Accessibility permission belongs to that app alone and not to whatever
 * launched it. It listens on loopback (default 127.0.0.1:4904); every request needs the bridge
 * token (KEYBOARD_BRIDGE_TOKEN), which only the control plane holds.
 *
 *   node bin/keyboard-bridge.mjs setup
 *     builds the app into var/keyboard (Xcode's command-line tools) and creates the token file
 *   node bin/keyboard-bridge.mjs
 *     opens the app and keeps it running; on SIGTERM asks it to quit
 *
 * Rebuilding the app changes its signature: macOS then asks for Accessibility again.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = process.env.PA_KEYBOARD_DIR ?? path.join(ROOT, "var", "keyboard");
const APP = path.join(DIR, "AIO Keyboard.app");
const BIN = path.join(APP, "Contents", "MacOS", "aio-keyboard");
const SOURCE = path.join(ROOT, "bin", "keyboard-bridge", "main.swift");
const PORT = Number(process.env.PA_KEYBOARD_BRIDGE_PORT ?? 4904);
const SECRETS_FILE = (process.env.PA_KEYBOARD_BRIDGE_SECRETS_FILE ?? "~/.config/aio-agent/keyboard-bridge.env").replace(/^~(?=\/|$)/, os.homedir());
const TOKEN_KEY = "KEYBOARD_BRIDGE_TOKEN";
const CHECK_MS = 15_000;

function log(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: "keyboard-bridge", msg, ...extra }) + "\n");
}

function readToken() {
  try {
    const line = fs.readFileSync(SECRETS_FILE, "utf8").split("\n").find((l) => l.startsWith(`${TOKEN_KEY}=`));
    return line?.slice(TOKEN_KEY.length + 1).trim() || null;
  } catch {
    return null;
  }
}

async function setup() {
  fs.mkdirSync(path.join(APP, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(APP, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.clawpage.aio-keyboard</string>
  <key>CFBundleName</key><string>AIO Keyboard</string>
  <key>CFBundleExecutable</key><string>aio-keyboard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`);
  await run("swiftc", ["-O", "-o", BIN, SOURCE]);
  await run("codesign", ["--force", "--sign", "-", "--identifier", "ai.clawpage.aio-keyboard", APP]);
  console.log(`built ${APP}`);
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true, mode: 0o700 });
  if (!readToken()) {
    fs.writeFileSync(SECRETS_FILE, `${TOKEN_KEY}=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    console.log(`wrote ${SECRETS_FILE}`);
  }
  console.log("Next: let \"AIO Keyboard\" type (System Settings > Privacy & Security > Accessibility); macOS asks on the first dictation.");
}

async function request(token, method, route) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) });
  return res.ok ? res.json() : null;
}

async function main() {
  const token = readToken();
  if (!token) { log(`fatal: ${TOKEN_KEY} missing; run node bin/keyboard-bridge.mjs setup`); process.exit(1); }
  if (!fs.existsSync(BIN)) { log("fatal: AIO Keyboard missing; run node bin/keyboard-bridge.mjs setup"); process.exit(1); }
  let last = null;
  const check = async () => {
    const status = await request(token, "GET", "/status").catch(() => null);
    if (!status) {
      // Opened through Launch Services, the app is its own process as far as macOS's privacy checks go.
      log("opening AIO Keyboard");
      await run("open", ["-g", "-a", APP, "--args", "--port", String(PORT), "--secrets", SECRETS_FILE]).catch((err) => log("open failed", { error: err.message }));
    } else if (status.trusted !== last) {
      log(status.trusted ? "AIO Keyboard can type" : "AIO Keyboard needs Accessibility (System Settings > Privacy & Security > Accessibility)");
      last = status.trusted;
    }
  };
  await check();
  const timer = setInterval(check, CHECK_MS);
  const stop = async () => {
    clearInterval(timer);
    await request(token, "POST", "/quit").catch(() => null);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[2] === "setup") {
  setup().catch((err) => { console.error(err.message); process.exit(1); });
} else {
  main();
}
