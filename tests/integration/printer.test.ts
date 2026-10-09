import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { PRINTER_POLICY, PrinterGateway, parsePages, printerMcpServers, printerThreadServers, type PrintFiles } from "../../src/control/printer/gateway.js";
import { TAG, decodeResponse, encodeRequest } from "../../src/control/printer/ipp.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";
import { memberConfig } from "../../src/control/tenants.js";

const USERS: Record<string, string> = { owner_1: "owner", user_cr: "cr" };

it("offers the home printer to the listed accounts only, rasterizing in the account's sandbox and printing over IPP", async () => {
  const h = await startHarness();
  // A stand-in IPP printer: answers Get-Printer-Attributes from `printer`, records every request.
  const seen: Array<{ op: number; attrs: Record<string, unknown[]>; body: Buffer }> = [];
  let printer = { state: 3, reasons: ["none"] };
  let dropPrintJob = false;
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const parsed = decodeResponse(body); // a request has the same layout; "status" is the operation
    seen.push({ op: parsed.status, attrs: parsed.attrs, body });
    if (parsed.status === 0x0002 && dropPrintJob) return req.socket.destroy();
    const answer =
      parsed.status === 0x000b
        ? encodeRequest(0, 1, "ipp://printer", [
            [TAG.enum, "printer-state", printer.state],
            [TAG.keyword, "printer-state-reasons", printer.reasons],
            [TAG.text, "printer-make-and-model", "EPSON WF-4830 Series"],
            [TAG.name, "marker-names", ["Black ink", "Cyan ink"]],
            [TAG.integer, "marker-levels", [99, 40]],
            [TAG.keyword, "media-ready", ["na_letter_8.5x11in", "na_letter_8.5x11in"]],
          ])
        : encodeRequest(0, 1, "ipp://printer", [[TAG.integer, "job-id", 17], [TAG.enum, "job-state", 5]]);
    res.writeHead(200, { "content-type": "application/ipp" }).end(answer);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const printerUri = `ipp://127.0.0.1:${(upstream.address() as { port: number }).port}/ipp/print`;
  const RASTER = Buffer.from("RaS2-fake-pages");
  const asked: Array<{ userId: string; file: string; opts: unknown }> = [];
  const filesFor = async (userId: string): Promise<PrintFiles> => ({
    rasterize: async (file, opts) => {
      asked.push({ userId, file, opts });
      return { bytes: RASTER, pages: opts.pages.length || 3 };
    },
  });
  const printerGateway = new PrinterGateway({ port: 0, log: h.ctx.log, printerUri, accounts: ["owner"], workspace: "/home/gem/workspace", usernameOf: (id) => USERS[id] ?? null, filesFor });
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, printerGateway);
  await gateway.start();
  try {
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    printerGateway.provision(owner);
    // A member never inherits the owner's printer, and an unlisted one gets none.
    expect(memberConfig(owner, "user_cr", 18092).printer).toBeUndefined();
    const other = memberConfig(owner, "user_cr", 18092);
    gateway.provision(other);
    expect(other.printer).toBeUndefined();
    expect(printerThreadServers(other)).toEqual({});
    expect(codexRequirementsToml(other)).not.toContain("aio_printer");

    expect(owner.printer!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/printer\/[a-f0-9]{64}\/mcp$/);
    expect(printerThreadServers(owner)).toEqual({ aio_printer: { url: owner.printer!.url, tool_timeout_sec: 330 } });
    expect(printerMcpServers(owner)).toEqual({ aio_printer: { type: "http", url: owner.printer!.url } });
    expect(codexRequirementsToml(owner)).toContain(`[mcp_servers.aio_printer.identity]\nurl = "${owner.printer!.url}"\n`);

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = (url: string, body: unknown) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await (await rpc(owner.printer!.url, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } })).json()).result as { content: Array<{ text: string }>; isError?: boolean };
    expect((await rpc(owner.printer!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(owner.printer!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "aio_printer" }, instructions: PRINTER_POLICY });
    const tools = (await (await rpc(owner.printer!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["printer_status", "print_file"]);

    const status = await call("printer_status");
    expect(status.isError).toBeUndefined();
    expect(status.content[0]!.text).toContain("状态：空闲");
    expect(status.content[0]!.text).toContain("墨水：Black 99%，Cyan 40%");
    expect(status.content[0]!.text).toContain("纸张：Letter");

    // A print: the account's own sandbox makes the pages, the printer gets them with the job's settings.
    const file = "/home/gem/workspace/tasks/t1/报告.pdf";
    seen.length = 0;
    const printed = await call("print_file", { path: file, pages: "1-2, 4", copies: 2, sides: "two-sided-long-edge", color: false });
    expect(printed.isError).toBeUndefined();
    expect(printed.content[0]!.text).toContain("3 页 × 2 份");
    expect(printed.content[0]!.text).toContain("作业号 17");
    expect(asked).toEqual([{ userId: "owner_1", file, opts: { color: false, sides: "two-sided-long-edge", media: "na_letter_8.5x11in", width: 2550, height: 3300, pages: [1, 2, 4] } }]);
    const job = seen.find((s) => s.op === 0x0002)!;
    expect(job.attrs).toMatchObject({
      "requesting-user-name": ["owner"],
      "job-name": ["报告.pdf"],
      "document-format": ["image/pwg-raster"],
      copies: [2],
      sides: ["two-sided-long-edge"],
      "print-color-mode": ["monochrome"],
      media: ["na_letter_8.5x11in"],
    });
    expect(job.body.subarray(job.body.length - RASTER.length).equals(RASTER)).toBe(true);

    // Refused before anything is rendered or sent.
    asked.length = 0;
    seen.length = 0;
    for (const [args, message] of [
      [{ path: "/home/gem/workspace/a.docx" }, "转成 PDF"],
      [{ path: "/etc/passwd.pdf" }, "path："],
      [{ path: "/home/gem/workspace/a.png", pages: "2" }, "pages 只用于 PDF"],
      [{ path: file, copies: 50 }, "copies"],
      [{ path: file, pages: "3-1" }, "pages 写法不对"],
    ] as const) {
      const refused = await call("print_file", args);
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain(message);
    }
    expect(asked).toEqual([]);
    expect(seen).toEqual([]);

    // A stopped printer is reported, not printed to.
    printer = { state: 5, reasons: ["media-empty-error"] };
    const stopped = await call("print_file", { path: file });
    expect(stopped.isError).toBe(true);
    expect(stopped.content[0]!.text).toContain("缺纸");
    expect(seen.some((s) => s.op === 0x0002)).toBe(false);

    // A connection lost while sending: the outcome is unknown and nothing is resent.
    printer = { state: 3, reasons: ["none"] };
    dropPrintJob = true;
    seen.length = 0;
    const unknown = await call("print_file", { path: file });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("不确定打印机是否已收到");
    expect(seen.filter((s) => s.op === 0x0002)).toHaveLength(1);
  } finally {
    gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    await h.shutdown();
  }
});

it("reads page lists the way people write them", () => {
  expect(parsePages("")).toEqual([]);
  expect(parsePages(undefined)).toEqual([]);
  expect(parsePages("3，1-2")).toEqual([1, 2, 3]);
  expect(() => parsePages("0")).toThrow();
  expect(() => parsePages("1-100")).toThrow("50");
});

const python = spawnSync("python3", ["-c", "import numpy, PIL"]).status === 0;

it.skipIf(!python)("turns a picture into a PWG raster page the printer understands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwg-"));
  try {
    const png = path.join(dir, "a.png");
    // 2x1 RGB PNG.
    fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd0000000f49444154789c63f8cfc0c0b0200000079101f0e7755c1d0000000049454e44ae426082", "hex"));
    const out = path.join(dir, "a.pwg");
    const script = fs.readFileSync(path.join(import.meta.dirname, "../../src/control/printer/scripts/pwg-raster.py"));
    const run = spawnSync("python3", ["-", png, out, "sgray", "two-sided-short-edge", "2550", "3300", "na_letter_8.5x11in", ""], { input: script });
    expect(JSON.parse(run.stdout.toString().trim())).toEqual({ ok: true, pages: 1 });
    const pwg = fs.readFileSync(out);
    expect(pwg.subarray(0, 4).toString()).toBe("RaS2");
    const header = pwg.subarray(4, 4 + 1796);
    expect(header.subarray(0, 9).toString()).toBe("PwgRaster");
    expect([header.readUInt32BE(272), header.readUInt32BE(368)]).toEqual([1, 1]); // duplex, tumble
    expect([header.readUInt32BE(372), header.readUInt32BE(376), header.readUInt32BE(388), header.readUInt32BE(400)]).toEqual([2550, 3300, 8, 18]);
    expect(header.subarray(1732, 1750).toString()).toBe("na_letter_8.5x11in");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
