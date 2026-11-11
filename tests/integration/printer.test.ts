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
  const seen: Array<{ op: number; attrs: Record<string, unknown[]>; collections: Record<string, unknown[]>; body: Buffer }> = [];
  let printer = { state: 3, reasons: ["none"] };
  // Photo paper in the main tray, plain Letter in the other; each listed with and without margins, as real printers do.
  const tray = (x: number, y: number, type: string, source: string) =>
    [300, 0].map((margin) => ({ "media-size": { "x-dimension": x, "y-dimension": y }, "media-top-margin": margin, "media-bottom-margin": margin, "media-left-margin": margin, "media-right-margin": margin, "media-type": type, "media-source": source }));
  // The envelope feeder offers no borderless printing.
  const envelope = { "media-size": { "x-dimension": 10477, "y-dimension": 24130 }, "media-top-margin": 300, "media-bottom-margin": 300, "media-left-margin": 300, "media-right-margin": 300, "media-type": "envelope", "media-source": "manual" };
  let trays: unknown[] = [...tray(10160, 15240, "photographic-high-gloss", "main"), ...tray(21590, 27940, "stationery", "alternate")];
  let dropPrintJob = false;
  let levels = [99, 40];
  // What the ink watch sent, and how many devices take a notification.
  const alerted: Array<{ userId: string; low: string; threshold: number }> = [];
  let devices = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const parsed = decodeResponse(body); // a request has the same layout; "status" is the operation
    seen.push({ op: parsed.status, attrs: parsed.attrs, collections: parsed.collections, body });
    if (parsed.status === 0x0002 && dropPrintJob) return req.socket.destroy();
    const answer =
      parsed.status === 0x000b
        ? encodeRequest(0, 1, "ipp://printer", [
            [TAG.enum, "printer-state", printer.state],
            [TAG.keyword, "printer-state-reasons", printer.reasons],
            [TAG.text, "printer-make-and-model", "EPSON WF-4830 Series"],
            [TAG.name, "marker-names", ["Black ink", "Cyan ink"]],
            [TAG.integer, "marker-levels", levels],
            [TAG.keyword, "media-ready", ["na_index-4x6_4x6in", "na_letter_8.5x11in"]],
            ...(trays.length ? [[TAG.begCollection, "media-col-ready", trays] as never] : []),
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
  const printerGateway = new PrinterGateway({ port: 0, log: h.ctx.log, printerUri, accounts: ["owner"], workspace: "/home/gem/workspace", usernameOf: (id) => USERS[id] ?? null, filesFor, db: h.ctx.db,
    alerts: { devices: () => devices, send: async (userId, low, threshold) => (alerted.push({ userId, low: low.map((ink) => `${ink.name} ${ink.level}`).join(","), threshold }), devices) } });
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
    expect(tools.map((t) => t.name)).toEqual(["printer_status", "print_file", "print_history", "ink_alert"]);
    expect((await call("print_history")).content[0]!.text).toBe("Ink now: Black 99%, Cyan 40%\nNo print jobs recorded yet.");

    const status = await call("printer_status");
    expect(status.isError).toBeUndefined();
    expect(status.content[0]!.text).toContain("Status: idle");
    expect(status.content[0]!.text).toContain("Ink: Black 99%, Cyan 40%");
    expect(status.content[0]!.text).toContain("Paper: 4x6 (photo paper, main tray, borderless available), Letter (plain paper, alternate tray, borderless available)");

    // A print: the account's own sandbox makes the pages, the printer gets them with the job's settings.
    const file = "/home/gem/workspace/tasks/t1/报告.pdf";
    seen.length = 0;
    const printed = await call("print_file", { path: file, pages: "1-2, 4", copies: 2, sides: "two-sided-long-edge", color: false });
    expect(printed.isError).toBeUndefined();
    expect(printed.content[0]!.text).toContain("3 pages × 2 copies");
    expect(printed.content[0]!.text).toContain("on Letter, normal quality.");
    expect(printed.content[0]!.text).toContain("Job 17");
    expect(asked).toEqual([{ userId: "owner_1", file, opts: { color: false, sides: "two-sided-long-edge", media: "na_letter_8.5x11in", width: 2550, height: 3300, pages: [1, 2, 4], borderless: false, dpi: 300 } }]);
    const job = seen.find((s) => s.op === 0x0002)!;
    expect(job.attrs).toMatchObject({
      "requesting-user-name": ["owner"],
      "job-name": ["报告.pdf"],
      "document-format": ["image/pwg-raster"],
      copies: [2],
      sides: ["two-sided-long-edge"],
      "print-color-mode": ["monochrome"],
      "print-quality": [4],
    });
    // No paper named: plain paper, though the photo paper is listed first; the job names its size, tray and type.
    expect(job.attrs.media).toBeUndefined();
    expect(job.collections["media-col"]).toEqual([{ "media-size": { "x-dimension": 21590, "y-dimension": 27940 }, "media-source": "alternate", "media-type": "stationery" }]);
    expect(job.body.subarray(job.body.length - RASTER.length).equals(RASTER)).toBe(true);

    // A named paper: pages are made at its size and the job asks for its tray.
    asked.length = 0;
    seen.length = 0;
    const photo = await call("print_file", { path: "/home/gem/workspace/a.jpg", paper: "4 × 6" });
    // Photo paper gets the printer's finest mode and pages drawn at 600 dpi, unless told otherwise.
    expect(photo.content[0]!.text).toContain("on 4x6, high quality.");
    expect(asked[0]!.opts).toMatchObject({ media: "na_index-4x6_4x6in", width: 2400, height: 3600, dpi: 600, borderless: false });
    expect(seen.find((s) => s.op === 0x0002)!.attrs["print-quality"]).toEqual([5]);
    expect(seen.find((s) => s.op === 0x0002)!.collections["media-col"]).toEqual([{ "media-size": { "x-dimension": 10160, "y-dimension": 15240 }, "media-source": "main", "media-type": "photographic-high-gloss" }]);

    // Borderless: the pages cover the sheet and the job asks for no margins; refused where the printer offers none.
    asked.length = 0;
    seen.length = 0;
    const edge = await call("print_file", { path: "/home/gem/workspace/a.jpg", paper: "4x6", borderless: true, quality: "normal" });
    expect(edge.content[0]!.text).toContain("on 4x6, borderless, normal quality.");
    expect(asked[0]!.opts).toMatchObject({ width: 1200, height: 1800, dpi: 300, borderless: true });
    expect(seen.find((s) => s.op === 0x0002)!.collections["media-col"]).toEqual([
      { "media-size": { "x-dimension": 10160, "y-dimension": 15240 }, "media-source": "main", "media-type": "photographic-high-gloss", "media-top-margin": 0, "media-bottom-margin": 0, "media-left-margin": 0, "media-right-margin": 0 },
    ]);
    const before = trays;
    trays = [envelope];
    asked.length = 0;
    seen.length = 0;
    const noEdge = await call("print_file", { path: "/home/gem/workspace/a.jpg", paper: "104.77x241.3mm", borderless: true });
    expect(noEdge.isError).toBe(true);
    expect(noEdge.content[0]!.text).toContain("does not offer borderless printing");
    expect(asked).toEqual([]);
    expect(seen.some((s) => s.op === 0x0002)).toBe(false);
    trays = before;

    // High quality on a large sheet asks for the finest mode but keeps the pages at 300 dpi.
    asked.length = 0;
    seen.length = 0;
    await call("print_file", { path: file, quality: "high" });
    expect(asked[0]!.opts).toMatchObject({ width: 2550, height: 3300, dpi: 300 });
    expect(seen.find((s) => s.op === 0x0002)!.attrs["print-quality"]).toEqual([5]);

    // A paper that is not loaded is refused with what is; so is a document when only photo paper is loaded.
    asked.length = 0;
    seen.length = 0;
    const missing = await call("print_file", { path: file, paper: "A4" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("A4 paper is not loaded; nothing was printed. Loaded now: 4x6 (photo paper, main tray, borderless available), Letter (plain paper, alternate tray, borderless available)");
    trays = tray(10160, 15240, "photographic-high-gloss", "main");
    const photoOnly = await call("print_file", { path: file });
    expect(photoOnly.isError).toBe(true);
    expect(photoOnly.content[0]!.text).toContain("No plain paper is loaded");
    expect(asked).toEqual([]);
    expect(seen.some((s) => s.op === 0x0002)).toBe(false);

    // A printer that only lists media names: the size by name, no tray.
    trays = [];
    expect((await call("printer_status")).content[0]!.text).toContain("Paper: 4x6, Letter");
    await call("print_file", { path: file, paper: "letter" });
    expect(seen.find((s) => s.op === 0x0002)!.attrs.media).toEqual(["na_letter_8.5x11in"]);

    // Refused before anything is rendered or sent.
    asked.length = 0;
    seen.length = 0;
    for (const [args, message] of [
      [{ path: "/home/gem/workspace/a.docx" }, "to PDF"],
      [{ path: "/etc/passwd.pdf" }, "path:"],
      [{ path: "/home/gem/workspace/a.png", pages: "2" }, "pages applies only to PDFs"],
      [{ path: file, copies: 50 }, "copies"],
      [{ path: file, quality: "best" }, "quality must be normal / high"],
      [{ path: file, pages: "3-1" }, "pages is not written correctly"],
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
    expect(stopped.content[0]!.text).toContain("out of paper");
    expect(seen.some((s) => s.op === 0x0002)).toBe(false);

    // A connection lost while sending: the outcome is unknown and nothing is resent.
    printer = { state: 3, reasons: ["none"] };
    dropPrintJob = true;
    seen.length = 0;
    const unknown = await call("print_file", { path: file });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("not sure whether the printer received it");
    expect(seen.filter((s) => s.op === 0x0002)).toHaveLength(1);

    // The history: every job that reached the printer, newest first, with the ink it started from; refusals before sending are not jobs.
    h.ctx.db.prepare("INSERT INTO print_jobs (created_at, owner_id, file, pages, copies, settings, outcome, job_id, ink) VALUES (?,?,?,?,?,?,?,?,?)").run(Date.now(), "user_cr", "secret.pdf", 1, 1, "one-sided, color, on Letter, normal quality", "sent", 18, "Black 90%");
    const history = (await call("print_history")).content[0]!.text.split("\n");
    expect(history[0]).toBe("Ink now: Black 99%, Cyan 40%");
    expect(history[1]).toBe("Jobs, newest first (7 of 7):");
    expect(history[2]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d: \(another account's job\), 1 pages × 1 copies, .*; sent, job 18; ink then: Black 90%$/);
    expect(history[3]).toContain("报告.pdf, 3 pages × 1 copies, one-sided, color, on 4x6, normal quality; outcome unknown; ink then: Black 99%, Cyan 40%");
    expect(history.at(-1)).toContain("报告.pdf, 3 pages × 2 copies, two-sided, black and white, on Letter, normal quality; sent, job 17; ink then: Black 99%, Cyan 40%");
    expect(history.join("\n")).not.toContain("secret.pdf");
    expect((await call("print_history", { limit: 2 })).content[0]!.text.split("\n")).toHaveLength(4);
    expect((await call("print_history", { limit: 0 })).isError).toBe(true);

    // Low ink is watched by the server itself: an alert is a setting, and reading the printer is the check.
    expect((await call("printer_status")).content[0]!.text).toContain("Ink alert: off");
    expect((await call("ink_alert")).content[0]!.text).toBe("Ink alert: off\nInk now: Black 99%, Cyan 40%");
    expect((await call("ink_alert", { threshold: 100 })).isError).toBe(true);
    const set = (await call("ink_alert", { threshold: 20 })).content[0]!.text;
    expect(set).toContain("Ink alert: the user is notified once a color is at or below 20%");
    expect(set).toContain("no schedule is needed");
    expect(set).toContain("None of the user's devices has notifications turned on");
    await printerGateway.checkInk();
    expect(alerted).toEqual([]);
    // Cyan reaches the line with nobody to tell: it stays due until a device has notifications on.
    levels = [99, 20];
    await printerGateway.checkInk();
    expect(alerted).toEqual([{ userId: "owner_1", low: "Cyan 20", threshold: 20 }]);
    devices = 1;
    await printerGateway.checkInk();
    await printerGateway.checkInk();
    expect(alerted).toHaveLength(2);
    expect((await call("printer_status")).content[0]!.text).toMatch(/Ink alert: .* at or below 20%; already notified about Cyan on \d{4}-/);
    // Another color follows: one more notification, naming everything that is low; any read of the printer checks.
    levels = [15, 12];
    await call("print_history");
    await printerGateway.checkInk();
    expect(alerted.slice(2)).toEqual([{ userId: "owner_1", low: "Black 15,Cyan 12", threshold: 20 }]);
    // A new cyan cartridge re-arms that color only.
    levels = [15, 100];
    await printerGateway.checkInk();
    levels = [14, 19];
    await printerGateway.checkInk();
    expect(alerted.slice(3)).toEqual([{ userId: "owner_1", low: "Black 14,Cyan 19", threshold: 20 }]);
    // Turned off: nothing more is sent, and the printer is not even read.
    expect((await call("ink_alert", { threshold: 0 })).content[0]!.text).toContain("Ink alert: off");
    levels = [1, 1];
    const reads = seen.length;
    await printerGateway.checkInk();
    expect(seen).toHaveLength(reads);
    expect(alerted).toHaveLength(4);
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

/** The first pixel of a gray PWG raster's first page: after the header, a line repeat count, then a run and its pixel. */
const PWG_FIRST_PIXEL = "import sys; d=open(sys.argv[1],'rb').read(); i=4+1796+1; n=d[i]; print(d[i+1])";

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

    // With margins the picture leaves the edge of the sheet white; borderless, it covers the sheet.
    const corner = (file: string) => {
      const page = spawnSync("python3", ["-c", PWG_FIRST_PIXEL, file]);
      return Number(page.stdout.toString().trim());
    };
    expect(corner(out)).toBe(255);
    const edge = path.join(dir, "edge.pwg");
    const borderless = spawnSync("python3", ["-", png, edge, "sgray", "one-sided", "2400", "3600", "na_index-4x6_4x6in", "", "borderless", "600"], { input: script });
    expect(JSON.parse(borderless.stdout.toString().trim())).toEqual({ ok: true, pages: 1 });
    const fine = fs.readFileSync(edge);
    expect([fine.readUInt32BE(4 + 276), fine.readUInt32BE(4 + 352), fine.readUInt32BE(4 + 372)]).toEqual([600, 288, 2400]); // dpi, width in points and in pixels
    expect(corner(edge)).toBeLessThan(255);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
