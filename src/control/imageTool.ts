import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { AppContext } from "./context.js";
import type { Logger } from "../common/logger.js";
import type { Analytics } from "./analytics.js";
import type { HostTokenSource } from "./codex/hostTokens.js";
import { requireWorkspaceFilePath } from "./documents/paths.js";

/**
 * The image tool: picture generation for every account, offered to its executors
 * as one MCP server on the member gateway. The control plane makes the picture with
 * its own ChatGPT login (the request a Codex `imagegen` call makes) and saves it in
 * the account's workspace; the login never reaches a sandbox. Each runtime gets its
 * own capability URL (`/image/<token>/mcp`), which reaches only that account's files.
 */

/** GPT Image 2.6 Sunburst (OpenAI's 2.6 for detailed visual work and precise edits). */
const IMAGE_MODEL = "gpt-image-2.6-sunburst";
/** GPT Image 2.6 Flare: the faster sibling, for drafts and simple pictures. */
const FAST_MODEL = "gpt-image-2.6-flare";
/** Used only when the endpoint refuses IMAGE_MODEL itself (the ChatGPT backend may not offer 2.6 yet). */
const FALLBACK_MODEL = "gpt-image-2";
/** The public Images API: animated GIFs and SVGs, which the ChatGPT login's endpoint refuses ("GIF output is not enabled") or returns as PNG. */
const OPENAI_API_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 300_000;
const MAX_REFERENCES = 5;
const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"];
const QUALITIES = ["auto", "low", "medium", "high"];
/** How much the model plans before drawing (2.6); the API's default is high. */
const COMPLEXITIES = ["low", "medium", "high"];
/** Animated GIFs (GPT Image 2.6 only, generations only): frames and per-frame duration as the API allows. */
const FRAMES = { min: 2, max: 64 };
const FRAME_MS = { min: 20, max: 2000 };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TOOLS = [
  {
    name: "image_generate",
    description:
      "Generate a new image, or edit or extend one based on reference images (photos, illustrations, posters, avatars, product renderings, stickers, and other raster images), save it to the workspace, and return its path. " +
      "To edit or reference existing images, put their paths in reference_paths (png/jpg/webp in the workspace, at most 5). " +
      "To change only one part of the first reference image, also give markup_path: a transparent PNG of the same size with circles or boxes around that part (for a real photo the aio-photo skill's markup command makes it), and say in the prompt what to change inside the marks, what stays, and to remove the marks. " +
      "Each call makes one image and usually takes a minute or two; call it separately for each different image you need. " +
      "For an animated GIF (a moving sticker or emoji, a short looping animation), set animated to true and path to a .gif: one call makes the whole animation from the prompt (not from reference images). " +
      "For a logo, an icon or a flat illustration that should stay editable, set svg to true and path to a .svg: a vector drawing from the prompt (not from reference images). " +
      "Not for images that are mainly text or layout (tables, schedules, plans, checklists, menus, infographics): build those as HTML and render them with the aio-graphic skill, and never use this tool to change their text; use it only for the illustrations they contain. " +
      "Never use it to retouch a real photo of people (light, color, skin softening, a studio look, the background smoothed or replaced): it redraws the faces; follow the aio-photo skill, which keeps the people as photographed. " +
      "A content change to a real photo (remove a passer-by or an object, a new sky, change one thing) goes through the aio-photo skill too: its markup command, this tool with markup_path, then its merge command, which keeps every other pixel of the original.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw: subject, scene, style, composition, lighting, colors; put any text that should appear in the image verbatim in quotes. When editing an image, say clearly what to change and what to keep the same" },
        path: { type: "string", description: "Where to save it: an absolute .png path (.gif when animated, .svg when svg) in the workspace, inside this task's folder, e.g. /home/gem/workspace/tasks/<task id>/poster.png; if omitted, it is saved in /home/gem/workspace/images/" },
        reference_paths: { type: "array", items: { type: "string" }, description: "Paths of images to edit or reference (optional)" },
        markup_path: { type: "string", description: "A transparent PNG the size of the first reference image whose circles, boxes or sketches mark the only part to change (optional; needs reference_paths)" },
        complexity: { type: "string", enum: COMPLEXITIES, description: "How much the model plans before drawing: low for a focused edit (one object, a background, a sign; it also changes the least around it), high (the default) for dense text, complex layouts and many related objects" },
        fast: { type: "boolean", description: "true for the faster model (drafts, quick variations, simple pictures); default false: the detailed one, best for precise edits" },
        transparent_background: { type: "boolean", description: "true when a transparent background is needed (stickers, cutouts, icons)" },
        size: { type: "string", enum: SIZES, description: "Canvas: auto chooses automatically; 1024x1024 square; 1536x1024 landscape; 1024x1536 portrait" },
        quality: { type: "string", enum: QUALITIES, description: "Default auto" },
        animated: { type: "boolean", description: "true for an animated GIF; describe the subject, the motion and how it loops in the prompt. Cannot be combined with reference_paths or transparent_background" },
        frame_count: { type: "integer", minimum: FRAMES.min, maximum: FRAMES.max, description: "Animated GIF only: number of frames, default 9" },
        frame_duration_ms: { type: "integer", minimum: FRAME_MS.min, maximum: FRAME_MS.max, description: "Animated GIF only: milliseconds per frame, default 200" },
        svg: { type: "boolean", description: "true for an editable vector SVG (a logo, an icon, a flat illustration), path ending in .svg. Cannot be combined with reference_paths, animated or transparent_background" },
      },
      required: ["prompt"],
    },
  },
];

/** Thread-level MCP wiring for a Codex executor. */
export function imageThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.image ? { aio_image: { url: cfg.image.url, tool_timeout_sec: TIMEOUT_MS / 1000 + 30 } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function imageMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.image ? { aio_image: { type: "http", url: cfg.image.url } } : {};
}

export const IMAGE_POLICY =
  "When the user wants an image (photos, illustrations, posters, avatars, product renderings, stickers, and other raster images), or wants an image edited or extended, generate it with image_generate from aio_image, with path set to a .png in this task's folder; after it is generated, show it directly in your reply with ![description](path). " +
  "To change one part of an image and keep the rest, give markup_path (a transparent PNG of the same size with the part circled) and complexity low, and say in the prompt what to change inside the marks, what stays the same, and to remove the marks. Set fast for quick drafts or several variations to choose from; keep the default for the final picture and for precise edits. " +
  "A logo, an icon or a flat illustration the user may want to edit or scale: svg true with a .svg path. " +
  "When the user wants an animated picture (a GIF, a moving sticker or emoji, a short looping animation), make it in one image_generate call with animated set to true and path set to a .gif in this task's folder, describing the subject, the motion and how it loops in the prompt (frame_count 2-64, default 9; frame_duration_ms per frame, default 200); show it the same way. " +
  "An image that is mainly text or layout (tables, schedules, meal or study plans, checklists, menus, infographics, text-heavy posters) is never drawn or edited with image_generate, which redraws every pixel and garbles text a little more on each edit: build it as HTML and render it to PNG with the aio-graphic skill, change it by editing that HTML, and use image_generate only for the illustrations placed in it. " +
  "A real photo of people that the user wants retouched (light and color, skin softening, a studio look, a smoother or new background) is never redrawn with image_generate, which turns the faces into someone similar and leaves patches of color with each further edit: follow the aio-photo skill, which keeps the people's original pixels, always works from the original and checks the faces before delivery. " +
  "A content change to a real photo (remove a passer-by or a thing, a stain, a scratch or a flaw retouching leaves, a new sky, add or change an object, open closed eyes, change clothes) follows the aio-photo skill too: its markup command marks the part, image_generate changes it, and its merge command takes only that part onto the original. " +
  "Do not hold back from image_generate on a photo: whatever retouching cannot fix (anything that has to be added, removed or redrawn rather than made lighter, softer or another color) goes to image_generate in the first attempt, never declined, worked around with retouch options or left for the user to point out again. " +
  "When the user asks for a change to the whole photo (a new scene or background behind people that the cut-out cannot do, a new pose or outfit, someone added, a style), image_generate the photo itself with it as the reference, deliver that and say the people are AI-redrawn. " +
  "Flowcharts are better written as a mermaid code block; charts of data (K-lines, trends, bars, pies) as a chart code block, which the console draws from the numbers; other line drawings such as diagrams directly as an svg code block.";

/** Reading and saving pictures in one account's workspace. */
export interface ImageFiles {
  /** A workspace picture, as checked image bytes. */
  read(path: string): Promise<{ bytes: Buffer; contentType: string }>;
  /** Save picture bytes at a workspace path, creating its folder. */
  write(path: string, bytes: Buffer): Promise<void>;
}

/** An account's workspace, reached through its own sandbox. */
export function sandboxImageFiles(ctx: Pick<AppContext, "documents" | "container">): ImageFiles {
  return {
    read: (file) => ctx.documents.image(file),
    async write(file, bytes) {
      const mkdir = await ctx.container.execInSandbox(["mkdir", "-p", "--", path.posix.dirname(file)], { timeoutMs: 30_000 });
      if (mkdir.code !== 0) throw new Error(`Failed to create the folder: ${mkdir.stderr.trim().slice(0, 200)}`);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), path.posix.basename(file));
      form.append("path", file);
      const res = await ctx.container.fetch("/v1/file/upload", { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || json.success === false) throw new Error(`Failed to save the image: ${json.message ?? res.status}`);
    },
  };
}

class ImageError extends Error {}

export class ImageGateway {
  #port: number;
  #log: Logger;
  #hostTokens: Pick<HostTokenSource, "getTokens" | "invalidate">;
  #chatgptUrl: string;
  #openai: { url: string; key: string } | null;
  #workspace: string;
  #filesFor: (userId: string) => Promise<ImageFiles>;
  #tokens = new Map<string, string>();
  #analytics: Pick<Analytics, "track"> | undefined;

  constructor(opts: {
    port: number;
    log: Logger;
    hostTokens: Pick<HostTokenSource, "getTokens" | "invalidate">;
    chatgptUrl: string;
    /** An OpenAI API key for animated GIFs; without one, asking for a GIF says it is not available. */
    openaiApiKey?: string;
    openaiUrl?: string;
    workspace: string;
    filesFor: (userId: string) => Promise<ImageFiles>;
    analytics?: Pick<Analytics, "track">;
  }) {
    this.#port = opts.port;
    this.#log = opts.log.child("image-tool");
    this.#hostTokens = opts.hostTokens;
    this.#chatgptUrl = opts.chatgptUrl.replace(/\/$/, "");
    this.#openai = opts.openaiApiKey ? { url: (opts.openaiUrl ?? OPENAI_API_URL).replace(/\/$/, ""), key: opts.openaiApiKey } : null;
    this.#workspace = opts.workspace.replace(/\/$/, "");
    this.#filesFor = opts.filesFor;
    this.#analytics = opts.analytics;
  }

  /** Give a runtime its image-tool URL. */
  provision(cfg: Config): void {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(cfg.dataDir, "image-token");
    let token: string;
    try {
      token = fs.readFileSync(file, "utf8").trim();
    } catch {
      token = randomBytes(32).toString("hex");
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    }
    this.#tokens.set(token, cfg.runtimeUserId!);
    cfg.image = { url: `http://host.docker.internal:${this.#port}/image/${token}/mcp` };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/image\/([a-f0-9]{64})\/mcp$/.exec(req.url ?? "");
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
        if (size > 256 * 1024) return send(413, { error: "too large" });
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
          serverInfo: { name: "aio_image", version: "1" },
          instructions: IMAGE_POLICY,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(params?.name);
        if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
        return reply(await this.#generate(userId, (params?.arguments ?? {}) as Record<string, unknown>));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
    }
  }

  async #generate(userId: string, args: Record<string, unknown>): Promise<unknown> {
    const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
    const started = Date.now();
    try {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) throw new ImageError("Missing prompt: say clearly what to draw");
      const animated = args.animated === true;
      const svg = args.svg === true;
      if (animated && svg) throw new ImageError("Choose one of animated (a GIF) and svg (a vector drawing)");
      const target = this.#target(args.path, animated ? "gif" : svg ? "svg" : "png");
      const refs = Array.isArray(args.reference_paths) ? args.reference_paths : [];
      if (refs.length > MAX_REFERENCES) throw new ImageError(`reference_paths allows at most ${MAX_REFERENCES} images`);
      const markup = typeof args.markup_path === "string" && args.markup_path ? args.markup_path : null;
      if (markup && !refs.length) throw new ImageError("markup_path marks a part of the first reference image: put that image in reference_paths");
      if (svg && (refs.length || args.transparent_background === true)) throw new ImageError("An SVG is drawn from the prompt only, without reference images or a transparent background setting");
      if (args.complexity !== undefined && args.complexity !== null && !COMPLEXITIES.includes(String(args.complexity))) throw new ImageError(`complexity must be one of ${COMPLEXITIES.join(", ")}`);
      const gif: Record<string, number> = {};
      if (animated) {
        if (refs.length) throw new ImageError("An animated GIF is made from the prompt only: remove reference_paths and describe the picture instead");
        if (args.transparent_background === true) throw new ImageError("An animated GIF cannot have a transparent background");
        for (const [key, range] of [["frame_count", FRAMES], ["frame_duration_ms", FRAME_MS]] as const) {
          if (args[key] === undefined || args[key] === null) continue;
          const value = Number(args[key]);
          if (!Number.isInteger(value) || value < range.min || value > range.max) throw new ImageError(`${key} must be a whole number from ${range.min} to ${range.max}`);
          gif[key] = value;
        }
      } else if (args.frame_count !== undefined || args.frame_duration_ms !== undefined) {
        throw new ImageError("frame_count and frame_duration_ms are only for an animated GIF: set animated to true");
      }
      const size = SIZES.includes(String(args.size)) ? String(args.size) : "auto";
      const quality = QUALITIES.includes(String(args.quality)) ? String(args.quality) : "auto";
      const files = await this.#filesFor(userId);
      const images: Array<{ image_url: string }> = [];
      for (const ref of refs) {
        const checked = requireWorkspaceFilePath(String(ref), this.#workspace);
        if (!checked.ok) throw new ImageError(`Reference image ${String(ref)}: ${checked.message}`);
        const { bytes, contentType } = await files.read(checked.path);
        if (contentType === "image/svg+xml") throw new ImageError(`Reference image ${checked.path} is an SVG; convert it to png first`);
        images.push({ image_url: `data:${contentType};base64,${bytes.toString("base64")}` });
      }
      let layer: { image_url: string } | null = null;
      if (markup) {
        const checked = requireWorkspaceFilePath(markup, this.#workspace);
        if (!checked.ok) throw new ImageError(`markup_path: ${checked.message}`);
        const { bytes, contentType } = await files.read(checked.path);
        if (contentType !== "image/png") throw new ImageError("markup_path must be a transparent PNG (the marks on transparent pixels)");
        layer = { image_url: `data:image/png;base64,${bytes.toString("base64")}` };
      }
      const picture = await this.#request(images.length ? "edits" : "generations", {
        ...(images.length ? { images } : {}),
        ...(layer ? { markup: layer } : {}),
        prompt,
        // GIF and SVG requests carry only the fields the API documents for them.
        ...(animated || svg ? {} : { background: args.transparent_background === true ? "transparent" : "opaque" }),
        model: args.fast === true ? FAST_MODEL : IMAGE_MODEL,
        quality,
        ...(svg ? { n: 1 } : { size }),
        ...(args.complexity ? { complexity: String(args.complexity) } : {}),
        ...(animated ? { output_format: "gif", ...gif } : svg ? { output_format: "svg" } : {}),
      });
      await files.write(target, picture);
      this.#log.info("image generated", { userId, edit: images.length > 0, markup: layer !== null, animated, svg, fast: args.fast === true, bytes: picture.length, ms: Date.now() - started });
      this.#analytics?.track("image_generate", { userId, props: { via: "agent", ok: true, animated, svg, markup: layer !== null, edit: images.length > 0, seconds: Math.round((Date.now() - started) / 1000) } });
      return text(`${animated ? "Animated GIF" : svg ? "SVG" : "Image"} saved: ${target}\nShow it in your reply with ![description](${target}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ImageError)) this.#log.warn("image generation failed", { userId, error: message, ms: Date.now() - started });
      // Only a generation that failed upstream: a request the tool refused is the executor's mistake, not the feature failing.
      if (!(err instanceof ImageError)) this.#analytics?.track("image_generate", { userId, props: { via: "agent", ok: false, animated: args.animated === true } });
      return text(message, true);
    }
  }

  /** Where the picture goes: a .png (.gif, .svg) the executor named inside the workspace, or a fresh one. */
  #target(raw: unknown, ext: "png" | "gif" | "svg"): string {
    if (raw === undefined || raw === null || raw === "") {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      return `${this.#workspace}/images/${stamp}-${randomUUID().slice(0, 6)}.${ext}`;
    }
    const checked = requireWorkspaceFilePath(String(raw), this.#workspace);
    if (!checked.ok) throw new ImageError(`path: ${checked.message}`);
    if (!checked.path.toLowerCase().endsWith(`.${ext}`)) {
      throw new ImageError(ext === "gif" ? "path must end in .gif (an animated image is a GIF)" : ext === "svg" ? "path must end in .svg (a vector drawing is an SVG)" : "path must end in .png (the generated image is a PNG; set animated to true for a .gif, svg to true for a .svg)");
    }
    return checked.path;
  }

  /** One request to the ChatGPT images endpoint, with the control plane's own login. */
  async #request(kind: "generations" | "edits", body: Record<string, unknown>): Promise<Buffer> {
    if (body.output_format === "gif" || body.output_format === "svg") return this.#api(body);
    const tokens = await this.#hostTokens.getTokens();
    const post = (payload: Record<string, unknown>) =>
      fetch(`${this.#chatgptUrl}/images/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": tokens.chatgptAccountId },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    const detailOf = async (r: Response) => (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    let res = await post(body);
    if (res.status === 401) this.#hostTokens.invalidate();
    if (!res.ok) {
      let detail = await detailOf(res);
      // The endpoint does not know the model (not a refused prompt): draw with the previous one.
      const modelRefused = (res.status === 400 || res.status === 404) && (detail.includes(String(body.model)) || /"param"\s*:\s*"model"/.test(detail));
      if (modelRefused && body.model !== FALLBACK_MODEL) {
        this.#log.warn("image model refused, falling back", { model: body.model, fallback: FALLBACK_MODEL, status: res.status, detail });
        res = await post({ ...body, model: FALLBACK_MODEL });
        if (res.status === 401) this.#hostTokens.invalidate();
        if (!res.ok) detail = await detailOf(res);
      }
      if (!res.ok) {
        if (res.status === 429) throw new Error(`The image generation quota is used up for now or requests are too frequent; try again later (${detail})`);
        if (res.status === 400) throw new ImageError(`The image request was refused, possibly because the content does not meet the requirements; try a different description (${detail})`);
        throw new Error(`The image service returned ${res.status} (${detail})`);
      }
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const picture = Buffer.from(json.data?.[0]?.b64_json ?? "", "base64");
    // Only PNG bytes are saved under a .png name.
    if (!picture.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("The image service did not return a PNG image");
    return picture;
  }

  /** An animated GIF or an SVG from the public Images API, with the deployment's OpenAI key (no fallback: only 2.6 makes them). */
  async #api(body: Record<string, unknown>): Promise<Buffer> {
    const svg = body.output_format === "svg";
    const what = svg ? "SVG" : "animated GIF";
    if (!this.#openai) throw new ImageError(`${svg ? "SVGs" : "Animated GIFs"} are not available on this server; make a still image instead`);
    const res = await fetch(`${this.#openai.url}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#openai.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      if (res.status === 429) throw new Error(`The ${what} quota is used up for now or requests are too frequent; try again later (${detail})`);
      if (res.status === 400) throw new ImageError(`The ${what} request was refused; try a different description${svg ? "" : " or fewer, smaller frames"} (${detail})`);
      throw new Error(`The image service returned ${res.status} (${detail})`);
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const picture = Buffer.from(json.data?.[0]?.b64_json ?? "", "base64");
    // Only GIF bytes are saved under a .gif name, only an SVG document under a .svg name.
    if (svg ? !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(picture.subarray(0, 512).toString("utf8")) : !/^GIF8[79]a$/.test(picture.subarray(0, 6).toString("latin1"))) {
      throw new Error(`The image service did not return ${svg ? "an SVG" : "a GIF image"}`);
    }
    return picture;
  }
}
