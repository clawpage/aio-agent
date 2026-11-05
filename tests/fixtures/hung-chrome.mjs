/**
 * Stands in for a hung Google Chrome in tests/unit/user-browser.test.ts: it holds
 * the profile (SingletonLock, DevToolsActivePort) and keeps its DevTools port open,
 * but never answers on it, and ignores SIGTERM as a Chrome whose main thread is stuck does.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const profile = process.argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!profile) process.exit(2);
fs.mkdirSync(profile, { recursive: true });
const sockets = [];
const server = net.createServer((socket) => sockets.push(socket));
process.on("SIGTERM", () => undefined);
server.listen(0, "127.0.0.1", () => {
  fs.rmSync(path.join(profile, "SingletonLock"), { force: true });
  fs.symlinkSync(`fakehost-${process.pid}`, path.join(profile, "SingletonLock"));
  fs.writeFileSync(path.join(profile, "DevToolsActivePort"), `${server.address().port}\n/devtools/browser/hung\n`);
});
