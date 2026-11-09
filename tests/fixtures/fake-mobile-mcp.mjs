/**
 * Stands in for mobile-mcp in tests/integration/mac-env.test.ts: its Streamable
 * HTTP server (`--listen host:port`, MOBILEMCP_AUTH as the bearer), with sessions,
 * answering every tool call with its name (a PNG for a screenshot) and appending
 * each call to FAKE_MOBILE_LOG for the test to read.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const [host, port] = process.argv[process.argv.indexOf("--listen") + 1].split(":");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("phone-pixels")]);
const sessions = new Set();

http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.MOBILEMCP_AUTH}`) { res.writeHead(401); return res.end(); }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (msg.method === "initialize") {
      const id = crypto.randomUUID();
      sessions.add(id);
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": id });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mobile-mcp", version: "x" } } })}\n\n`);
    }
    if (!sessions.has(req.headers["mcp-session-id"])) { res.writeHead(404); return res.end(); }
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    fs.appendFileSync(process.env.FAKE_MOBILE_LOG, JSON.stringify([msg.params.name, msg.params.arguments]) + "\n");
    const content = msg.params.name === "mobile_take_screenshot" ? [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] : [{ type: "text", text: `done ${msg.params.name}` }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content } })}\n\n`);
  });
}).listen(Number(port), host);
