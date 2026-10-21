import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { AppContext } from "./context.js";
import type { Logger } from "../common/logger.js";
import { requireWorkspaceFilePath } from "./documents/paths.js";

/**
 * Text to speech for every account, offered to its executors as one MCP server on
 * the member gateway. One speech server on the home network (`PA_TTS_URL`, the
 * Qwen3-TTS engine's `POST /v1/tts`: JSON `{text, speaker, language}` in, a 16-bit
 * mono WAV out) speaks for every sandbox; the control plane calls it and saves the
 * WAV in the account's workspace, so sandboxes never reach it themselves. The server
 * runs on CPU, slower than real time, so it speaks for one request at a time and
 * long text goes to it a few sentences at a time.
 */

const TIMEOUT_MS = 1_200_000;
/** One request to the speech server: a chunk of CHUNK_CHARS. */
const CHUNK_TIMEOUT_MS = 300_000;
const MAX_CHARS = 1_500;
const CHUNK_CHARS = 120;

/** The model's preset voices (Qwen3-TTS CustomVoice), each best in its own language. */
const VOICES: Record<string, string> = {
  vivian: "bright young woman, Chinese",
  serena: "warm, gentle young woman, Chinese",
  uncle_fu: "seasoned man with a low, mellow voice, Chinese",
  dylan: "young man from Beijing, Chinese with a Beijing accent",
  eric: "lively man from Chengdu, Chinese with a slight Sichuan accent",
  ryan: "dynamic man, English",
  aiden: "sunny American man, English",
  ono_anna: "playful young woman, Japanese",
  sohee: "warm young woman, Korean",
};
const LANGUAGES = ["Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"];
const DEFAULT_VOICE: Record<string, string> = { Chinese: "vivian", Japanese: "ono_anna", Korean: "sohee" };

const TOOLS = [
  {
    name: "text_to_speech",
    description:
      "Read text aloud: synthesize it as speech (a 24 kHz mono WAV), save it to the workspace, and return its path. " +
      `Up to ${MAX_CHARS} characters per call; synthesis is slower than real time (about a minute and a half per minute of speech), and requests from everyone wait their turn. ` +
      "Pass the words exactly as they should be spoken: no Markdown, links, or emoji; write out numbers, units, and abbreviations the way they should be read when that matters. " +
      "Square brackets are control tags ([pause:500ms] inserts a pause), so leave out any other bracketed text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to say" },
        path: { type: "string", description: "Where to save it: an absolute .wav path in the workspace, inside this task's folder, e.g. /home/gem/workspace/tasks/<task id>/reading.wav; if omitted, it is saved in /home/gem/workspace/audio/" },
        voice: { type: "string", enum: Object.keys(VOICES), description: `The voice: ${Object.entries(VOICES).map(([name, what]) => `${name} (${what})`).join("; ")}. Default: vivian for Chinese, ryan for English, ono_anna for Japanese, sohee for Korean` },
        language: { type: "string", enum: LANGUAGES, description: "The language of the text; detected from the text if omitted (Chinese when it has Chinese characters, otherwise English)" },
      },
      required: ["text"],
    },
  },
];

/** Thread-level MCP wiring for a Codex executor. */
export function ttsThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.tts ? { aio_tts: { url: cfg.tts.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 30 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function ttsMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.tts ? { aio_tts: { type: "http", url: cfg.tts.url } } : {};
}

export const TTS_POLICY =
  "Text to speech is available (aio_tts): when the user wants something read aloud or wants an audio or voice version of text (a story, an article, a message, a pronunciation, a podcast script), make it with text_to_speech, with path set to a .wav in this task's folder; do not install or call other speech engines or online TTS services. " +
  "Then put the file in your reply as a link on a line of its own, [description](path), which the console shows as a player. " +
  "Longer text than one call takes: make several files in order and join them with ffmpeg in the sandbox; convert to mp3 there too when the user wants a smaller file. " +
  "Speech takes a while to make (about a minute and a half per minute of audio, and Chinese is read at roughly 4 to 5 characters a second), so for long text tell the user first how long it will be.";

/** Saving audio in one account's workspace. */
export interface SpeechFiles {
  write(path: string, bytes: Buffer): Promise<void>;
}

/** An account's workspace, reached through its own sandbox. */
export function sandboxSpeechFiles(ctx: Pick<AppContext, "container">): SpeechFiles {
  return {
    async write(file, bytes) {
      const mkdir = await ctx.container.execInSandbox(["mkdir", "-p", "--", path.posix.dirname(file)], { timeoutMs: 30_000 });
      if (mkdir.code !== 0) throw new Error(`Failed to create the folder: ${mkdir.stderr.trim().slice(0, 200)}`);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), path.posix.basename(file));
      form.append("path", file);
      const res = await ctx.container.fetch("/v1/file/upload", { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || json.success === false) throw new Error(`Failed to save the audio: ${json.message ?? res.status}`);
    },
  };
}

class SpeechError extends Error {}

/** The language to speak text in when the executor does not say. */
export function detectLanguage(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "Japanese";
  if (/[가-힯]/.test(text)) return "Korean";
  if (/[㐀-鿿]/.test(text)) return "Chinese";
  return "English";
}

/** Text in pieces of at most `max` characters, cut after sentences where it can be. */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  for (const sentence of text.split(/(?<=[。！？!?；;\n]|\.(?=\s))/)) {
    // A sentence longer than a chunk is cut after its commas, and then anywhere.
    for (const part of sentence.length > max ? sentence.split(/(?<=[，,、：:])/) : [sentence]) {
      for (let i = 0; i < part.length; i += max) pieces.push(part.slice(i, i + max));
    }
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last]!.length + piece.length <= max) chunks[last] += piece;
    else chunks.push(piece);
  }
  return chunks.map((c) => c.trim()).filter((c) => /[\p{L}\p{N}]/u.test(c));
}

interface Pcm { rate: number; samples: Buffer }

/** The samples of a 16-bit mono PCM WAV. */
export function readWav(bytes: Buffer): Pcm {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("The speech server did not return a WAV file");
  let rate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") {
      if (bytes.readUInt16LE(at + 8) !== 1 || bytes.readUInt16LE(at + 10) !== 1 || bytes.readUInt16LE(at + 22) !== 16) throw new Error("The speech server returned audio that is not 16-bit mono PCM");
      rate = bytes.readUInt32LE(at + 12);
    } else if (id === "data") {
      if (!rate) break;
      // A streamed WAV may not know its length: the data runs to the end.
      return { rate, samples: bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("The speech server returned a WAV file without audio");
}

/** One 16-bit mono PCM WAV of the samples. */
export function writeWav(pcm: Pcm): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.samples.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(pcm.rate, 24);
  head.writeUInt32LE(pcm.rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.samples.length, 40);
  return Buffer.concat([head, pcm.samples]);
}

export class TtsGateway {
  #port: number;
  #log: Logger;
  #speechUrl: string;
  #workspace: string;
  #filesFor: (userId: string) => Promise<SpeechFiles>;
  #tokens = new Map<string, string>();
  /** One synthesis at a time: the speech server shares one CPU among all of them. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    port: number;
    log: Logger;
    speechUrl: string;
    workspace: string;
    filesFor: (userId: string) => Promise<SpeechFiles>;
  }) {
    this.#port = opts.port;
    this.#log = opts.log.child("tts-tool");
    this.#speechUrl = opts.speechUrl;
    this.#workspace = opts.workspace.replace(/\/$/, "");
    this.#filesFor = opts.filesFor;
  }

  /** Give a runtime its text-to-speech URL. */
  provision(cfg: Config): void {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "tts-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, cfg.runtimeUserId!);
    cfg.tts = { url: `http://host.docker.internal:${this.#port}/tts/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/tts\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
    const userId = match ? this.#tokens.get(match[1]!) : undefined;
    if (!userId) return send(403, { error: "forbidden" });
    if (req.method === "DELETE") return send(200, {});
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 64 * 1024) return send(413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, { error: "bad request" });
    }
    const headers: Record<string, string> = {};
    if (!Array.isArray(body) && (body as { method?: string })?.method === "initialize") headers["mcp-session-id"] = randomUUID();
    const messages = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(messages.map((m) => this.#rpc(userId, m)))).filter(Boolean);
    if (!out.length) return send(202, undefined, headers);
    return send(200, Array.isArray(body) ? out : out[0], headers);
  }

  async #rpc(userId: string, message: unknown): Promise<unknown> {
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: Record<string, unknown> };
    if (id === undefined || id === null) return null; // a notification
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: (params?.protocolVersion as string) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "aio_tts", version: "1" },
          instructions: TTS_POLICY,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(params?.name);
        if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
        return reply(await this.#speak(userId, (params?.arguments ?? {}) as Record<string, unknown>));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
    }
  }

  async #speak(userId: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
    const started = Date.now();
    try {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) throw new SpeechError("Missing text: pass the words to say");
      if (text.length > MAX_CHARS) throw new SpeechError(`text is ${text.length} characters; at most ${MAX_CHARS} per call. Split it into several calls and join the files with ffmpeg`);
      const chunks = chunkText(text);
      if (!chunks.length) throw new SpeechError("text has nothing to say (no letters or digits)");
      const target = this.#target(args.path);
      const language = args.language === undefined || args.language === "" ? detectLanguage(text) : String(args.language);
      if (!LANGUAGES.includes(language)) throw new SpeechError(`language must be one of ${LANGUAGES.join(", ")}`);
      const voice = args.voice === undefined || args.voice === "" ? DEFAULT_VOICE[language] ?? "ryan" : String(args.voice);
      if (!(voice in VOICES)) throw new SpeechError(`voice must be one of ${Object.keys(VOICES).join(", ")}`);
      const files = await this.#filesFor(userId);

      const job = this.#queue.then(async () => {
        const waited = Date.now() - started;
        const parts: Pcm[] = [];
        for (const chunk of chunks) parts.push(readWav(await this.#request({ text: chunk, speaker: voice, language })));
        if (parts.some((p) => p.rate !== parts[0]!.rate)) throw new Error("The speech server returned parts at different sample rates");
        return { pcm: { rate: parts[0]!.rate, samples: Buffer.concat(parts.map((p) => p.samples)) }, waited };
      });
      this.#queue = job.catch(() => undefined);
      const { pcm, waited } = await job;
      const wav = writeWav(pcm);
      await files.write(target, wav);
      const seconds = pcm.samples.length / 2 / pcm.rate;
      this.#log.info("speech made", { userId, chars: text.length, chunks: chunks.length, voice, language, seconds: Math.round(seconds), waitedMs: waited, ms: Date.now() - started });
      return reply(`Speech saved: ${target} (${seconds.toFixed(1)} s, voice ${voice}, ${language})\nPut it in your reply as a link on a line of its own: [description](${target})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof SpeechError)) this.#log.warn("speech failed", { userId, error: message, ms: Date.now() - started });
      return reply(message, true);
    }
  }

  /** Where the audio goes: a .wav the executor named inside the workspace, or a fresh one. */
  #target(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      return `${this.#workspace}/audio/${stamp}-${randomUUID().slice(0, 6)}.wav`;
    }
    const checked = requireWorkspaceFilePath(String(raw), this.#workspace);
    if (!checked.ok) throw new SpeechError(`path: ${checked.message}`);
    if (!/\.wav$/i.test(checked.path)) throw new SpeechError("path must end in .wav (the speech is a WAV file); convert it with ffmpeg afterwards for another format");
    return checked.path;
  }

  /** One request to the speech server. */
  async #request(body: { text: string; speaker: string; language: string }): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(this.#speechUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`The speech server cannot be reached (${err instanceof Error ? err.message : String(err)}); it may be down`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      if (res.status === 400) throw new SpeechError(`The speech server refused the text (${detail})`);
      throw new Error(`The speech server returned ${res.status} (${detail})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
