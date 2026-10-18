/**
 * Stands in for Google Chrome in tests/unit/user-browser.test.ts: started with
 * --user-data-dir, it writes DevToolsActivePort there and answers the DevTools
 * calls bin/user-browser.mjs makes. Plain HTTP on the same port lets the fake
 * chrome-devtools-mcp see the pages (/json/list), navigate and mark them; every
 * DevTools call is appended to <profile>/calls.jsonl for the test to read.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

const profile = process.argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!profile) process.exit(2);
fs.writeFileSync(path.join(profile, "args.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(profile, "pid"), String(process.pid));
const targets = [{ targetId: "T0", url: "about:blank", mark: null }];
let created = 0;
const record = (entry) => fs.appendFileSync(path.join(profile, "calls.jsonl"), JSON.stringify(entry) + "\n");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://chrome");
  const target = targets.find((t) => t.targetId === url.searchParams.get("target"));
  if (url.pathname === "/json/list") res.end(JSON.stringify(targets));
  else if (url.pathname === "/navigate" && target) { target.url = url.searchParams.get("url"); res.end("{}"); }
  else if (url.pathname === "/mark" && target) { target.mark = url.searchParams.get("mark"); res.end("{}"); }
  else { res.statusCode = 404; res.end(); }
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const { id, method, params = {}, sessionId } = JSON.parse(String(data));
    record({ method, params, sessionId });
    const answer = (result) => ws.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
    const of = (s) => targets.find((t) => `S-${t.targetId}` === s);
    switch (method) {
      case "Target.createTarget": {
        const target = { targetId: `T${++created}`, url: params.url, mark: null };
        targets.push(target);
        return answer({ targetId: target.targetId });
      }
      case "Target.closeTarget":
        targets.splice(targets.findIndex((t) => t.targetId === params.targetId), 1);
        return answer({ success: true });
      case "Target.getTargets":
        return answer({ targetInfos: targets.map((t) => ({ targetId: t.targetId, type: "page", url: t.url })) });
      case "Target.attachToTarget":
        return answer({ sessionId: `S-${params.targetId}` });
      case "Runtime.evaluate":
        return answer({ result: { type: "string", value: of(sessionId)?.mark ?? undefined } });
      case "Page.getLayoutMetrics":
        return answer({ cssVisualViewport: { clientWidth: 1280, clientHeight: 700 } });
      case "Page.captureScreenshot":
        return answer({ data: Buffer.from("first").toString("base64") });
      case "Page.startScreencast":
        answer({});
        return ws.send(JSON.stringify({ method: "Page.screencastFrame", sessionId, params: { data: Buffer.from("frame").toString("base64"), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 640 } } }));
      case "Page.getNavigationHistory":
        return answer({ currentIndex: 1, entries: [{ id: 10 }, { id: 11 }] });
      case "Browser.close":
        answer({});
        return setTimeout(() => process.exit(0), 20);
      default:
        return answer({});
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(profile, "DevToolsActivePort"), `${server.address().port}\n/devtools/browser/fake\n`);
});
process.on("SIGTERM", () => process.exit(0));
