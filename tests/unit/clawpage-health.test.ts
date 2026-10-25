import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { GRAPHIC_RENDER_PY, SHARE_CLI_PY } from "../../src/control/sandbox/seed.js";

// The publish check runs in the sandbox's Python: the renderer keeps the DevTools events asked for,
// and aio-share turns one page load's events into the report the executor reads.
let dir: string;
const python = (script: string, input: unknown = null) =>
  JSON.parse(execFileSync("python3", ["-I", path.join(dir, script), ...[path.join(dir, "tools", "aio-share", "aio-share.py")]], { input: JSON.stringify(input), encoding: "utf8", timeout: 60_000 }));

const PAGE_PY = String.raw`import collections, importlib.util, inspect, json, os, sys, threading
spec = importlib.util.spec_from_file_location("aio_render", os.path.join(os.path.dirname(os.path.dirname(sys.argv[1])), "aio-graphic", "aio-render.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

def page(keep):
    # A Page without a browser: the test plays Chromium on the other ends of its two pipes.
    p = r.Page.__new__(r.Page)
    commands, p.to_chrome = os.pipe()
    p.from_chrome, replies = os.pipe()
    p.buf, p.next_id, p.session = b"", 0, "S1"
    p.events, p.keep = collections.deque(maxlen=r.EVENTS_MAX), keep
    return p, replies

def feed(fd, messages):
    # From a thread: more than a pipe holds is written while call() reads.
    t = threading.Thread(target=lambda: [os.write(fd, json.dumps(m).encode() + b"\0") for m in messages])
    t.start()
    return t

def event(method, n=0):
    return {"method": method, "params": {"n": n}, "sessionId": "S1"}

out = {"eventsMax": r.EVENTS_MAX}
init = inspect.getsource(r.Page.__init__)
out["initOrder"] = init.index("self.keep = None") < init.index("self.call(") and "collections.deque(maxlen=EVENTS_MAX)" in init

p, w = page(None)
feed(w, [event("Network.requestWillBeSent"), event("Runtime.exceptionThrown"), {"id": 1, "result": {"v": 7}}]).join()
out["noKeep"] = {"result": p.call("Runtime.evaluate"), "events": len(p.events)}

p, w = page(lambda m: m["method"] == "Runtime.exceptionThrown")
feed(w, [event("Network.dataReceived"), event("Runtime.exceptionThrown", 1), {"id": 99, "result": {}}, {"id": 1, "result": {"v": 8}}, event("Runtime.exceptionThrown", 2)]).join()
first = p.call("X")
# A second call reads on (the event after the first reply), and a later reply's error still raises.
feed(w, [{"id": 2, "error": {"message": "nope"}}]).join()
try:
    p.call("Y")
    raised = None
except RuntimeError as err:
    raised = str(err)
out["filtered"] = {"result": first, "kept": [e["params"]["n"] for e in p.events], "raised": raised}

p, w = page(lambda m: True)
t = feed(w, [event("Log.entryAdded", i) for i in range(r.EVENTS_MAX + 5)] + [{"id": 1, "result": {}}])
p.call("Z")
t.join()
kept = p.drain()
out["overflow"] = {"count": len(kept), "first": kept[0]["params"]["n"], "last": kept[-1]["params"]["n"], "after": len(p.events), "again": p.drain()}
print(json.dumps(out))
`;

const HEALTH_PY = String.raw`import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("aio_share", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
job = json.load(sys.stdin)
if job["do"] == "health":
    print(json.dumps(m.page_health(*job["args"])))
elif job["do"] == "keep":
    print(json.dumps([m.keep_event(e) for e in job["events"]]))
elif job["do"] == "bodies":
    class Page:
        asked = []
        def call(self, method, params=None, session=False, timeout=60):
            assert method == "Network.getResponseBody" and session and timeout == m.CHECK_BODY_SECONDS
            self.asked.append(params["requestId"])
            body = job["bodies"].get(params["requestId"])
            if body is None:
                raise RuntimeError("No resource with given identifier found")
            return body
    page = Page()
    print(json.dumps({"bodies": m.fetch_bodies(page, job["events"], job["url"]), "asked": page.asked}))
else:
    covers = m.Covers()
    try:
        covers.render(job["url"])
        print(json.dumps(covers.health))
    finally:
        covers.close()
`;

const PAGE = "https://w.example.com/u/ann/share/poll/";
const sent = (requestId: string, url: string, method = "GET") => ({ method: "Network.requestWillBeSent", params: { requestId, request: { url, method } } });
const answered = (requestId: string, url: string, status: number) => ({ method: "Network.responseReceived", params: { requestId, response: { url, status } } });
const loadFailed = (requestId: string, more: Record<string, unknown>) => ({ method: "Network.loadingFailed", params: { requestId, ...more } });
const health = (events: unknown[], bodies: Record<string, string> = {}, hasContent = true, url = PAGE) =>
  python("health.py", { do: "health", args: [events, bodies, url, hasContent] });
const clean = { ok: true, errors: [], failedRequests: [], expected: [], blank: false };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-clawpage-health-"));
  fs.mkdirSync(path.join(dir, "tools", "aio-share"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tools", "aio-graphic"));
  fs.writeFileSync(path.join(dir, "tools", "aio-share", "aio-share.py"), SHARE_CLI_PY);
  // This machine's Chromium; it lists its first tab a moment after starting, where the sandbox's is ready at once.
  const browser = GRAPHIC_RENDER_PY.replace('BROWSER = "/usr/local/bin/chromium"', `BROWSER = ${JSON.stringify(chromium.executablePath())}`)
    .replace('targets = self.call("Target.getTargets")["targetInfos"]', 'targets = []\n            for _ in range(100):\n                targets = self.call("Target.getTargets")["targetInfos"]\n                if any(t["type"] == "page" for t in targets):\n                    break\n                time.sleep(0.1)');
  expect(browser).toContain("for _ in range(100)");
  fs.writeFileSync(path.join(dir, "tools", "aio-graphic", "aio-render.py"), browser);
  fs.writeFileSync(path.join(dir, "page.py"), PAGE_PY);
  fs.writeFileSync(path.join(dir, "health.py"), HEALTH_PY);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it("the renderer keeps only the events asked for, the newest EVENTS_MAX at most, and drain empties them", () => {
  const r = python("page.py");
  expect(r.eventsMax).toBe(1000);
  expect(r.initOrder).toBe(true);
  // Without keep (aio-render itself), not one event is stored.
  expect(r.noKeep).toEqual({ result: { v: 7 }, events: 0 });
  // keep filters; replies to other ids are still dropped; errors still raise.
  expect(r.filtered).toEqual({ result: { v: 8 }, kept: [1, 2], raised: "Y: nope" });
  expect(r.overflow).toEqual({ count: 1000, first: 5, last: 1004, after: 0, again: [] });
});

it("keeps for the check only errors, every request sent, error answers and failed loads", () => {
  expect(python("health.py", { do: "keep", events: [
    { method: "Runtime.exceptionThrown", params: {} },
    { method: "Runtime.consoleAPICalled", params: { type: "error" } },
    { method: "Runtime.consoleAPICalled", params: { type: "log" } },
    { method: "Log.entryAdded", params: { entry: { level: "error" } } },
    { method: "Log.entryAdded", params: { entry: { level: "warning" } } },
    sent("1", PAGE),
    answered("1", PAGE, 400),
    answered("1", PAGE, 304),
    loadFailed("1", {}),
    { method: "Network.dataReceived", params: { requestId: "1" } },
    { method: "Network.responseReceivedExtraInfo", params: { requestId: "1", statusCode: 500 } },
    { method: "Page.loadEventFired", params: {} },
  ] })).toEqual([true, true, false, true, false, true, true, false, true, false, false, false]);
});

it("reads at most five small error answers, of the page's own data paths only", () => {
  const own = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const events = [
    answered("other", "https://cdn.example.net/x.json", 404),
    answered("file", `${PAGE}app.js`, 404),
    answered("big", `${PAGE}.data/big`, 500),
    answered("b64", `${PAGE}.auth/token`, 500),
    answered("gone", `${PAGE}.ai`, 500),
    ...own.map((id) => answered(id, `${PAGE}.data/t${id}`, 404)),
  ];
  const bodies: Record<string, unknown> = { big: { body: "x".repeat(4097), base64Encoded: false }, b64: { body: "e30=", base64Encoded: true } };
  for (const id of own) bodies[id] = { body: `{"error":"E_${id}"}`, base64Encoded: false };
  const r = python("health.py", { do: "bodies", events, bodies, url: PAGE });
  expect(r.asked).toEqual(["big", "b64", "gone", "a", "b", "c", "d", "e"]);
  expect(r.bodies).toEqual({ a: '{"error":"E_a"}', b: '{"error":"E_b"}', c: '{"error":"E_c"}', d: '{"error":"E_d"}', e: '{"error":"E_e"}' });
});

describe("page_health", () => {
  it("a page with nothing wrong, and one that shows nothing", () => {
    expect(health([])).toEqual(clean);
    expect(health([], {}, false)).toEqual({ ...clean, ok: false, blank: true });
  });

  it("names the page's own files by path, other hosts by name, and ignores data:, blob:, the favicon and requests of the page before", () => {
    const r = health([
      sent("1", `${PAGE}img/a.png?v=2#x`), answered("1", `${PAGE}img/a.png?v=2#x`, 404),
      sent("2", `${PAGE}?q=1`), answered("2", `${PAGE}?q=1`, 500),
      sent("3", "https://cdn.example.net/lib.js?key=secret"), answered("3", "https://cdn.example.net/lib.js?key=secret", 403),
      sent("4", "https://w.example.com/clawpage-sso?page=x"), answered("4", "https://w.example.com/clawpage-sso?page=x", 502),
      sent("5", "data:image/png;base64,AAAA"), loadFailed("5", { errorText: "net::ERR_INVALID_URL" }),
      sent("6", "blob:https://w.example.com/1"), loadFailed("6", { errorText: "net::ERR_FILE_NOT_FOUND" }),
      sent("7", "https://w.example.com/favicon.ico"), answered("7", "https://w.example.com/favicon.ico", 404),
      answered("old", `${PAGE}old.js`, 404), loadFailed("old2", { errorText: "net::ERR_FAILED" }),
    ], {}, true, `${PAGE}?ref=chat#token`);
    expect(r.failedRequests).toEqual([
      { method: "GET", url: "img/a.png", status: 404 },
      { method: "GET", url: "index.html", status: 500 },
      { method: "GET", url: "cdn.example.net", status: 403 },
      { method: "GET", url: "w.example.com", status: 502 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("gives the page's own data errors their code; sign-in and missing records are expected", () => {
    const urls: Record<string, string> = { t: ".data/votes", p: ".data/secret/k", s: ".ai", r: ".data/notes/k1", a: ".auth/session", n: ".data/plain", x: ".data/x" };
    const events = Object.entries(urls).flatMap(([id, u]) => [sent(id, PAGE + u, id === "s" ? "POST" : "GET"), answered(id, PAGE + u, id === "s" || id === "a" ? 401 : id === "x" ? 500 : 404)]);
    events.push(sent("o", "https://api.example.org/.data/votes"), answered("o", "https://api.example.org/.data/votes", 404));
    const r = health(events, {
      t: '{"error":"TABLE_NOT_FOUND"}', p: '{"error":"PERMISSION_DENIED","message":"no"}', s: '{"error":"SIGN_IN_REQUIRED"}',
      r: '{"error":"RECORD_NOT_FOUND"}', a: '{"error":"SIGN_IN_EXPIRED"}', n: "not json", x: '{"error":7}', o: '{"error":"RECORD_NOT_FOUND"}',
    });
    expect(r.failedRequests).toEqual([
      { method: "GET", url: ".data/votes", status: 404, code: "TABLE_NOT_FOUND" },
      { method: "GET", url: ".data/secret/k", status: 404, code: "PERMISSION_DENIED" },
      { method: "GET", url: ".auth/session", status: 401, code: "SIGN_IN_EXPIRED" },
      { method: "GET", url: ".data/plain", status: 404 },
      { method: "GET", url: ".data/x", status: 500 },
      // Not the page's own data path: no code read, even with a body.
      { method: "GET", url: "api.example.org", status: 404 },
    ]);
    expect(r.expected).toEqual([
      { method: "POST", url: ".ai", status: 401, code: "SIGN_IN_REQUIRED" },
      { method: "GET", url: ".data/notes/k1", status: 404, code: "RECORD_NOT_FOUND" },
    ]);
    // Expected entries alone leave the page ok.
    expect(health(events.slice(4, 6).concat(events.slice(6, 8)), { s: '{"error":"SIGN_IN_REQUIRED"}', r: '{"error":"RECORD_NOT_FOUND"}' })).toEqual({
      ...clean, expected: [{ method: "POST", url: ".ai", status: 401, code: "SIGN_IN_REQUIRED" }, { method: "GET", url: ".data/notes/k1", status: 404, code: "RECORD_NOT_FOUND" }],
    });
  });

  it("reports failed loads with their reason or what blocked them, never loads cut short", () => {
    const r = health([
      sent("1", "https://gone.example/a.js"), loadFailed("1", { errorText: "net::ERR_NAME_NOT_RESOLVED" }),
      sent("2", `${PAGE}x.js`), loadFailed("2", { errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "csp" }),
      sent("3", `${PAGE}y.js`), loadFailed("3", { errorText: "net::ERR_FAILED", canceled: true }),
      sent("4", `${PAGE}z.js`, "POST"), loadFailed("4", { errorText: "net::ERR_ABORTED" }),
    ]);
    expect(r.failedRequests).toEqual([
      { method: "GET", url: "gone.example", status: null, reason: "net::ERR_NAME_NOT_RESOLVED" },
      { method: "GET", url: "x.js", status: null, reason: "blocked:csp" },
    ]);
  });

  it("reports exceptions, console errors and error log entries, network log entries apart", () => {
    const r = health([
      { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", url: `${PAGE}app.js?v=3`, lineNumber: 41, exception: { description: "TypeError: x is undefined\n    at go (app.js:42:3)" } } } },
      { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught SyntaxError: bad", url: "", lineNumber: 0 } } },
      { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", url: "https://cdn.example.net/x.js", lineNumber: 0, exception: { description: "Error: cdn" } } } },
      { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ type: "string", value: "failed to load" }, { type: "string", value: "ignored" }] } },
      { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ type: "object", description: "Error: thrown object" }] } },
      { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ type: "number", value: 42 }] } },
      { method: "Log.entryAdded", params: { entry: { level: "error", source: "security", text: "Refused to run inline script", url: `${PAGE}` } } },
      { method: "Log.entryAdded", params: { entry: { level: "error", source: "javascript", text: "no url" } } },
      { method: "Log.entryAdded", params: { entry: { level: "error", source: "network", text: "Failed to load resource", url: `${PAGE}a.png` } } },
    ]);
    expect(r.errors).toEqual([
      { kind: "exception", message: "TypeError: x is undefined", where: "app.js:42" },
      { kind: "exception", message: "Uncaught SyntaxError: bad" },
      { kind: "exception", message: "Error: cdn", where: "cdn.example.net:1" },
      { kind: "console", message: "failed to load" },
      { kind: "console", message: "Error: thrown object" },
      { kind: "console", message: "42" },
      { kind: "log", message: "Refused to run inline script", where: "index.html" },
      { kind: "log", message: "no url" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.failedRequests).toEqual([]);
  });

  it("cuts every text to 200 characters and each list to ten, counting what was left out", () => {
    const long = "y".repeat(500);
    const events: unknown[] = [];
    for (let i = 0; i < 12; i++) events.push({ method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: `${i}${long}` }] } });
    for (let i = 0; i < 13; i++) events.push(sent(`f${i}`, `${PAGE}${long}${i}.png`), answered(`f${i}`, `${PAGE}${long}${i}.png`, 404));
    for (let i = 0; i < 11; i++) events.push(sent(`e${i}`, `${PAGE}.data/t/k${i}`), answered(`e${i}`, `${PAGE}.data/t/k${i}`, 404));
    const bodies = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`e${i}`, '{"error":"RECORD_NOT_FOUND"}']));
    const r = health(events, bodies);
    expect(r.errors).toHaveLength(10);
    expect(r.failedRequests).toHaveLength(10);
    expect(r.expected).toHaveLength(10);
    expect(r.omitted).toBe(2 + 3 + 1);
    expect(r.errors[0].message).toHaveLength(200);
    expect(r.failedRequests[0].url).toHaveLength(200);
    // Without anything cut, no omitted.
    expect(health(events.slice(0, 3))).not.toHaveProperty("omitted");
  });
});

it.skipIf(!fs.existsSync(chromium.executablePath()))("in a real browser, a page's script error and a missing picture are reported", () => {
  const site = path.join(dir, "site");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "index.html"), '<!doctype html><meta charset="utf-8"><h1>Hello</h1>\n<img src="missing.png">\n<script>throw new Error("boom")</script>');
  const r = python("health.py", { do: "render", url: `file://${site}/index.html` });
  expect(r.errors).toContainEqual(expect.objectContaining({ kind: "exception", message: expect.stringContaining("boom"), where: "index.html:3" }));
  expect(r.failedRequests).toContainEqual(expect.objectContaining({ url: "missing.png", status: null }));
  expect(r).toMatchObject({ ok: false, blank: false });
});
