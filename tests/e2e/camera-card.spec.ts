import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { mockConsole } from "./mock-api";
import { playlistOf, segmentOf, syncPointsOf, videoTrackOf } from "../../src/control/camera.js";

const ENTITY = "camera.c201";
const FILE = "c201_2026-11-12_16-50-00.mp4";
const START = Date.UTC(2026, 10, 13, 0, 50, 0); // 16:50 in Los Angeles
const RECORDINGS = `/api/cameras/${ENTITY}/recordings/`;
/** A real recording piece (a fragmented MP4 with an mfra index) to play for real; without it only the requests are checked. */
const PIECE = process.env.PA_CAMERA_PIECE;

const block = (at: string) => `\`\`\`camera\n${JSON.stringify({ camera: ENTITY, at })}\n\`\`\``;
const task = (result: string) => ({ id: "task-1", revision: 1, title: "看回放", text: "下午谁来过", conversationId: "child-1", status: "completed", result, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000, completedAt: Date.now() });
/** A 1x1 PNG for the picture at the moment. */
const STILL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** The four 2-second parts a made-up piece lists; the moment asked for (5 s in) is in the third. */
const PLAYLIST = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:2", "#EXT-X-PLAYLIST-TYPE:VOD", `#EXT-X-MAP:URI="${FILE}",BYTERANGE="100@0"`,
  ...[0, 1, 2, 3].flatMap((i) => ["#EXTINF:2.000,", `${FILE}?part=${100 + i * 50}-${150 + i * 50}`]), "#EXT-X-ENDLIST", ""].join("\n");

async function setup(page: Page, offset: number, media: (url: URL, range: string | undefined) => { status?: number; type: string; body: Buffer | string; headers?: Record<string, string> }) {
  await mockConsole(page, { conversations: [] });
  await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [task(`有人在门口：\n\n${block("2026-11-12 16:50:05")}`)], nextBefore: null } }));
  const seen: string[] = [];
  await page.route((url) => url.pathname.startsWith("/api/cameras/"), async (r) => {
    const url = new URL(r.request().url());
    const rest = url.pathname.slice(`/api/cameras/${ENTITY}`.length);
    seen.push(rest + url.search);
    if (rest === "") return r.fulfill({ json: { camera: { entity: ENTITY, name: "客厅", state: "idle", live: true, ptz: true, recordings: true, events: true }, timeZone: "America/Los_Angeles" } });
    if (rest === "/playback") return r.fulfill({ json: { url: `${RECORDINGS}${FILE}`, hls: `${RECORDINGS}${FILE}.m3u8`, offset, start: START, end: START + 600_000, next: null } });
    if (rest === "/frame") return r.fulfill({ contentType: "image/png", body: STILL });
    const m = media(url, r.request().headers().range);
    return r.fulfill({ status: m.status ?? 200, contentType: m.type, headers: m.headers, body: m.body });
  });
  await page.goto("/");
  await page.locator(".bubble").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".boot-cover")).toHaveCount(0, { timeout: 60_000 });
  const card = page.locator(".camera-card");
  await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
  return { card, seen, media: () => seen.filter((p) => p.startsWith("/recordings/")) };
}

test("a recording fetches nothing until it is started, then only the playlist and the part holding the moment; the save button keeps a minute from the moment on screen", async ({ page, browserName }, info) => {
  if (info.project.use.isMobile || info.project.use.hasTouch) await page.setViewportSize({ width: 360, height: 780 });
  const whole: string[] = []; // requests for the piece itself, by the range asked for
  const { card, media } = await setup(page, 5, (url, range) => {
    if (url.pathname.endsWith(".m3u8")) return { type: "application/vnd.apple.mpegurl", body: PLAYLIST };
    if (!url.search) whole.push(range ?? "all");
    return { type: "video/mp4", body: Buffer.alloc(64) };
  });
  const start = card.getByRole("button", { name: "播放录像" });
  await expect(start).toBeVisible({ timeout: 60_000 });
  await expect(card.locator(".camera-badge")).toHaveText("回放 11/12 16:50:05");
  await expect(card.locator("video")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await card.screenshot({ path: info.outputPath("recording.png") });

  // Saving: one minute from the moment on screen, named after the camera and that moment.
  const save = card.getByRole("button", { name: "保存 1 分钟" });
  await expect(save).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), save.click()]);
  expect(file.suggestedFilename()).toBe("c201-2026-11-12_16-50-05.mp4");
  expect(new URL(file.url()).pathname + new URL(file.url()).search).toBe(`/api/cameras/${ENTITY}/clip?at=${START + 5000}&seconds=60`);

  expect(media()).toEqual([]);
  await start.click();
  await expect(card.locator("video")).toHaveCount(1);
  await expect.poll(media).toContain(`/recordings/${FILE}.m3u8`);
  // Where the player reads media itself (hls.js), the requests show: never the bare file.
  if (browserName === "chromium") {
    await expect.poll(() => media().find((p) => p.includes("?part="))).toBe(`/recordings/${FILE}?part=200-250`);
    expect(whole).toEqual(["bytes=0-99"]);
  }
});

test("a real piece plays from the moment asked for without reading what comes before it", async ({ page, browserName }, info) => {
  test.skip(!PIECE, "needs PA_CAMERA_PIECE: a recording piece with an mfra index");
  const size = fs.statSync(PIECE!).size;
  const fd = fs.openSync(PIECE!, "r");
  const read = (from: number, to: number) => { const b = Buffer.alloc(to - from); fs.readSync(fd, b, 0, b.length, from); return b; };
  const mfraSize = read(size - 4, size).readUInt32BE(0);
  const track = videoTrackOf(read(0, 65536))!;
  const points = syncPointsOf(read(size - mfraSize, size), track.trackId);
  const seconds = points.at(-1)!.time / track.timescale + 2;
  const offset = Math.floor(seconds * 0.8);
  let bytes = 0;
  const { card, media } = await setup(page, offset, (url, range) => {
    if (url.pathname.endsWith(".m3u8")) return { type: "application/vnd.apple.mpegurl", body: playlistOf({ track, points, dataEnd: size - mfraSize }, encodeURIComponent(FILE), seconds) };
    const part = /^(\d+)-(\d+)$/.exec(url.searchParams.get("part") ?? "");
    const r = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
    const from = r ? Number(r[1]) : 0;
    const to = r?.[2] ? Number(r[2]) + 1 : size;
    const body = part ? segmentOf(read(Number(part[1]), Number(part[2])), Number(part[1])) : read(from, to);
    bytes += body.length;
    return part ? { type: "video/mp4", body } : { status: r ? 206 : 200, type: "video/mp4", headers: r ? { "content-range": `bytes ${from}-${to - 1}/${size}` } : undefined, body };
  });
  await card.getByRole("button", { name: "播放录像" }).click({ timeout: 60_000 });
  const video = card.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 }).toBeGreaterThan(offset + 1);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await expect(card.locator(".camera-error")).toHaveCount(0);
  await card.screenshot({ path: info.outputPath("playing.png") });
  info.annotations.push({ type: "media", description: `${browserName}: ${media().length} requests, ${(bytes / 1048576).toFixed(1)} MB of a ${(size / 1048576).toFixed(0)} MB piece` });
  console.log(`${info.project.name}: ${media().length} media requests, ${(bytes / 1048576).toFixed(1)} MB of ${(size / 1048576).toFixed(0)} MB`);
  expect(bytes).toBeLessThan(size / 2);
});
