import { it, expect, describe } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { startHarness, login } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { HaGateway } from "../../src/control/ha.js";
import { HaCameras, eventsOf, formatLocal, parseLocal, piecesOf, rebaseFragments, syncPointsOf, videoTrackOf } from "../../src/control/camera.js";
import { parseCameras } from "../../src/control/config.js";
import { memberConfig } from "../../src/control/tenants.js";

const TOKEN = "host-ha-secret";
const HLS = "abcdef0123456789abcdef0123456789";
const name = (prefix: string, ms: number, suffix = "") => `${prefix}${formatLocal(ms).replace(" ", "_").replace(/:/g, "-")}${suffix}.mp4`;

/** A stand-in Home Assistant: REST, the WebSocket API and media, with one Tapo-like camera and one snapshot-only camera. */
async function fakeHa() {
  const minute = 60_000;
  const t0 = Math.floor((Date.now() - 30 * minute) / 1000) * 1000;
  const pieces = [0, 10, 20].map((m) => name("c201_", t0 + m * minute));
  const events = [name("", t0 + 12 * minute, "_人形"), name("", t0 + 25 * minute, "_移动"), name("", t0 - 26 * 60 * minute, "_人形")];
  const seen: { rest: Array<{ method: string; url: string; auth?: string; body: string; range?: string }>; ws: unknown[] } = { rest: [], ws: [] };
  const states = [
    { entity_id: "camera.c201", state: "idle", attributes: { friendly_name: "客厅 C201" } },
    { entity_id: "camera.ring", state: "idle", attributes: { friendly_name: "Front" } },
    { entity_id: "light.kitchen", state: "on", attributes: {} },
  ];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = req.url ?? "";
    seen.rest.push({ method: req.method ?? "", url, auth: req.headers.authorization, body, range: req.headers.range });
    if (url.startsWith("/api/hls/")) {
      if (!url.startsWith(`/api/hls/${HLS}/`)) return res.writeHead(404).end();
      return res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end("#EXTM3U\nplaylist.m3u8\n");
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    if (url === "/api/states") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(states));
    const state = /^\/api\/states\/(.+)$/.exec(url);
    if (state) {
      const s = states.find((x) => x.entity_id === state[1]);
      return s ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(s)) : res.writeHead(404).end();
    }
    if (url.startsWith("/api/camera_proxy/camera.c201")) return res.writeHead(200, { "content-type": "image/jpeg" }).end("JPEGDATA");
    if (url === "/api/services/tapo_ptz/move" && req.method === "POST") return res.writeHead(200, { "content-type": "application/json" }).end("[]");
    if (url.startsWith("/media/c201/")) {
      // The first piece carries an index (like cam-record's), the others are plain bytes.
      const whole = url.endsWith(pieces[0]!) ? indexedPiece().file : Buffer.from("0123456789");
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (!m) return res.writeHead(200, { "content-type": "video/mp4", "content-length": String(whole.length) }).end(whole);
      const from = m[1] ? Number(m[1]) : Math.max(0, whole.length - Number(m[2]));
      const to = m[1] && m[2] ? Math.min(Number(m[2]), whole.length - 1) : whole.length - 1;
      return res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${whole.length}` }).end(whole.subarray(from, to + 1));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: "/api/websocket" });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "auth_required" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "auth") return ws.send(JSON.stringify({ type: m.access_token === TOKEN ? "auth_ok" : "auth_invalid" }));
      seen.ws.push(m);
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result }));
      if (m.type === "camera/capabilities") return reply({ frontend_stream_types: m.entity_id === "camera.c201" ? ["hls", "web_rtc"] : ["web_rtc"] });
      if (m.type === "camera/stream") return reply({ url: `/api/hls/${HLS}/master_playlist.m3u8` });
      if (m.type === "media_source/browse_media") {
        const files = m.media_content_id.endsWith("/c201") ? pieces : m.media_content_id.endsWith("/local/c201-events") ? events : [];
        return reply({ children: files.map((f) => ({ title: f, media_content_id: `${m.media_content_id}/${f}`, can_play: true })) });
      }
      ws.send(JSON.stringify({ id: m.id, type: "result", success: false, error: { code: "unknown", message: "unknown command" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base, t0, pieces, events, seen,
    close: () => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(); },
  };
}

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const u32 = (...values: number[]) => Buffer.concat(values.map((v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }));
const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };
const trak = (id: number, handler: string, timescale: number) =>
  box("trak", box("tkhd", u32(0, 0, 0, id)), box("mdia", box("mdhd", u32(0, 0, 0, timescale)), box("hdlr", u32(0, 0), Buffer.from(handler))));
/**
 * A fragmented MP4 laid out like cam-record's pieces: ftyp + moov (audio track
 * first), one moof+mdat per 2 seconds whose tfhd holds an absolute base offset,
 * then mfra (tfra per track) and mfro.
 */
function indexedPiece(): { file: Buffer; initEnd: number; moofs: number[] } {
  const init = Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", trak(2, "soun", 48000), trak(1, "vide", 90000))]);
  const moofs: number[] = [];
  const fragments: Buffer[] = [];
  let at = init.length;
  for (let i = 0; i < 4; i += 1) {
    moofs.push(at);
    const moofSize = 8 + 8 + 8 + 16; // moof > traf > tfhd(flags, track, base offset)
    const fragment = Buffer.concat([box("moof", box("traf", box("tfhd", u32(1, 1), u64(at + moofSize)))), box("mdat", Buffer.from(`frame${i}`))]);
    fragments.push(fragment);
    at += fragment.length;
  }
  const entries = (scale: number) => Buffer.concat(moofs.flatMap((offset, i) => [u64(i * 2 * scale), u64(offset), Buffer.from([1, 1, 1])]));
  const tfra = (id: number, scale: number) => box("tfra", u32(0x01000000, id, 0, moofs.length), entries(scale));
  const mfra = box("mfra", tfra(2, 48000), tfra(1, 90000), box("mfro", u32(0, 0)));
  mfra.writeUInt32BE(mfra.length, mfra.length - 4);
  return { file: Buffer.concat([init, ...fragments, mfra]), initEnd: init.length, moofs };
}

const CAMERAS = { "camera.c201": { recordings: "c201", events: "local/c201-events", ptz: "tapo_ptz" } };

function fakeFfmpeg(dir: string): { bin: string; args: () => string; stdin: () => Buffer } {
  const bin = path.join(dir, "ffmpeg");
  const out = path.join(dir, "ffmpeg-args");
  const input = path.join(dir, "ffmpeg-stdin");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\nif [ "$7" = "pipe:0" ]; then cat > '${input}'; fi\nprintf FRAME\n`, { mode: 0o755 });
  return { bin, args: () => fs.readFileSync(out, "utf8"), stdin: () => fs.readFileSync(input) };
}

describe("camera helpers", () => {
  it("keeps only well-formed PA_HA_CAMERAS entries", () => {
    expect(parseCameras(JSON.stringify({
      "camera.c201_go2rtc": { recordings: "c201", events: "local/c201-events", ptz: "tapo_ptz" },
      "camera.bad": { recordings: "../secrets", ptz: "Tapo PTZ" },
      "light.kitchen": { recordings: "x" },
    }))).toEqual({
      "camera.c201_go2rtc": { recordings: "c201", events: "local/c201-events", ptz: "tapo_ptz" },
      "camera.bad": { recordings: undefined, events: undefined, ptz: undefined },
    });
    expect(parseCameras("not json")).toEqual({});
  });

  it("finds the video track, its key frames and moves cut-out fragments", () => {
    const { file, initEnd, moofs } = indexedPiece();
    expect(videoTrackOf(file)).toEqual({ trackId: 1, timescale: 90000, initEnd });
    const mfra = file.subarray(file.lastIndexOf(Buffer.from("mfra")) - 4);
    expect(syncPointsOf(mfra, 1)).toEqual(moofs.map((offset, i) => ({ time: i * 180000, offset })));
    expect(syncPointsOf(mfra, 2)[1]).toEqual({ time: 96000, offset: moofs[1] });
    expect(syncPointsOf(mfra, 3)).toEqual([]);
    const cut = file.subarray(moofs[2]!, moofs[3]!);
    const moved = rebaseFragments(cut, moofs[2]! - initEnd);
    expect(moved.readBigUInt64BE(8 + 8 + 8 + 8)).toBe(BigInt(initEnd + 40));
    expect(cut.readBigUInt64BE(8 + 8 + 8 + 8)).toBe(BigInt(moofs[2]! + 40));
  });

  it("reads recording pieces and events from file names, in local time", () => {
    const at = parseLocal("2026-10-13 21:09:17")!;
    expect(formatLocal(at)).toBe("2026-10-13 21:09:17");
    expect(parseLocal("2026-10-13T21:09")).toBe(parseLocal("2026-10-13 21:09:00"));
    expect(parseLocal("yesterday")).toBeNull();
    const now = at + 25 * 60_000;
    const pieces = piecesOf(["c201_2026-10-13_21-29-17.mp4", "c201_2026-10-13_21-09-17.mp4", "c201_2026-10-13_21-19-17.mp4", "other.mp4"], now);
    expect(pieces.map((p) => [p.file, (p.end - p.start) / 1000])).toEqual([
      ["c201_2026-10-13_21-09-17.mp4", 600],
      ["c201_2026-10-13_21-19-17.mp4", 600],
      // The piece still being written ends now.
      ["c201_2026-10-13_21-29-17.mp4", 300],
    ]);
    // A gap in the recording: the piece before it keeps its usual length.
    const gapped = piecesOf(["c201_2026-10-13_10-00-00.mp4", "c201_2026-10-13_10-10-00.mp4", "c201_2026-10-13_12-00-00.mp4"], now);
    expect((gapped[1]!.end - gapped[1]!.start) / 1000).toBe(600);
    expect(eventsOf(["2026-10-13_20-38-19_人形.mp4", "junk.mp4"])).toEqual([{ file: "2026-10-13_20-38-19_人形.mp4", at: parseLocal("2026-10-13 20:38:19"), label: "人形" }]);
  });
});

it("adds the camera tools to aio_ha: pictures, pan/tilt, recordings and frames, with HA's token on the host", async () => {
  const ha = await fakeHa();
  const h = await startHarness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-camera-"));
  const ffmpeg = fakeFfmpeg(dir);
  const upstreamCalls: unknown[] = [];
  const mcp = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    upstreamCalls.push(body);
    const result = body.method === "tools/list" ? { tools: [{ name: "HassTurnOn" }] } : { content: [{ type: "text", text: "done" }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  const keyFile = path.join(dir, "ha-mcp.env");
  fs.writeFileSync(keyFile, `HA_MCP_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const saved = process.env.HA_MCP_TOKEN;
  delete process.env.HA_MCP_TOKEN;
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, haMcp: { upstreamUrl: `http://127.0.0.1:${(mcp.address() as { port: number }).port}/api/mcp`, secretsFile: keyFile, accounts: ["cr"], cameras: CAMERAS } };
  const cameras = new HaCameras({ baseUrl: ha.base, token: () => TOKEN, cameras: CAMERAS, log: h.ctx.log, ffmpeg: ffmpeg.bin });
  const gatewayHa = new HaGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => (id === "user_cr" ? "cr" : null), cameras });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gatewayHa);
  await gateway.start();
  try {
    const member = memberConfig(cfg, "user_cr", 18093);
    gateway.provision(member);
    const url = member.ha!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    let id = 0;
    const rpc = async (method: string, params?: unknown) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json()) as any;
    const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result as { content: any[]; isError?: boolean };

    const tools = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(["HassTurnOn", "camera_list", "camera_snapshot", "camera_ptz", "camera_recordings", "camera_recording_frames"]);
    // HA's own tools still go to HA.
    expect((await call("HassTurnOn", { name: "kitchen" })).content[0].text).toBe("done");
    expect(upstreamCalls.map((c: any) => c.method)).toEqual(["tools/list", "tools/call"]);

    const list = (await call("camera_list", {})).content[0].text as string;
    expect(list).toContain(`camera.c201 "客厅 C201" (idle): live video; pan/tilt; continuous recording ${formatLocal(ha.t0)}`);
    expect(list).toContain(`camera.ring "Front" (idle): snapshots only`);
    expect(list).toContain("```camera");

    const shot = await call("camera_snapshot", { camera: "camera.c201" });
    expect(shot.content[1]).toEqual({ type: "image", data: Buffer.from("JPEGDATA").toString("base64"), mimeType: "image/jpeg" });
    expect(ha.seen.rest.every((r) => r.url.startsWith("/api/hls/") || r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect((await call("camera_snapshot", { camera: "camera.nope" })).isError).toBe(true);
    expect((await call("camera_snapshot", { camera: "light.kitchen" })).isError).toBe(true);

    const turned = await call("camera_ptz", { camera: "camera.c201", direction: "left", steps: 2 });
    expect(turned.content[0].text).toContain("客厅 C201 turned left ×2");
    expect(turned.content[1].type).toBe("image");
    expect(ha.seen.rest.find((r) => r.url === "/api/services/tapo_ptz/move")?.body).toBe(JSON.stringify({ x: -20, y: 0 }));
    const ring = await call("camera_ptz", { camera: "camera.ring", direction: "up" });
    expect(ring).toMatchObject({ isError: true, content: [{ text: "camera.ring cannot pan or tilt" }] });
    expect((await call("camera_ptz", { camera: "camera.c201", direction: "sideways" })).isError).toBe(true);

    const recorded = (await call("camera_recordings", { camera: "camera.c201" })).content[0].text as string;
    expect(recorded).toContain("Events: 2 (人形 1, 移动 1)");
    expect(recorded).toContain(`- ${formatLocal(ha.t0 + 12 * 60_000)} 人形`);
    expect((await call("camera_recordings", { camera: "camera.c201", label: "移动" })).content[0].text).toContain("Events: 1 (移动 1)");

    const at = ha.t0 + 12 * 60_000 + 5_000;
    const frames = await call("camera_recording_frames", { camera: "camera.c201", at: formatLocal(at) });
    expect(frames.content[0].text).toBe(`客厅 C201 at ${formatLocal(at)}:`);
    expect(frames.content[1]).toEqual({ type: "image", data: Buffer.from("FRAME").toString("base64"), mimeType: "image/jpeg" });
    // Seeks inside the second piece through its index, reading the piece over HTTP with the token.
    const args = ffmpeg.args().split("\n");
    expect(args).toContain("-use_mfra_for");
    expect(args[args.indexOf("-ss") + 1]).toBe("125.00");
    expect(args[args.indexOf("-i") + 1]).toBe(`${ha.base}/media/c201/${ha.pieces[1]}`);
    expect(args[args.indexOf("-headers") + 1]).toBe(`Authorization: Bearer ${TOKEN}\r`);
    // An indexed piece: only the init segment and the fragments from the key frame before the moment go to ffmpeg.
    const early = await call("camera_recording_frames", { camera: "camera.c201", at: formatLocal(ha.t0 + 3_000) });
    expect(early.content[1].type).toBe("image");
    const piped = ffmpeg.args().split("\n");
    expect(piped.slice(piped.indexOf("-i"), piped.indexOf("-i") + 4)).toEqual(["-i", "pipe:0", "-ss", "1.00"]);
    const { file, initEnd, moofs } = indexedPiece();
    const sent = ffmpeg.stdin();
    expect(sent.subarray(0, initEnd)).toEqual(file.subarray(0, initEnd));
    expect(sent.length).toBe(initEnd + moofs[3]! - moofs[1]!);
    expect(sent.readBigUInt64BE(initEnd + 32)).toBe(BigInt(initEnd + 40));
    const before = await call("camera_recording_frames", { camera: "camera.c201", at: formatLocal(ha.t0 - 3600_000) });
    expect(before.isError).toBe(true);
    expect(before.content[0].text).toContain("Nothing was recorded at");
  } finally {
    if (saved !== undefined) process.env.HA_MCP_TOKEN = saved;
    gateway.close();
    mcp.closeAllConnections();
    mcp.close();
    ha.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await h.shutdown();
  }
});

it("serves camera cards only to accounts granted Home Assistant: info, snapshot, live HLS, playback and pan/tilt", async () => {
  const ha = await fakeHa();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-camera-api-"));
  const keyFile = path.join(dir, "ha-mcp.env");
  fs.writeFileSync(keyFile, `HA_MCP_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const saved = process.env.HA_MCP_TOKEN;
  delete process.env.HA_MCP_TOKEN;
  const env = { PA_HA_MCP_URL: `${ha.base}/api/mcp`, PA_HA_MCP_SECRETS_FILE: keyFile, PA_HA_CAMERAS: JSON.stringify(CAMERAS) };
  const h = await startHarness({ ...env, PA_HA_MCP_ACCOUNTS: "owner" });
  const denied = await startHarness({ ...env, PA_HA_MCP_ACCOUNTS: "betaw" });
  try {
    const { cookie, csrf } = await login(h);
    const get = (p: string, headers: Record<string, string> = {}) => h.request(p, { headers: { cookie, ...headers } });

    const info = await get("/api/cameras/camera.c201");
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ camera: { entity: "camera.c201", name: "客厅 C201", live: true, ptz: true, recordings: true }, timeZone: expect.any(String) });
    expect((await get("/api/cameras/camera.c201")).status).toBe(200);
    expect((await h.request("/api/cameras/camera.c201")).status).toBe(401);
    expect((await get("/api/cameras/..%2Fsecret")).status).toBe(400);

    const snap = await get("/api/cameras/camera.c201/snapshot");
    expect([snap.status, snap.headers.get("content-type"), await snap.text()]).toEqual([200, "image/jpeg", "JPEGDATA"]);

    const live = (await (await get("/api/cameras/camera.c201/live")).json()) as { url: string };
    expect(live.url).toBe(`/api/cameras/hls/${HLS}/master_playlist.m3u8`);
    const playlist = await get(`${live.url}?_HLS_msn=3&evil=1`);
    expect([playlist.status, await playlist.text()]).toEqual([200, "#EXTM3U\nplaylist.m3u8\n"]);
    expect(ha.seen.rest.at(-1)?.url).toBe(`/api/hls/${HLS}/master_playlist.m3u8?_HLS_msn=3`);
    // Only streams this process handed out, and only HLS file names.
    expect((await get(`/api/cameras/hls/${"0".repeat(32)}/master_playlist.m3u8`)).status).toBe(404);
    expect((await get(`/api/cameras/hls/${HLS}/../../states`)).status).toBe(404);

    const at = ha.t0 + 21 * 60_000;
    const playback = (await (await get(`/api/cameras/camera.c201/playback?at=${encodeURIComponent(formatLocal(at))}`)).json()) as any;
    expect(playback).toMatchObject({ url: `/api/cameras/camera.c201/recordings/${ha.pieces[2]}`, offset: 60, start: ha.t0 + 20 * 60_000, next: null });
    const first = (await (await get(`/api/cameras/camera.c201/playback?at=${ha.t0 + 1000}`)).json()) as any;
    expect(first).toMatchObject({ offset: 1, next: ha.t0 + 10 * 60_000 });
    expect((await get(`/api/cameras/camera.c201/playback?at=${encodeURIComponent(formatLocal(ha.t0 - 3600_000))}`)).status).toBe(502);
    const piece = await get(playback.url, { range: "bytes=2-5" });
    expect([piece.status, piece.headers.get("content-range"), await piece.text()]).toEqual([206, "bytes 2-5/10", "2345"]);
    expect(ha.seen.rest.at(-1)).toMatchObject({ url: `/media/c201/${ha.pieces[2]}`, range: "bytes=2-5", auth: `Bearer ${TOKEN}` });
    expect((await get("/api/cameras/camera.c201/recordings/..%2F..%2Fconfiguration.yaml")).status).toBe(404);

    const ptz = (body: unknown, headers: Record<string, string>) => h.request("/api/cameras/camera.c201/ptz", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await ptz({ direction: "up" }, {})).status).toBe(403);
    const moved = await ptz({ direction: "up" }, { "x-csrf-token": csrf });
    expect([moved.status, await moved.json()]).toEqual([200, { ok: true, done: "turned up" }]);
    expect(ha.seen.rest.at(-1)).toMatchObject({ url: "/api/services/tapo_ptz/move", body: JSON.stringify({ x: 0, y: 10 }) });

    // An account not on the list has no cameras at all.
    const other = await login(denied);
    const refused = await denied.request("/api/cameras/camera.c201", { headers: { cookie: other.cookie } });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([404, "camera_unavailable"]);
  } finally {
    if (saved !== undefined) process.env.HA_MCP_TOKEN = saved;
    ha.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await h.shutdown();
    await denied.shutdown();
  }
});
