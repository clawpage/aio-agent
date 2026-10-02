// Child process for tests/integration/patchright-patch.test.ts: reads a page whose
// renderer crashed right after a new document committed, before anything read it.
// Prints one JSON line; a frozen event loop prints nothing (the parent times out).
const net = require("node:net");
const { chromium: launcher } = require("playwright-core");
const { chromium } = require(process.argv[2]);

(async () => {
  const port = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const launched = await launcher.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await browser.contexts()[0].newPage();
    await page.goto("data:text/html,<title>a</title>a");
    await page.title();
    // A new document resets the cached execution contexts…
    await page.goto("data:text/html,<title>b</title>b", { waitUntil: "commit" });
    // …and its renderer crashes before anything reads it.
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.url.includes("<title>b"));
    await new Promise((resolve) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.crash" }));
      ws.onclose = resolve; ws.onerror = resolve; setTimeout(resolve, 3000);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await page.evaluate("1").then((v) => `value ${v}`, (e) => `error: ${String(e.message).split("\n")[0]}`);
    console.log(JSON.stringify({ result }));
  } finally {
    await launched.close();
  }
})();
