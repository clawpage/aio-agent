/**
 * Stands in for chrome-devtools-mcp in tests/unit/user-browser.test.ts: an MCP
 * server over stdio that sees the fake Chrome's pages through --browserUrl, as
 * the real one does once a tool is called (and never before).
 */
import readline from "node:readline";

const browserUrl = process.argv[process.argv.indexOf("--browserUrl") + 1];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const ids = new Map();
let selected = null;
const pages = async () => {
  const targets = await (await fetch(`${browserUrl}/json/list`)).json();
  for (const t of targets) if (!ids.has(t.targetId)) ids.set(t.targetId, ids.size + 1);
  return targets.map((t) => ({ ...t, pageId: ids.get(t.targetId) }));
};
const text = (s, extra = {}) => ({ content: [{ type: "text", text: s }], ...extra });

async function tool(name, args) {
  let list;
  try {
    list = await pages();
  } catch {
    return text("Could not connect to Chrome", { isError: true });
  }
  const page = list.find((p) => p.pageId === args.pageId);
  switch (name) {
    case "list_pages":
      return text(`## Pages\n${list.map((p) => `${p.pageId}: (${p.url})${p.pageId === selected ? " [selected]" : ""}`).join("\n")}`);
    case "navigate_page":
      await fetch(`${browserUrl}/navigate?target=${page.targetId}&url=${encodeURIComponent(args.url)}`);
      return text(`Successfully navigated to ${args.url}.\n## Pages\n${page.pageId}: (${args.url})`);
    case "select_page":
      selected = args.pageId;
      return text(`selected ${args.pageId} bringToFront=${args.bringToFront}`);
    case "evaluate_script": {
      const mark = /__aioPage = "([^"]+)"/.exec(args.function)?.[1];
      if (mark) await fetch(`${browserUrl}/mark?target=${page.targetId}&mark=${mark}`);
      return text("Script ran on page and returned: true");
    }
    case "take_screenshot":
      return { content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from("shot").toString("base64") }] };
    default:
      return text(`called ${name}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "chrome_devtools", version: "x" } } });
  if (m.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: m.id, result: { tools: [
      { name: "list_pages", inputSchema: { type: "object", properties: {} } },
      { name: "new_page", inputSchema: { type: "object", properties: { url: {}, background: {}, isolatedContext: {}, timeout: {} }, required: ["url"] } },
      { name: "upload_file", inputSchema: { type: "object", properties: {} } },
    ] } });
  }
  send({ jsonrpc: "2.0", id: m.id, result: await tool(m.params.name, m.params.arguments ?? {}) });
});
