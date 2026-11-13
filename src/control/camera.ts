import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import type { Config, HaCameraSpec } from "./config.js";
import type { Logger } from "../common/logger.js";
import { expandHome, readSecretFile } from "../common/secrets.js";
import type { AppContext } from "./context.js";
import { requireWorkspaceFilePath } from "./documents/paths.js";

/**
 * Home Assistant cameras beyond what Assist offers: a look at the picture now,
 * pan/tilt, the continuous recording and its event clips, and live video for
 * camera cards in messages. Everything goes through HA with the same long-lived
 * token as the MCP gateway (HA_MCP_TOKEN), which stays in the control plane:
 * executors get the tools on `aio_ha`, the console gets same-origin proxies
 * (live HLS, recording pieces, frames), and nothing reaches HA from a sandbox
 * or a browser directly. Recordings and pan/tilt are per camera (PA_HA_CAMERAS).
 */

const TOKEN_KEY = "HA_MCP_TOKEN";
const LIST_TTL_MS = 30_000;
/** A recording piece's length when the folder does not tell (cam-record writes 10 minutes). */
const PIECE_SECONDS = 600;
/** An HLS session HA handed out stays usable this long after its last request. */
const HLS_IDLE_MS = 10 * 60_000;
const MAX_FRAMES = 6;
/** The most one playlist segment may hold: a key frame interval at many times the cameras' bit rate. */
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
/** The longest clip cut from the recording: about 110 MB at the cameras' bit rate. */
const MAX_CLIP_SECONDS = 600;
/** One ffmpeg run while cutting a clip. */
const CLIP_TIMEOUT_MS = 180_000;
const STEP = 10; // the Tapo App's single tap on a direction
const DIRECTIONS = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] } as const;
type Direction = keyof typeof DIRECTIONS;

export class CameraError extends Error {}

export interface CameraInfo {
  entity: string;
  name: string;
  state: string;
  /** HA serves it as HLS (live video in a card); otherwise the card refreshes snapshots. */
  live: boolean;
  ptz: boolean;
  recordings: boolean;
  events: boolean;
}

export interface RecordingPiece {
  file: string;
  start: number;
  end: number;
}

/** What a recording piece's index (mfra) tells: its init segment, video track and key frames. */
interface PieceIndex {
  head: Buffer;
  track: { trackId: number; timescale: number; initEnd: number };
  points: Array<{ time: number; offset: number }>;
  /** Where the fragments end (the index follows). */
  dataEnd: number;
}

export interface CameraEvent {
  file: string;
  at: number;
  label: string;
}

/** A local wall-clock time, as the cameras' file names and the people in this house write it. */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "2026-10-13 20:38", "2026-10-13 20:38:10", "2026-10-13T20:38:10" (local) or an ISO time with a zone. */
export function parseLocal(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
    const t = new Date(y, mo - 1, d, h, mi, s).getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const t = Date.parse(text);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const PIECE = /^[\w-]+_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/;
const EVENT = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_([^/]{1,40})\.mp4$/;
const stamp = (m: RegExpExecArray) => {
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
};

/** Recording pieces from their file names, each ending where the next begins (or after its usual length). */
export function piecesOf(files: string[], now = Date.now()): RecordingPiece[] {
  const starts = files.flatMap((file) => {
    const m = PIECE.exec(file);
    return m ? [{ file, start: stamp(m) }] : [];
  }).sort((a, b) => a.start - b.start);
  const gaps = starts.slice(1).map((p, i) => (p.start - starts[i]!.start) / 1000).filter((g) => g > 0).sort((a, b) => a - b);
  const usual = (gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)]! : PIECE_SECONDS) * 1000;
  return starts.map((p, i) => {
    const next = starts[i + 1]?.start;
    const end = next !== undefined && next - p.start <= usual * 1.5 ? next : Math.min(p.start + usual, next ?? (now - p.start < usual * 1.5 ? now : p.start + usual));
    return { ...p, end: Math.max(end, p.start) };
  });
}

export function eventsOf(files: string[]): CameraEvent[] {
  return files.flatMap((file) => {
    const m = EVENT.exec(file);
    return m ? [{ file, at: stamp(m), label: m[7]! }] : [];
  }).sort((a, b) => a.at - b.at);
}

/** The boxes directly inside `buf[from, to)`: type and where the payload is. */
function* boxes(buf: Buffer, from = 0, to = buf.length): Generator<{ type: string; start: number; body: number; end: number }> {
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = Number(buf.readBigUInt64BE(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) return;
    yield { type: buf.toString("latin1", at + 4, at + 8), start: at, body, end: at + size };
    at += size;
  }
}

const childBox = (buf: Buffer, parent: { body: number; end: number }, type: string) => [...boxes(buf, parent.body, parent.end)].find((b) => b.type === type);

/** A fragmented MP4's video track (id and timescale) and where its init segment (ftyp + moov) ends. */
export function videoTrackOf(head: Buffer): { trackId: number; timescale: number; initEnd: number } | null {
  const moov = [...boxes(head)].find((b) => b.type === "moov");
  if (!moov) return null;
  for (const trak of boxes(head, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = childBox(head, trak, "tkhd");
    const mdia = childBox(head, trak, "mdia");
    const mdhd = mdia && childBox(head, mdia, "mdhd");
    const hdlr = mdia && childBox(head, mdia, "hdlr");
    if (!tkhd || !mdhd || !hdlr || head.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "vide") continue;
    const v1 = (b: { body: number }) => head[b.body] === 1;
    const trackId = head.readUInt32BE(tkhd.body + (v1(tkhd) ? 20 : 12));
    const timescale = head.readUInt32BE(mdhd.body + (v1(mdhd) ? 20 : 12));
    return timescale > 0 ? { trackId, timescale, initEnd: moov.end } : null;
  }
  return null;
}

/**
 * Move fragments cut out of a file to `shift` bytes earlier: ffmpeg's muxer writes
 * each track fragment's base data offset (tfhd) as an absolute file position.
 */
export function rebaseFragments(body: Buffer, shift: number): Buffer {
  const out = Buffer.from(body);
  for (const moof of boxes(out)) {
    if (moof.type !== "moof") continue;
    for (const traf of boxes(out, moof.body, moof.end)) {
      const tfhd = traf.type === "traf" ? childBox(out, traf, "tfhd") : undefined;
      if (!tfhd || !(out.readUInt32BE(tfhd.body) & 0x000001) || tfhd.body + 16 > tfhd.end) continue;
      out.writeBigUInt64BE(out.readBigUInt64BE(tfhd.body + 8) - BigInt(shift), tfhd.body + 8);
    }
  }
  return out;
}

/**
 * Fragments cut out of a file at byte `at`, as a media segment a browser's player takes: ffmpeg's muxer
 * writes each track fragment's data position as an absolute file offset (tfhd base data offset), which
 * players refuse in a segment, so it is rewritten relative to the fragment (default-base-is-moof).
 */
export function segmentOf(body: Buffer, at: number): Buffer {
  const parts: Buffer[] = [];
  let copied = 0;
  for (const moof of boxes(body)) {
    if (moof.type !== "moof") continue;
    const out = Buffer.from(body.subarray(moof.start, moof.end));
    const cuts: number[] = []; // where, in `out`, an 8-byte base data offset is dropped
    const runs: Array<{ field: number; base: number }> = [];
    for (const traf of boxes(body, moof.body, moof.end)) {
      const tfhd = traf.type === "traf" ? childBox(body, traf, "tfhd") : undefined;
      if (!tfhd || !(body.readUInt32BE(tfhd.body) & 0x000001) || tfhd.body + 16 > tfhd.end) continue;
      const base = Number(body.readBigUInt64BE(tfhd.body + 8));
      out.writeUInt32BE((body.readUInt32BE(tfhd.body) & ~0x000001) | 0x020000, tfhd.body - moof.start);
      for (const box of [tfhd, traf]) out.writeUInt32BE(box.end - box.start - 8, box.start - moof.start);
      cuts.push(tfhd.body + 8 - moof.start);
      for (const trun of boxes(body, traf.body, traf.end)) {
        if (trun.type === "trun" && body.readUInt32BE(trun.body) & 0x000001) runs.push({ field: trun.body + 8 - moof.start, base });
      }
    }
    if (!cuts.length) continue;
    // The data moves closer to the fragment's start by what was dropped before it.
    for (const run of runs) out.writeInt32BE(run.base + out.readInt32BE(run.field) - (at + moof.start) - cuts.length * 8, run.field);
    out.writeUInt32BE(out.length - cuts.length * 8, 0);
    parts.push(body.subarray(copied, moof.start));
    let from = 0;
    for (const cut of cuts) { parts.push(out.subarray(from, cut)); from = cut + 8; }
    parts.push(out.subarray(from));
    copied = moof.end;
  }
  parts.push(body.subarray(copied));
  return Buffer.concat(parts);
}

/**
 * A finished piece as an HLS playlist, one segment per key frame, each a part of the piece by its byte offsets.
 * A browser given the bare file has to read it from the start to reach a moment (the fragments carry no
 * index a player uses); with the playlist it fetches only the init segment and the fragments it plays.
 */
export function playlistOf(index: Pick<PieceIndex, "track" | "points" | "dataEnd">, uri: string, seconds: number): string {
  const starts = index.points.filter((p, i, all) => i === 0 || p.offset > all[i - 1]!.offset);
  const time = (i: number) => starts[i]!.time / index.track.timescale;
  const lengths = starts.map((_, i) => Math.max(0.001, (i + 1 < starts.length ? time(i + 1) : Math.max(seconds, time(i) + 0.001)) - time(i)));
  const lines = [
    "#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...lengths))}`, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${uri}",BYTERANGE="${index.track.initEnd}@0"`,
  ];
  starts.forEach((p, i) => {
    const end = starts[i + 1]?.offset ?? index.dataEnd;
    lines.push(`#EXTINF:${lengths[i]!.toFixed(3)},`, `${uri}?part=${p.offset}-${end}`);
  });
  return [...lines, "#EXT-X-ENDLIST", ""].join("\n");
}

/** A track's random access points from an mfra box: (time in the track's timescale, moof offset), by time. */
export function syncPointsOf(mfra: Buffer, trackId: number): Array<{ time: number; offset: number }> {
  const root = [...boxes(mfra)].find((b) => b.type === "mfra");
  if (!root) return [];
  for (const tfra of boxes(mfra, root.body, root.end)) {
    if (tfra.type !== "tfra" || mfra.readUInt32BE(tfra.body + 4) !== trackId) continue;
    const v1 = mfra[tfra.body] === 1;
    const sizes = mfra.readUInt32BE(tfra.body + 8);
    const skip = ((sizes >> 4) & 3) + ((sizes >> 2) & 3) + (sizes & 3) + 3;
    const count = mfra.readUInt32BE(tfra.body + 12);
    const points: Array<{ time: number; offset: number }> = [];
    let at = tfra.body + 16;
    for (let i = 0; i < count && at + (v1 ? 16 : 8) + skip <= tfra.end; i += 1) {
      const time = v1 ? Number(mfra.readBigUInt64BE(at)) : mfra.readUInt32BE(at);
      const offset = v1 ? Number(mfra.readBigUInt64BE(at + 8)) : mfra.readUInt32BE(at + 4);
      points.push({ time, offset });
      at += (v1 ? 16 : 8) + skip;
    }
    return points.sort((a, b) => a.time - b.time);
  }
  return [];
}

const CARD_HINT =
  "To let the user watch, write a camera card in your reply: a fenced block ```camera holding " +
  "{\"camera\": \"<entity>\"} for live video, or {\"camera\": \"<entity>\", \"at\": \"YYYY-MM-DD HH:MM:SS\"} to play the recording from that moment.";

export const CAMERA_TOOLS = [
  {
    name: "camera_list",
    description: "List the home's cameras with what each can do: live video, pan/tilt, continuous recording (and how far back it goes), event clips. " + CARD_HINT,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "camera_snapshot",
    description: "Look at what a camera sees right now: returns the current picture. Use it to answer questions about the scene; to let the user watch, give them a camera card instead.",
    inputSchema: {
      type: "object",
      properties: { camera: { type: "string", description: "The camera entity, e.g. camera.c201_go2rtc (from camera_list)" } },
      required: ["camera"],
    },
  },
  {
    name: "camera_ptz",
    description:
      "Turn a pan/tilt camera: a direction (each step is one tap of the official app's arrow, a small turn) or a preset saved in the camera's app. " +
      "Returns the picture after it moved, so you can check where it points and turn again if needed.",
    inputSchema: {
      type: "object",
      properties: {
        camera: { type: "string", description: "The camera entity" },
        direction: { type: "string", enum: Object.keys(DIRECTIONS), description: "Which way to turn" },
        steps: { type: "integer", minimum: 1, maximum: 5, description: "How many taps, default 1" },
        preset: { type: "string", description: "Instead of a direction: the name of a preset position saved in the camera's app" },
      },
      required: ["camera"],
    },
  },
  {
    name: "camera_recordings",
    description:
      "What a camera recorded: the span the continuous recording covers (and any gaps), and the event clips (person or motion detections) in a time range. " +
      "Times are local, YYYY-MM-DD HH:MM:SS. Use it to find when something happened, then look with camera_recording_frames or give the user a camera card at that time.",
    inputSchema: {
      type: "object",
      properties: {
        camera: { type: "string", description: "The camera entity" },
        from: { type: "string", description: "Start of the range, local time; default 24 hours ago" },
        to: { type: "string", description: "End of the range, local time; default now" },
        label: { type: "string", description: "Only events whose label contains this, e.g. 人形 (person) or 移动 (motion)" }, // i18n-exempt: the labels the cameras report
      },
      required: ["camera"],
    },
  },
  {
    name: "camera_recording_frames",
    description:
      "Look at the continuous recording: returns pictures from the given local time, one every interval_seconds (up to 6), each labeled with its time. " +
      "Use it to see what happened at a past moment, e.g. around an event from camera_recordings.",
    inputSchema: {
      type: "object",
      properties: {
        camera: { type: "string", description: "The camera entity" },
        at: { type: "string", description: "Local time of the first picture, YYYY-MM-DD HH:MM:SS" },
        count: { type: "integer", minimum: 1, maximum: MAX_FRAMES, description: "How many pictures, default 1" },
        interval_seconds: { type: "integer", minimum: 1, maximum: 600, description: "Seconds between pictures, default 10" },
      },
      required: ["camera", "at"],
    },
  },
  {
    name: "camera_recording_clip",
    description:
      "Cut a video clip, with its sound, out of the continuous recording and save it as an MP4 in the user's workspace: from and to are local times, YYYY-MM-DD HH:MM:SS, at most " + MAX_CLIP_SECONDS / 60 + " minutes apart. " +
      "The clip is copied from the recording without re-encoding, so it starts at the key frame just before from (it reports the exact times). " +
      "This is how to export, download, send or edit a recording: never open the console's playback page in the browser for it. Put the returned path in your reply as a link on a line of its own, which the console shows as a player.",
    inputSchema: {
      type: "object",
      properties: {
        camera: { type: "string", description: "The camera entity" },
        from: { type: "string", description: "Start, local time YYYY-MM-DD HH:MM:SS" },
        to: { type: "string", description: "End, local time YYYY-MM-DD HH:MM:SS" },
        path: { type: "string", description: "Where to save it: an absolute .mp4 path in the workspace, e.g. in this task's folder; default a new file under camera/" },
      },
      required: ["camera", "from", "to"],
    },
  },
];


export const CAMERA_TOOL_NAMES = new Set(CAMERA_TOOLS.map((t) => t.name));

/** Saving a clip in one account's workspace. */
export interface ClipFiles {
  write(path: string, bytes: Buffer): Promise<void>;
}

/** An account's workspace, reached through its own sandbox. */
export function sandboxClipFiles(ctx: Pick<AppContext, "container">): ClipFiles {
  return {
    async write(file, bytes) {
      const mkdir = await ctx.container.execInSandbox(["mkdir", "-p", "--", path.posix.dirname(file)], { timeoutMs: 30_000 });
      if (mkdir.code !== 0) throw new Error(`Failed to create the folder: ${mkdir.stderr.trim().slice(0, 200)}`);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), path.posix.basename(file));
      form.append("path", file);
      const res = await ctx.container.fetch("/v1/file/upload", { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || json.success === false) throw new Error(`Failed to save the clip: ${json.message ?? res.status}`);
    },
  };
}

export const CAMERA_POLICY =
  "Cameras are on aio_ha too: when the user wants to see a camera, check on a room, turn a camera, or find out what happened earlier, use camera_list, camera_snapshot, camera_ptz, camera_recordings, camera_recording_frames and camera_recording_clip. " +
  "To let the user watch, put a camera card in your reply (a fenced ```camera block with {\"camera\": \"<entity>\"} for live video, adding \"at\": \"YYYY-MM-DD HH:MM:SS\" to play the recording from that moment) rather than only describing it. " +
  "When asked what happened, find the events with camera_recordings, look at the frames before answering, say what you actually saw with times, and add a card at the moment so the user can watch it. " +
  "When the user wants a recording exported, downloaded, sent or edited, cut it with camera_recording_clip and link the saved file; the console's playback page is not for the browser, and never ask the user to sign in to the console. " +
  "Turn a camera only when the user asks, and say where it points afterwards; do not switch camera detection or privacy settings unless asked.";

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
type WsMessage = Record<string, unknown> & { type: string };

/** HA's address from PA_HA_MCP_URL and its token from HA_MCP_TOKEN (read on first use); null without a usable URL. */
export function haAccess(cfg: Config): { baseUrl: string; token: () => string | null } | null {
  if (!cfg.haMcp.upstreamUrl) return null;
  let origin: string;
  try {
    origin = new URL(cfg.haMcp.upstreamUrl).origin;
  } catch {
    return null;
  }
  let token: string | null | undefined;
  const read = () => {
    if (token !== undefined) return token;
    const fromEnv = process.env[TOKEN_KEY]?.trim();
    if (fromEnv) return (token = fromEnv);
    const file = readSecretFile(expandHome(cfg.haMcp.secretsFile), TOKEN_KEY);
    return (token = file.ok ? file.value : null);
  };
  return { baseUrl: origin, token: read };
}

export class HaCameras {
  #base: string;
  #token: () => string | null;
  #cameras: Record<string, HaCameraSpec>;
  #log: Logger;
  #ffmpeg: string;
  #lists = new Map<string, { at: number; files: Promise<string[]> }>();
  #indexes = new Map<string, PieceIndex>();
  /** HLS sessions this process handed out: token -> last use. */
  #hls = new Map<string, number>();

  constructor(opts: { baseUrl: string; token: () => string | null; cameras: Record<string, HaCameraSpec>; log: Logger; ffmpeg?: string }) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#cameras = opts.cameras;
    this.#log = opts.log.child("camera");
    this.#ffmpeg = opts.ffmpeg ?? "ffmpeg";
  }

  /** The deployment's cameras (haAccess); null without HA. */
  static from(cfg: Config, log: Logger): HaCameras | null {
    const access = haAccess(cfg);
    return access ? new HaCameras({ ...access, cameras: cfg.haMcp.cameras, log }) : null;
  }

  #auth(): string {
    const token = this.#token();
    if (!token) throw new CameraError("Home Assistant is not configured");
    return `Bearer ${token}`;
  }

  async #rest(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}${path}`, { ...init, headers: { authorization: this.#auth(), ...init.headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err instanceof CameraError) throw err;
      throw new CameraError(`Cannot reach Home Assistant (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      this.#log.warn("Home Assistant rejected the camera token");
      throw new CameraError("Home Assistant refused the request");
    }
    return res;
  }

  /** One command over HA's WebSocket API (camera streams and the media browser live only there). */
  async #ws<T>(message: WsMessage, timeoutMs = 20_000): Promise<T> {
    const token = this.#auth().slice("Bearer ".length);
    return await new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(`${this.#base.replace(/^http/, "ws")}/api/websocket`);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new CameraError("Home Assistant did not answer in time"))), timeoutMs);
      ws.onerror = () => done(() => reject(new CameraError("Cannot reach Home Assistant")));
      ws.onmessage = (ev) => {
        let m: { type?: string; success?: boolean; result?: unknown; error?: { code?: string; message?: string } };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (m.type === "auth_invalid") done(() => reject(new CameraError("Home Assistant refused the request")));
        else if (m.type === "auth_ok") ws.send(JSON.stringify({ id: 1, ...message }));
        else if (m.type === "result") done(() => (m.success ? resolve(m.result as T) : reject(new CameraError(m.error?.message ?? "Home Assistant refused the request"))));
      };
    });
  }

  async #states(): Promise<Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>> {
    const res = await this.#rest("/api/states");
    if (!res.ok) throw new CameraError(`Home Assistant answered ${res.status}`);
    return (await res.json()) as Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
  }

  /** Whether the account may see this camera at all (its spec's accounts, if any). */
  visible(entity: string, username: string): boolean {
    const accounts = this.#cameras[entity]?.accounts;
    return !accounts || accounts.includes(username);
  }

  async list(username: string): Promise<CameraInfo[]> {
    const cameras = (await this.#states()).filter((s) => s.entity_id.startsWith("camera.") && this.visible(s.entity_id, username));
    return await Promise.all(cameras.map((s) => this.#info(s)));
  }

  /** One camera; a name that is not a camera in HA, or not one for this account, is refused alike. */
  async camera(entity: unknown, username: string): Promise<CameraInfo> {
    if (typeof entity !== "string" || !/^camera\.[a-z0-9_]+$/.test(entity)) throw new CameraError("camera must be a camera entity such as camera.c201_go2rtc (see camera_list)");
    if (!this.visible(entity, username)) throw new CameraError(`There is no camera ${entity}; see camera_list`);
    const res = await this.#rest(`/api/states/${entity}`);
    if (res.status === 404) throw new CameraError(`There is no camera ${entity}; see camera_list`);
    if (!res.ok) throw new CameraError(`Home Assistant answered ${res.status}`);
    return await this.#info((await res.json()) as { entity_id: string; state: string; attributes: Record<string, unknown> });
  }

  async #info(s: { entity_id: string; state: string; attributes: Record<string, unknown> }): Promise<CameraInfo> {
    const spec = this.#cameras[s.entity_id] ?? {};
    const types = await this.#ws<{ frontend_stream_types?: string[] }>({ type: "camera/capabilities", entity_id: s.entity_id }).catch(() => null);
    return {
      entity: s.entity_id,
      name: typeof s.attributes.friendly_name === "string" ? s.attributes.friendly_name : s.entity_id,
      state: s.state,
      live: Boolean(types?.frontend_stream_types?.includes("hls")),
      ptz: Boolean(spec.ptz),
      recordings: Boolean(spec.recordings),
      events: Boolean(spec.events),
    };
  }

  async snapshot(entity: string, width = 960): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.#rest(`/api/camera_proxy/${entity}?width=${width}`);
    if (!res.ok) {
      await res.body?.cancel();
      throw new CameraError(res.status === 404 ? `There is no camera ${entity}` : `The camera has no picture right now (Home Assistant answered ${res.status}); it may be offline`);
    }
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "image/jpeg" };
  }

  async ptz(entity: string, move: { direction?: unknown; steps?: unknown; preset?: unknown }): Promise<string> {
    const domain = this.#cameras[entity]?.ptz;
    if (!domain) throw new CameraError(`${entity} cannot pan or tilt`);
    let service: string;
    let data: Record<string, unknown>;
    if (typeof move.preset === "string" && move.preset.trim()) {
      service = "goto_preset";
      data = { name: move.preset.trim().slice(0, 60) };
    } else {
      const dir = DIRECTIONS[move.direction as Direction];
      if (!dir) throw new CameraError(`direction must be ${Object.keys(DIRECTIONS).join(" / ")}, or give a preset`);
      const steps = move.steps === undefined ? 1 : Number(move.steps);
      if (!Number.isInteger(steps) || steps < 1 || steps > 5) throw new CameraError("steps must be an integer from 1 to 5");
      service = "move";
      data = { x: dir[0] * STEP * steps, y: dir[1] * STEP * steps };
    }
    const res = await this.#rest(`/api/services/${domain}/${service}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }, 30_000);
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
      // Not resent: the camera may have turned and only the reply failed.
      throw new CameraError(`The camera did not take the command (${res.status}${text ? `: ${text}` : ""}); check the picture before trying again`);
    }
    this.#log.info("camera turned", { entity, service, ...data });
    return service === "move" ? `turned ${move.direction}${Number(move.steps ?? 1) > 1 ? ` ×${move.steps}` : ""}` : `went to preset ${data.name}`;
  }

  /** A media source folder's file names, briefly cached (the recorder adds one every 10 minutes). */
  async #files(folder: string): Promise<string[]> {
    const cached = this.#lists.get(folder);
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return await cached.files;
    const files = this.#ws<{ children?: Array<{ title?: string; media_content_id?: string; can_play?: boolean }> }>(
      { type: "media_source/browse_media", media_content_id: `media-source://media_source/${folder}` },
      30_000,
    ).then((r) => (r.children ?? []).filter((c) => c.can_play).map((c) => String(c.media_content_id ?? "").split("/").pop() ?? "").filter(Boolean));
    this.#lists.set(folder, { at: Date.now(), files });
    files.catch(() => this.#lists.delete(folder));
    return await files;
  }

  async pieces(entity: string): Promise<RecordingPiece[]> {
    const folder = this.#cameras[entity]?.recordings;
    if (!folder) throw new CameraError(`${entity} has no continuous recording`);
    return piecesOf(await this.#files(folder));
  }

  async events(entity: string): Promise<CameraEvent[]> {
    const folder = this.#cameras[entity]?.events;
    return folder ? eventsOf(await this.#files(folder)) : [];
  }

  /** The recording piece holding a moment, and how far into it the moment is. */
  async locate(entity: string, at: number): Promise<{ piece: RecordingPiece; offset: number; next: RecordingPiece | null }> {
    const pieces = await this.pieces(entity);
    const i = pieces.findIndex((p) => p.start <= at && at < p.end);
    if (i < 0) {
      if (!pieces.length) throw new CameraError("There is no recording yet");
      throw new CameraError(`Nothing was recorded at ${formatLocal(at)}; the recording covers ${formatLocal(pieces[0]!.start)} to ${formatLocal(pieces.at(-1)!.end)}${pieces.length > 1 ? " (see camera_recordings for gaps)" : ""}`);
    }
    return { piece: pieces[i]!, offset: (at - pieces[i]!.start) / 1000, next: pieces[i + 1] ?? null };
  }

  /**
   * One picture from the recording. The pieces are fragmented MP4 with an index
   * at the end (mfra): only the init segment and the fragment holding the moment
   * are fetched, by range, and decoded (ffmpeg's own index seek over HTTP is slow
   * in older builds). The piece still being written has no index yet and is read
   * over HTTP up to the moment.
   */
  async frame(entity: string, at: number): Promise<Buffer> {
    const { piece, offset } = await this.locate(entity, at);
    const path = `/media/${this.#cameras[entity]!.recordings}/${encodeURIComponent(piece.file)}`;
    const missing = () => new CameraError(`No picture at ${formatLocal(at)}${piece.end >= Date.now() - 60_000 ? "; the last seconds may not be written yet, use camera_snapshot for now" : ""}`);
    const output = ["-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
    const indexed = await this.#fragment(path, offset).catch((err) => {
      if (err instanceof CameraError) throw err;
      this.#log.warn("recording index unreadable", { entity, file: piece.file, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    const bytes = indexed
      ? await this.#ffmpeg_(["-v", "error", "-nostdin", "-f", "mp4", "-i", "pipe:0", "-ss", indexed.skip.toFixed(2), ...output], indexed.data)
      : await this.#ffmpeg_(["-v", "error", "-nostdin", "-use_mfra_for", "pts", "-headers", `Authorization: ${this.#auth()}\r\n`, "-ss", offset.toFixed(2), "-i", `${this.#base}${path}`, ...output]);
    if (bytes.ok) return bytes.out;
    this.#log.warn("recording frame failed", { entity, file: piece.file, offset, error: bytes.error });
    throw missing();
  }

  async #range(path: string, range: string): Promise<{ bytes: Buffer; total: number }> {
    const res = await this.#rest(path, { headers: { range } }, 30_000);
    if (res.status !== 206) {
      await res.body?.cancel();
      if (res.status === 404) throw new CameraError("This recording is gone (newer recordings replace the oldest)");
      throw new Error(`Home Assistant answered ${res.status} to a range request`);
    }
    return { bytes: Buffer.from(await res.arrayBuffer()), total: Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? 0) };
  }

  /** A piece's init segment, video track and key frames, from its index at the end; null for a piece without one. */
  async #index(path: string): Promise<PieceIndex | null> {
    const kept = this.#indexes.get(path);
    if (kept) return kept;
    const index = await this.#readIndex(path);
    if (index) {
      // A finished piece never changes; the few a person is watching are kept.
      if (this.#indexes.size >= 16) this.#indexes.delete(this.#indexes.keys().next().value!);
      this.#indexes.set(path, index);
    }
    return index;
  }

  async #readIndex(path: string): Promise<PieceIndex | null> {
    const tail = await this.#range(path, "bytes=-16");
    if (tail.bytes.length !== 16 || tail.bytes.toString("latin1", 4, 8) !== "mfro") return null;
    const mfraSize = tail.bytes.readUInt32BE(12);
    if (mfraSize < 16 || mfraSize > 4 * 1024 * 1024 || !tail.total) return null;
    const [head, mfra] = await Promise.all([this.#range(path, "bytes=0-65535"), this.#range(path, `bytes=-${mfraSize}`)]);
    const track = videoTrackOf(head.bytes);
    if (!track) return null;
    const points = syncPointsOf(mfra.bytes, track.trackId);
    return points.length ? { head: head.bytes, track, points, dataEnd: tail.total - mfraSize } : null;
  }

  /** The init segment and fragments `from` to `to` (exclusive), as one playable fragmented MP4. */
  async #cut(path: string, index: PieceIndex, from: number, to: number): Promise<Buffer> {
    const start = index.points[from]!.offset;
    const end = index.points[to]?.offset ?? index.dataEnd;
    const body = await this.#range(path, `bytes=${start}-${end - 1}`);
    return Buffer.concat([index.head.subarray(0, index.track.initEnd), rebaseFragments(body.bytes, start - index.track.initEnd)]);
  }

  /** The last key frame at or before `seconds` into the piece. */
  #keyBefore(index: PieceIndex, seconds: number): number {
    let i = 0;
    while (i + 1 < index.points.length && index.points[i + 1]!.time / index.track.timescale <= seconds) i += 1;
    return i;
  }

  /** The init segment and the fragments from the last key frame before `seconds`; null for a piece without an index. */
  async #fragment(path: string, seconds: number): Promise<{ data: Buffer; skip: number } | null> {
    const index = await this.#index(path);
    if (!index) return null;
    const i = this.#keyBefore(index, seconds);
    // Two fragments, so a moment near a fragment's end still has frames after it.
    const data = await this.#cut(path, index, i, i + 2);
    return { data, skip: Math.max(0, seconds - index.points[i]!.time / index.track.timescale) };
  }

  /** The fragments covering `start` to `end` seconds into the piece, from the key frame at or before `start`; null without an index. */
  async #span(path: string, start: number, end: number): Promise<{ data: Buffer; start: number } | null> {
    const index = await this.#index(path);
    if (!index) return null;
    const i = this.#keyBefore(index, start);
    let j = i + 1;
    while (j < index.points.length && index.points[j]!.time / index.track.timescale < end) j += 1;
    return { data: await this.#cut(path, index, i, j), start: index.points[i]!.time / index.track.timescale };
  }

  /**
   * A clip of the continuous recording, `from` to `to` (local ms), with its sound and without
   * re-encoding: each piece gives the fragments covering its part, from the key frame before it
   * (only those bytes are fetched, by range), the parts are joined and the result made to play
   * from the start (faststart). The piece still being written has no index and is read over HTTP.
   */
  async clip(entity: string, from: number, to: number): Promise<{ bytes: Buffer; start: number; end: number; gaps: Array<[number, number]> }> {
    const folder = this.#cameras[entity]?.recordings;
    if (!folder) throw new CameraError(`${entity} has no continuous recording`);
    const pieces = (await this.pieces(entity)).filter((p) => p.end > from && p.start < to);
    if (!pieces.length) await this.locate(entity, from); // says what the recording covers
    if (!pieces.length) throw new CameraError(`Nothing was recorded from ${formatLocal(from)} to ${formatLocal(to)}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-clip-"));
    const copy = ["-map", "0:v", "-map", "0:a?", "-c", "copy"];
    try {
      const parts: string[] = [];
      const gaps: Array<[number, number]> = [];
      let start = 0;
      let cursor = from;
      for (const piece of pieces) {
        if (piece.start - cursor > 1000) gaps.push([cursor, piece.start]);
        const s = Math.max(from, piece.start);
        const e = Math.min(to, piece.end);
        const media = `/media/${folder}/${encodeURIComponent(piece.file)}`;
        const part = path.join(dir, `part${parts.length}.mp4`);
        const span = await this.#span(media, (s - piece.start) / 1000, (e - piece.start) / 1000).catch((err) => {
          if (err instanceof CameraError) throw err;
          this.#log.warn("recording index unreadable", { entity, file: piece.file, error: err instanceof Error ? err.message : String(err) });
          return null;
        });
        const partStart = span ? piece.start + span.start * 1000 : s;
        const cut = span
          ? await this.#ffmpegTo(["-f", "mp4", "-i", "pipe:0", "-t", ((e - partStart) / 1000).toFixed(3), ...copy, part], span.data)
          : await this.#ffmpegTo(["-use_mfra_for", "pts", "-headers", `Authorization: ${this.#auth()}\r\n`, "-ss", ((s - piece.start) / 1000).toFixed(2), "-i", `${this.#base}${media}`, "-t", ((e - s) / 1000).toFixed(3), ...copy, part]);
        if (!cut.ok || !(fs.statSync(part, { throwIfNoEntry: false })?.size)) {
          this.#log.warn("recording clip failed", { entity, file: piece.file, error: cut.ok ? "empty" : cut.error });
          throw new CameraError(`Could not cut ${formatLocal(s)} to ${formatLocal(e)} from the recording${piece.end >= Date.now() - 60_000 ? "; the last seconds may not be written yet" : ""}`);
        }
        if (!parts.length) start = partStart;
        parts.push(part);
        cursor = Math.max(cursor, e);
      }
      if (to - cursor > 1000) gaps.push([cursor, to]);
      const out = path.join(dir, "clip.mp4");
      let input: string[] = ["-i", parts[0]!];
      if (parts.length > 1) {
        const list = path.join(dir, "parts.txt");
        fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
        input = ["-f", "concat", "-safe", "0", "-i", list];
      }
      const joined = await this.#ffmpegTo([...input, ...copy, "-movflags", "+faststart", out]);
      if (!joined.ok) {
        this.#log.warn("recording clip join failed", { entity, error: joined.error });
        throw new CameraError("Could not put the clip together");
      }
      return { bytes: fs.readFileSync(out), start, end: cursor, gaps };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** ffmpeg writing a file (the last argument); a clip of several minutes may take a while. */
  async #ffmpegTo(args: string[], input?: Buffer): Promise<{ ok: true } | { ok: false; error: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpeg, ["-v", "error", "-nostdin", "-y", ...args], { stdio: [input ? "pipe" : "ignore", "ignore", "pipe"] });
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), CLIP_TIMEOUT_MS);
      child.stderr!.on("data", (c: Buffer) => { err = (err + c.toString()).slice(-500); });
      child.on("error", (e) => { clearTimeout(timer); reject(new CameraError(`Cannot read the recording (${e.message})`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `exit ${code}` });
      });
      if (input) {
        child.stdin!.on("error", () => undefined);
        child.stdin!.end(input);
      }
    });
  }

  async #ffmpeg_(args: string[], input?: Buffer): Promise<{ ok: true; out: Buffer } | { ok: false; error: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpeg, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.stdout!.on("data", (c: Buffer) => out.push(c));
      child.stderr!.on("data", (c: Buffer) => { err = (err + c.toString()).slice(-500); });
      child.on("error", (e) => { clearTimeout(timer); reject(new CameraError(`Cannot read the recording (${e.message})`)); });
      child.on("close", () => {
        clearTimeout(timer);
        const bytes = Buffer.concat(out);
        resolve(bytes.length ? { ok: true, out: bytes } : { ok: false, error: err.trim() });
      });
      if (input) {
        child.stdin!.on("error", () => undefined); // ffmpeg stops reading once it has its frame
        child.stdin!.end(input);
      }
    });
  }

  /** Start (or join) HA's HLS stream for a camera; the token is the stream's only credential. */
  async liveToken(entity: string): Promise<string> {
    const r = await this.#ws<{ url?: string }>({ type: "camera/stream", entity_id: entity, format: "hls" }, 30_000);
    const token = /^\/api\/hls\/([a-f0-9]{16,128})\/master_playlist\.m3u8$/.exec(r.url ?? "")?.[1];
    if (!token) throw new CameraError("This camera has no live video here");
    const now = Date.now();
    for (const [t, used] of this.#hls) if (now - used > HLS_IDLE_MS) this.#hls.delete(t);
    this.#hls.set(token, now);
    return token;
  }

  /** Relay one HLS request of a stream this process handed out (playlists block for low latency, so no short timeout). */
  async proxyHls(token: string, file: string, query: string, res: http.ServerResponse): Promise<void> {
    if (!this.#hls.has(token) || !/^(?:master_playlist\.m3u8|playlist\.m3u8|init\.mp4|segment\/\d+(?:\.\d+)?\.m4s)$/.test(file)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    this.#hls.set(token, Date.now());
    const q = new URLSearchParams(query);
    const passed = new URLSearchParams([...q].filter(([k]) => k.startsWith("_HLS_")));
    let upstream: Response;
    try {
      upstream = await fetch(`${this.#base}/api/hls/${token}/${file}${passed.size ? `?${passed}` : ""}`, { signal: AbortSignal.timeout(30_000) });
    } catch {
      res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "camera_unavailable" }));
      return;
    }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" });
    if (upstream.body) Readable.fromWeb(upstream.body as never).on("error", () => res.destroy()).pipe(res);
    else res.end();
  }

  /** A piece's playlist (see playlistOf); null for the piece still being written, which has no index yet. */
  async playlist(entity: string, piece: RecordingPiece): Promise<string | null> {
    const folder = this.#cameras[entity]?.recordings;
    if (!folder || !PIECE.test(piece.file)) throw new CameraError("not_found");
    const index = await this.#index(`/media/${folder}/${encodeURIComponent(piece.file)}`);
    return index && playlistOf(index, encodeURIComponent(piece.file), (piece.end - piece.start) / 1000);
  }

  /** One of a playlist's segments: the piece's bytes `from` to `to` (exclusive), made playable on their own. */
  async segment(entity: string, file: string, from: number, to: number): Promise<Buffer> {
    const folder = this.#cameras[entity]?.recordings;
    if (!folder || !PIECE.test(file) || !(from >= 0 && to > from && to - from <= MAX_SEGMENT_BYTES)) throw new CameraError("not_found");
    const body = await this.#range(`/media/${folder}/${encodeURIComponent(file)}`, `bytes=${from}-${to - 1}`).catch((err) => {
      throw err instanceof CameraError ? new CameraError("not_found") : err;
    });
    return segmentOf(body.bytes, from);
  }

  /** Relay a recording piece to a video element, with ranges so it can seek. */
  async proxyPiece(entity: string, file: string, range: string | undefined, res: http.ServerResponse): Promise<void> {
    const folder = this.#cameras[entity]?.recordings;
    if (!folder || !PIECE.test(file)) throw new CameraError("not_found");
    const upstream = await this.#rest(`/media/${folder}/${encodeURIComponent(file)}`, { headers: range && /^bytes=\d*-\d*$/.test(range) ? { range } : {} }, 60_000);
    if (upstream.status !== 200 && upstream.status !== 206) {
      await upstream.body?.cancel();
      throw new CameraError(upstream.status === 404 ? "not_found" : `Home Assistant answered ${upstream.status}`);
    }
    const headers: Record<string, string> = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, max-age=300" };
    for (const h of ["content-length", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (upstream.body) Readable.fromWeb(upstream.body as never).on("error", () => res.destroy()).pipe(res);
    else res.end();
  }

  // ------------------------------------------------------------ MCP tools

  async tool(name: string, args: Record<string, unknown>, username: string, files?: ClipTarget): Promise<ToolResult> {
    try {
      switch (name) {
        case "camera_recording_clip": return text(await this.#toolClip(args, username, files));
        case "camera_list": return text(await this.#toolList(username));
        case "camera_snapshot": return await this.#toolSnapshot(args, username);
        case "camera_ptz": return await this.#toolPtz(args, username);
        case "camera_recordings": return text(await this.#toolRecordings(args, username));
        case "camera_recording_frames": return await this.#toolFrames(args, username);
        default: return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof CameraError)) this.#log.warn("camera tool failed", { tool: name, error: message });
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  async #toolList(username: string): Promise<string> {
    const cameras = await this.list(username);
    if (!cameras.length) return "Home Assistant has no cameras.";
    const lines = await Promise.all(cameras.map(async (c) => {
      const can = [c.live ? "live video" : "snapshots only (no live video here)"];
      if (c.ptz) can.push("pan/tilt");
      if (c.recordings) {
        const pieces = await this.pieces(c.entity).catch(() => []);
        can.push(pieces.length ? `continuous recording ${formatLocal(pieces[0]!.start)} to ${formatLocal(pieces.at(-1)!.end)}` : "continuous recording (none yet)");
      }
      if (c.events) {
        const events = await this.events(c.entity).catch(() => []);
        const last = events.at(-1);
        can.push(`${events.length} event clips${last ? `, latest ${formatLocal(last.at)} ${last.label}` : ""}`);
      }
      return `- ${c.entity} "${c.name}" (${c.state}): ${can.join("; ")}`;
    }));
    return [`Cameras (now ${formatLocal(Date.now())}):`, ...lines, "", CARD_HINT].join("\n");
  }

  async #toolSnapshot(args: Record<string, unknown>, username: string): Promise<ToolResult> {
    const camera = await this.camera(args.camera, username);
    const shot = await this.snapshot(camera.entity);
    return image(shot, `${camera.name} at ${formatLocal(Date.now())}`);
  }

  async #toolPtz(args: Record<string, unknown>, username: string): Promise<ToolResult> {
    const camera = await this.camera(args.camera, username);
    const done = await this.ptz(camera.entity, args);
    // The picture after the motor stops (a tap turns for well under a second; a preset takes longer).
    await new Promise((r) => setTimeout(r, typeof args.preset === "string" && args.preset.trim() ? 4000 : 1500));
    const shot = await this.snapshot(camera.entity).catch(() => null);
    const note = `${camera.name} ${done}.`;
    return shot ? image(shot, `${note} The picture now (${formatLocal(Date.now())}):`) : text(`${note} The picture is not available right now.`);
  }

  async #toolRecordings(args: Record<string, unknown>, username: string): Promise<string> {
    const camera = await this.camera(args.camera, username);
    if (!camera.recordings && !camera.events) return `${camera.name} has no recordings here.`;
    const now = Date.now();
    const to = args.to === undefined ? now : parseLocal(args.to);
    const from = args.from === undefined ? (to ?? now) - 24 * 3600_000 : parseLocal(args.from);
    if (from === null || to === null) throw new CameraError("from/to must be local times like 2026-10-13 20:30:00");
    if (to <= from) throw new CameraError("to must be after from");
    const out: string[] = [`${camera.name}, ${formatLocal(from)} to ${formatLocal(to)}:`];
    if (camera.recordings) {
      const pieces = await this.pieces(camera.entity);
      if (!pieces.length) out.push("Continuous recording: none yet.");
      else {
        out.push(`Continuous recording kept: ${formatLocal(pieces[0]!.start)} to ${formatLocal(pieces.at(-1)!.end)} (older pieces are deleted as space runs out).`);
        const inRange = pieces.filter((p) => p.end > from && p.start < to);
        const gaps: string[] = [];
        let cursor = Math.max(from, pieces[0]!.start);
        for (const p of inRange) {
          if (p.start - cursor > 60_000) gaps.push(`${formatLocal(cursor)} to ${formatLocal(p.start)}`);
          cursor = Math.max(cursor, p.end);
        }
        if (Math.min(to, now) - cursor > 60_000) gaps.push(`${formatLocal(cursor)} to ${formatLocal(Math.min(to, now))}`);
        if (gaps.length) out.push(`Not recorded in this range: ${gaps.slice(0, 10).join("; ")}${gaps.length > 10 ? ` (+${gaps.length - 10} more)` : ""}.`);
      }
    }
    if (camera.events) {
      const label = typeof args.label === "string" ? args.label.trim() : "";
      const events = (await this.events(camera.entity)).filter((e) => e.at >= from && e.at <= to && (!label || e.label.includes(label)));
      const counts = new Map<string, number>();
      for (const e of events) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
      out.push(events.length ? `Events: ${events.length} (${[...counts].map(([l, n]) => `${l} ${n}`).join(", ")})` : "Events: none.");
      const shown = events.slice(-60);
      if (events.length > shown.length) out.push(`(the latest ${shown.length} shown; narrow the range for earlier ones)`);
      for (const e of shown) out.push(`- ${formatLocal(e.at)} ${e.label}`);
    }
    out.push("", "Event times are when the detection fired; the clip and the continuous recording start a few seconds earlier.");
    return out.join("\n");
  }

  async #toolClip(args: Record<string, unknown>, username: string, target: ClipTarget | undefined): Promise<string> {
    const camera = await this.camera(args.camera, username);
    if (!target) throw new CameraError("Clips cannot be saved here");
    if (!camera.recordings) throw new CameraError(`${camera.name} has no continuous recording`);
    const from = parseLocal(args.from);
    const to = parseLocal(args.to);
    if (from === null || to === null) throw new CameraError("from and to must be local times like 2026-11-03 11:55:30");
    if (to <= from) throw new CameraError("to must be after from");
    if (to - from > MAX_CLIP_SECONDS * 1000) throw new CameraError(`A clip is at most ${MAX_CLIP_SECONDS / 60} minutes; cut a longer stretch into several clips`);
    if (to > Date.now()) throw new CameraError(`${formatLocal(to)} has not happened yet (now ${formatLocal(Date.now())})`);
    const file = clipPath(args.path, target.workspace, camera.entity, from);
    const clip = await this.clip(camera.entity, from, to);
    await (await target.files()).write(file, clip.bytes);
    this.#log.info("recording clip saved", { entity: camera.entity, seconds: Math.round((clip.end - clip.start) / 1000), bytes: clip.bytes.length });
    const out = [
      `Clip saved: ${file}`,
      `${camera.name}, ${formatLocal(clip.start)} to ${formatLocal(clip.end)} (${Math.round((clip.end - clip.start) / 1000)} s, ${megabytes(clip.bytes.length)}, with sound if the camera recorded it).`,
    ];
    if (clip.start < from - 500) out.push(`It starts at the key frame ${((from - clip.start) / 1000).toFixed(1)} s before ${formatLocal(from)}.`);
    if (clip.gaps.length) out.push(`Not recorded, so not in the clip: ${clip.gaps.map(([a, b]) => `${formatLocal(a)} to ${formatLocal(b)}`).join("; ")}.`);
    out.push(`Put it in your reply as a link on a line of its own: [description](${file})`);
    return out.join("\n");
  }

  async #toolFrames(args: Record<string, unknown>, username: string): Promise<ToolResult> {
    const camera = await this.camera(args.camera, username);
    const at = parseLocal(args.at);
    if (at === null) throw new CameraError("at must be a local time like 2026-10-13 20:38:10");
    const count = args.count === undefined ? 1 : Number(args.count);
    const interval = args.interval_seconds === undefined ? 10 : Number(args.interval_seconds);
    if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) throw new CameraError(`count must be an integer from 1 to ${MAX_FRAMES}`);
    if (!Number.isInteger(interval) || interval < 1 || interval > 600) throw new CameraError("interval_seconds must be an integer from 1 to 600");
    const content: ToolResult["content"] = [];
    const failed: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const t = at + i * interval * 1000;
      if (t > Date.now()) break;
      try {
        const bytes = await this.frame(camera.entity, t);
        content.push({ type: "text", text: `${camera.name} at ${formatLocal(t)}:` }, { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" });
      } catch (err) {
        if (count === 1) throw err;
        failed.push(`${formatLocal(t)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!content.length) throw new CameraError(failed[0] ?? `No pictures: ${formatLocal(at)} is in the future`);
    if (failed.length) content.push({ type: "text", text: `Missing: ${failed.join("; ")}` });
    content.push({ type: "text", text: `To let the user watch from there, put this card in your reply:\n\`\`\`camera\n{"camera": "${camera.entity}", "at": "${formatLocal(at)}"}\n\`\`\`` });
    return { content };
  }
}

/** Where a clip is saved: the account's workspace. */
export interface ClipTarget {
  workspace: string;
  files: () => Promise<ClipFiles>;
}

function clipPath(raw: unknown, workspace: string, entity: string, at: number): string {
  const root = workspace.replace(/\/$/, "");
  if (raw === undefined || raw === null || raw === "") {
    return `${root}/camera/${entity.replace(/^camera\./, "")}-${formatLocal(at).replace(/-/g, "").replace(" ", "-").replace(/:/g, "")}.mp4`;
  }
  const checked = requireWorkspaceFilePath(String(raw), root);
  if (!checked.ok) throw new CameraError(`path: ${checked.message}`);
  if (!/\.mp4$/i.test(checked.path)) throw new CameraError("path must end in .mp4");
  return checked.path;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function image(shot: { bytes: Buffer; contentType: string }, caption: string): ToolResult {
  return { content: [{ type: "text", text: caption }, { type: "image", data: shot.bytes.toString("base64"), mimeType: shot.contentType.split(";")[0]!.trim() || "image/jpeg" }] };
}
