import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";

/** Where the stub workspace origin serves the published component. */
const WORKSPACE = "https://workspace.test";

/**
 * A published component as the frame sees it: it speaks the widget protocol
 * itself (the real server injects a runtime that does this as window.aio).
 */
const WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:12px;font:14px sans-serif}</style></head><body>
<div id="flights">…</div><div id="mode"></div><div id="accent"></div><div id="answer"></div><div id="who"></div>
<button id="ask">ask</button><button id="send">send</button><button id="grow">grow</button>
<script>
  const post = (m) => parent.postMessage(m, "*");
  const theme = (t) => { document.getElementById("mode").textContent = "mode:" + t.mode; document.getElementById("accent").textContent = "accent:" + t.vars["--aio-accent"]; document.body.style.background = t.vars["--aio-surface"]; document.body.style.color = t.vars["--aio-text"]; };
  addEventListener("message", (e) => {
    const m = e.data;
    if (m.aio === "init") {
      document.getElementById("flights").textContent = m.data.flights.map((f) => f.no).join(", ");
      document.getElementById("who").textContent = "user:" + m.user.username + " locale:" + m.locale;
      theme(m.theme);
      post({ aio: "resize", height: 240 });
    }
    if (m.aio === "theme") theme(m.theme);
    if (m.aio === "result") document.getElementById("answer").textContent = m.ok ? "AI:" + m.value.text : "ERR:" + m.error.code;
  });
  document.getElementById("ask").onclick = () => post({ aio: "call", id: "c1", op: "ai", args: { input: "UA 857 准点吗" } });
  document.getElementById("send").onclick = () => post({ aio: "send", text: "  帮我订 UA 857  " });
  document.getElementById("grow").onclick = () => post({ aio: "resize", height: 99999 });
  post({ aio: "ready" });
</script></body></html>`;

const block = (spec: unknown) => `\`\`\`widget\n${JSON.stringify(spec)}\n\`\`\``;

function task(result: string) {
  return { id: "task-1", revision: 1, title: "查航班", text: "看看航班", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() };
}

async function setup(page: Page, result: string, opts: { ticketFails?: boolean } = {}) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(result)], nextBefore: null } }));
  const tickets: string[] = [];
  await page.route((url) => url.pathname === "/api/workspace/ticket", async (r) => {
    const { next } = JSON.parse(r.request().postData() ?? "{}") as { next: string };
    tickets.push(next);
    if (opts.ticketFails) return r.fulfill({ status: 503, json: { error: "unavailable", message: "down" } });
    return r.fulfill({ json: { ticket: "t", origin: WORKSPACE, url: `${WORKSPACE}${next}?ticket=t`, expiresAt: Date.now() + 60_000 } });
  });
  await page.route(`${WORKSPACE}/**`, (r) => r.fulfill({ contentType: "text/html", body: WIDGET_HTML }));
  const aiCalls: unknown[] = [];
  await page.route((url) => url.pathname === "/api/widgets/ai", (r) => {
    aiCalls.push(JSON.parse(r.request().postData() ?? "{}"));
    return r.fulfill({ json: { text: "准点", model: "test-model" } });
  });
  const sent: string[] = [];
  await page.route((url) => url.pathname === "/api/tasks", (r) => {
    if (r.request().method() === "POST") sent.push(r.request().postData() ?? "");
    return r.fallback();
  });
  await page.goto("/");
  await page.locator(".bubble").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  return { tickets, aiCalls, sent };
}

test("a ```widget block runs the published component: sized by it, themed, its AI call answered, its text put in the composer unsent", async ({ page }, info) => {
  const { tickets, aiCalls, sent } = await setup(page, `今天的航班：\n\n${block({ component: "flight-board", data: { flights: [{ no: "UA 857" }, { no: "CA 986" }] }, title: "航班看板" })}\n\n祝顺利。`);
  const card = page.locator(".widget-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("aria-label", "组件：航班看板");
  await expect(card.locator(".widget-title")).toHaveText("航班看板");
  const bubble = page.locator(".bubble").filter({ has: card });
  await expect(bubble).toContainText("今天的航班");
  await expect(bubble).toContainText("祝顺利");
  await expect(bubble.locator("pre")).toHaveCount(0);

  const frame = page.frameLocator(".widget-card iframe");
  await expect(frame.locator("#flights")).toHaveText("UA 857, CA 986");
  await expect(frame.locator("#who")).toHaveText("user:owner locale:zh-CN");
  expect(tickets).toEqual(["/widgets/flight-board/"]);
  const iframe = card.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms");
  await expect(card.locator(".widget-status")).toHaveCount(0);
  // The frame said how tall it is.
  await expect.poll(async () => Math.round((await iframe.boundingBox())!.height)).toBe(240);

  // The theme reaches the frame as concrete values, and follows a switch.
  await expect(frame.locator("#accent")).toHaveText(/^accent:#[0-9a-f]{6}$/i);
  const next = (await frame.locator("#mode").textContent()) === "mode:light" ? "dark" : "light";
  await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, next);
  await expect(frame.locator("#mode")).toHaveText(`mode:${next}`);

  // An AI call goes to the console's API under the component's name, and its answer comes back.
  await frame.locator("#ask").click();
  await expect(frame.locator("#answer")).toHaveText("AI:准点");
  expect(aiCalls).toEqual([{ input: "UA 857 准点吗", name: "flight-board" }]);

  // send fills the composer (after what is there) without sending.
  const composer = page.getByRole("textbox", { name: "消息" });
  await composer.fill("先看看");
  await frame.locator("#send").click();
  await expect(composer).toHaveValue("先看看\n帮我订 UA 857");
  await expect(composer).toBeFocused();
  expect(sent).toEqual([]);

  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: info.outputPath("widget.png") });

  // A frame cannot make itself taller than the cap.
  await frame.locator("#grow").click();
  await expect.poll(async () => Math.round((await iframe.boundingBox())!.height)).toBe(1600);
});

test("a widget that cannot load says so and still shows its data; a bad block stays code", async ({ page }) => {
  await setup(page, `${block({ component: "flight-board", data: { flights: [{ no: "UA 857" }] } })}\n\n\`\`\`widget\n{"component": "Bad Name"}\n\`\`\``, { ticketFails: true });
  const card = page.locator(".widget-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("status")).toHaveText("这个组件暂时无法显示");
  await expect(card.locator("iframe")).toHaveCount(0);
  await card.getByText("查看数据").click();
  await expect(card.locator("pre")).toContainText('"UA 857"');
  // The invalid block is an ordinary code block in the same message.
  await expect(page.locator(".bubble pre").filter({ hasText: "Bad Name" })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

/** A widget written against the real runtime the server injects (window.aio), served with the server's CSP. */
const RUNTIME_WIDGET = `<!doctype html><html><head><meta charset="utf-8"><title>w</title>
<style>.panel{background:var(--aio-surface);color:var(--aio-text);border-radius:var(--aio-radius);padding:12px}</style></head><body>
<div class="panel"><div id="items"></div><div id="answer"></div><div id="fetched"></div><button id="ask">ask</button><button id="get">get</button><button id="send">send</button><button id="more">more</button></div>
<script>
  aio.onData((d) => { document.getElementById("items").textContent = d.items.join(" / "); });
  document.getElementById("ask").onclick = () => aio.ai.ask("hi", { json: true }).then((a) => { document.getElementById("answer").textContent = "AI:" + a.json.ok; }, (e) => { document.getElementById("answer").textContent = "ERR:" + e.code; });
  document.getElementById("get").onclick = () => aio.fetch("https://example.com/").then((r) => { document.getElementById("fetched").textContent = r.status + ":" + r.text; }, (e) => { document.getElementById("fetched").textContent = "ERR:" + e.code; });
  document.getElementById("send").onclick = () => aio.send("解释第一项");
  document.getElementById("more").onclick = () => { const p = document.createElement("div"); p.style.height = "300px"; p.id = "tall"; document.body.appendChild(p); };
</script></body></html>`;

test("the server's injected runtime drives the card: data, theme variables, AI, fetch, send and its own height", async ({ page }) => {
  const { injectRuntime } = await import("../../src/control/widgets.js");
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(`看板：\n\n${block({ component: "board", data: { items: ["甲", "乙"] } })}`)], nextBefore: null } }));
  await page.route((url) => url.pathname === "/api/workspace/ticket", (r) => r.fulfill({ json: { ticket: "t", origin: WORKSPACE, url: `${WORKSPACE}/widgets/board/`, expiresAt: Date.now() + 60_000 } }));
  await page.route(`${WORKSPACE}/**`, (r) => r.fulfill({
    contentType: "text/html; charset=utf-8",
    headers: { "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" },
    body: injectRuntime(RUNTIME_WIDGET, { items: ["example"] }),
  }));
  await page.route((url) => url.pathname === "/api/widgets/ai", (r) => r.fulfill({ json: { text: '{"ok":"yes"}', json: { ok: "yes" }, model: "m" } }));
  await page.route((url) => url.pathname === "/api/widgets/fetch", (r) => r.fulfill({ status: 403, json: { error: "BLOCKED", message: "Only public web addresses can be fetched" } }));
  await page.goto("/");
  // The app's boot cover sits over everything until it lifts; clicks inside the frame would land on it.
  await page.locator(".bubble").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  const card = page.locator(".widget-card");
  const frame = page.frameLocator(".widget-card iframe");
  await expect(frame.locator("#items")).toHaveText("甲 / 乙");
  const iframe = card.locator("iframe");
  // The frame takes the page's own height and the feed follows it to the bottom; click once both have settled.
  const settled = async () => {
    let last = "";
    let height = 0;
    await expect.poll(async () => {
      const box = (await iframe.boundingBox())!;
      const now = `${Math.round(box.y)}:${Math.round(box.height)}`;
      const same = now === last;
      last = now;
      height = box.height;
      return same;
    }, { intervals: [400] }).toBe(true);
    return height;
  };
  const before = await settled();
  // The console's colors reach the widget's CSS variables.
  const surface = await frame.locator(".panel").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(surface).not.toBe("rgba(0, 0, 0, 0)");
  await frame.locator("#ask").click();
  await expect(frame.locator("#answer")).toHaveText("AI:yes");
  await frame.locator("#get").click();
  await expect(frame.locator("#fetched")).toHaveText("ERR:BLOCKED");
  const composer = page.getByRole("textbox", { name: "消息" });
  await frame.locator("#send").click();
  await expect(composer).toHaveValue("解释第一项");
  await frame.locator("#more").click();
  expect(before).toBeLessThan(160); // shorter than where it started: the frame fits the content
  await expect.poll(async () => (await iframe.boundingBox())!.height).toBeGreaterThan(before + 250);
});
