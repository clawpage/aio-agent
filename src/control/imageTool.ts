import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { AppContext } from "./context.js";
import type { Logger } from "../common/logger.js";
import type { HostTokenSource } from "./codex/hostTokens.js";
import { requireWorkspaceFilePath } from "./documents/paths.js";

/**
 * The image tool: picture generation for every account, offered to its executors
 * as one MCP server on the member gateway. The control plane makes the picture with
 * its own ChatGPT login (the request a Codex `imagegen` call makes) and saves it in
 * the account's workspace; the login never reaches a sandbox. Each runtime gets its
 * own capability URL (`/image/<token>/mcp`), which reaches only that account's files.
 */

const IMAGE_MODEL = "gpt-image-2";
const TIMEOUT_MS = 300_000;
const MAX_REFERENCES = 5;
const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"];
const QUALITIES = ["auto", "low", "medium", "high"];

const TOOLS = [
  {
    name: "image_generate",
    description:
      "生成一张新图片，或按参考图修改、延展（照片、插画、海报、头像、商品效果图、贴纸等位图），保存到工作区并返回路径。" +
      "要修改或参照已有图片时把它们的路径放进 reference_paths（工作区里的 png/jpg/webp，最多 5 张）。" +
      "一次调用出一张图，通常要一两分钟；要几张不同的图就分别调用。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "要画什么：主体、场景、风格、构图、光线、颜色；图里要出现的文字原样写在引号里。修改图片时写清楚改什么、哪些保持不变" },
        path: { type: "string", description: "保存位置：工作区里的 .png 绝对路径，放在本任务目录下，例如 /home/gem/workspace/tasks/<任务 id>/海报.png；不填就存进 /home/gem/workspace/images/" },
        reference_paths: { type: "array", items: { type: "string" }, description: "要修改或参照的图片路径（可选）" },
        transparent_background: { type: "boolean", description: "要透明背景（贴纸、抠图、图标）时为 true" },
        size: { type: "string", enum: SIZES, description: "画幅：auto 自动；1024x1024 方图；1536x1024 横图；1024x1536 竖图" },
        quality: { type: "string", enum: QUALITIES, description: "默认 auto" },
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
  "用户要图片（照片、插画、海报、头像、商品效果图、贴纸等位图），或要修改、延展一张图片时，用 aio_image 的 image_generate 生成，path 填本任务目录下的 .png；生成后在回复里用 ![说明](路径) 直接显示。示意图、流程图、图表这类线条图更适合直接写成 svg 代码块。";

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
      if (mkdir.code !== 0) throw new Error(`创建目录失败：${mkdir.stderr.trim().slice(0, 200)}`);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), path.posix.basename(file));
      form.append("path", file);
      const res = await ctx.container.fetch("/v1/file/upload", { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || json.success === false) throw new Error(`保存图片失败：${json.message ?? res.status}`);
    },
  };
}

class ImageError extends Error {}

export class ImageGateway {
  #port: number;
  #log: Logger;
  #hostTokens: Pick<HostTokenSource, "getTokens" | "invalidate">;
  #chatgptUrl: string;
  #workspace: string;
  #filesFor: (userId: string) => Promise<ImageFiles>;
  #tokens = new Map<string, string>();

  constructor(opts: {
    port: number;
    log: Logger;
    hostTokens: Pick<HostTokenSource, "getTokens" | "invalidate">;
    chatgptUrl: string;
    workspace: string;
    filesFor: (userId: string) => Promise<ImageFiles>;
  }) {
    this.#port = opts.port;
    this.#log = opts.log.child("image-tool");
    this.#hostTokens = opts.hostTokens;
    this.#chatgptUrl = opts.chatgptUrl.replace(/\/$/, "");
    this.#workspace = opts.workspace.replace(/\/$/, "");
    this.#filesFor = opts.filesFor;
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
      if (!prompt) throw new ImageError("缺少 prompt：写清楚要画什么");
      const target = this.#target(args.path);
      const refs = Array.isArray(args.reference_paths) ? args.reference_paths : [];
      if (refs.length > MAX_REFERENCES) throw new ImageError(`reference_paths 最多 ${MAX_REFERENCES} 张`);
      const size = SIZES.includes(String(args.size)) ? String(args.size) : "auto";
      const quality = QUALITIES.includes(String(args.quality)) ? String(args.quality) : "auto";
      const files = await this.#filesFor(userId);
      const images: Array<{ image_url: string }> = [];
      for (const ref of refs) {
        const checked = requireWorkspaceFilePath(String(ref), this.#workspace);
        if (!checked.ok) throw new ImageError(`参考图 ${String(ref)}：${checked.message}`);
        const { bytes, contentType } = await files.read(checked.path);
        if (contentType === "image/svg+xml") throw new ImageError(`参考图 ${checked.path} 是 SVG，请先转成 png`);
        images.push({ image_url: `data:${contentType};base64,${bytes.toString("base64")}` });
      }
      const picture = await this.#request(images.length ? "edits" : "generations", {
        ...(images.length ? { images } : {}),
        prompt,
        background: args.transparent_background === true ? "transparent" : "opaque",
        model: IMAGE_MODEL,
        quality,
        size,
      });
      await files.write(target, picture);
      this.#log.info("image generated", { userId, edit: images.length > 0, bytes: picture.length, ms: Date.now() - started });
      return text(`图片已保存：${target}\n在回复里用 ![说明](${target}) 显示它。`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ImageError)) this.#log.warn("image generation failed", { userId, error: message, ms: Date.now() - started });
      return text(message, true);
    }
  }

  /** Where the picture goes: a .png the executor named inside the workspace, or a fresh one. */
  #target(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      return `${this.#workspace}/images/${stamp}-${randomUUID().slice(0, 6)}.png`;
    }
    const checked = requireWorkspaceFilePath(String(raw), this.#workspace);
    if (!checked.ok) throw new ImageError(`path：${checked.message}`);
    if (!/\.png$/i.test(checked.path)) throw new ImageError("path 要以 .png 结尾（生成的是 PNG 图片）");
    return checked.path;
  }

  /** One request to the ChatGPT images endpoint, with the control plane's own login. */
  async #request(kind: "generations" | "edits", body: Record<string, unknown>): Promise<Buffer> {
    const tokens = await this.#hostTokens.getTokens();
    const res = await fetch(`${this.#chatgptUrl}/images/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": tokens.chatgptAccountId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) this.#hostTokens.invalidate();
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      if (res.status === 429) throw new Error(`出图额度暂时用完或请求太频繁，请稍后再试（${detail}）`);
      if (res.status === 400) throw new ImageError(`出图请求被拒绝，可能是内容不符合要求，换个描述再试（${detail}）`);
      throw new Error(`出图服务返回 ${res.status}（${detail}）`);
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const picture = Buffer.from(json.data?.[0]?.b64_json ?? "", "base64");
    // Only PNG bytes are saved under a .png name.
    if (!picture.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("出图服务没有返回 PNG 图片");
    return picture;
  }
}
