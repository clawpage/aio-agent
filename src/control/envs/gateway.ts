import type http from "node:http";
import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import { McpGateway, type McpCall } from "../mcpGateway.js";
import type { DeviceLinks } from "../deviceLink.js";
import { requireWorkspaceFilePath } from "../documents/paths.js";
import { TAB_TASK_HEADER, TAB_TOOL_TIMEOUT_SEC, type BrowserTask } from "../browser/tabs.js";
import { ENV_TOOLS, LISTED_TOOLS, TOOL_CAPABILITY, type Capability, type EnvAnswer } from "./catalog.js";
import { ENV_POLICY } from "./policy.js";
import { MAX_CALL_TIMEOUT_MS, type EnvCall, type EnvRegistry } from "./registry.js";
import type { AppContext } from "../context.js";
import { sandboxImageFiles } from "../imageTool.js";

export { ENV_TOOLS } from "./catalog.js";

/**
 * aio_env (docs/EXEC-ENVS.md): the one MCP server the executor reaches every execution environment
 * through, on the member gateway (`/env/<token>/mcp`). Each account only its own devices; the list of
 * tools never depends on them (Codex starts a thread's servers once), and a call to a device that is
 * away, or that cannot do it, comes back as a tool error saying what to do. Pictures a device sends
 * (screenshots, photos) are saved in the account's workspace and shown to the model; files move
 * between a device's app folder and the workspace only. Logs name the account, environment and tool,
 * never content.
 */
/** The executor waits as long as the longest call (the person acting in a browser, a Mac's page in the console), and a little more. */
const TIMEOUT_SEC = Math.max(TAB_TOOL_TIMEOUT_SEC, MAX_CALL_TIMEOUT_MS / 1000 + 10);
const MAX_PHOTOS = 5;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** The account's workspace files, as aio_env moves them (any file, not only pictures). */
export interface EnvFiles {
  read(path: string): Promise<Buffer>;
  write(path: string, bytes: Buffer): Promise<void>;
}

/** An account's workspace through its runtime's sandbox: any file read back (up to MAX_FILE_BYTES), written into place. */
export function envFiles(ctx: Pick<AppContext, "documents" | "container">): EnvFiles {
  return { read: (file) => ctx.documents.fileBytes(file, MAX_FILE_BYTES), write: (file, bytes) => sandboxImageFiles(ctx).write(file, bytes) };
}

/** Thread-level MCP wiring for a Codex executor; the task's identity finds its page on a Mac's Chrome. */
export function envThreadServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.env ? { aio_env: { url: cfg.env.url, ...(task ? { http_headers: { [TAB_TASK_HEADER]: task.key } } : {}), tool_timeout_sec: TIMEOUT_SEC } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function envMcpServers(cfg: Config, task?: BrowserTask): Record<string, unknown> {
  return cfg.env ? { aio_env: { type: "http", url: cfg.env.url, ...(task ? { headers: { [TAB_TASK_HEADER]: task.key } } : {}) } } : {};
}

const OFFLINE: Record<string, string> = {
  ios: "The iPhone is not reachable right now: the app on it is closed or in the background (iOS pauses it there). Ask the user to open the app on their iPhone and keep it on screen, then try again.",
  android: "The Android phone is not reachable right now: its app is closed or the phone is offline (or the Mac it is plugged into is). Ask the user to open the app, then try again.",
  mac: "The Mac is not reachable right now: the app on it is closed, asleep or offline. Ask the user to open the app on that Mac, then try again.",
};

const UNABLE: Record<Capability, string> = {
  browser: "cannot browse: it has no browser for you (an older app, or none on this device). Use the sandbox browser instead",
  files: "has no files you can reach. Ask the user to update the app",
  shell: "has no terminal for you: the user turns it on in the Mac app",
  photos: "has no photos for you: the user turns them on in the app's settings",
  reminders: "has no reminders for you: the user turns them on in the app's settings",
  calendar: "has no calendar for you: the user turns it on in the app's settings",
  apps: "cannot operate other apps: that needs the phone's debugging permission (the side-loaded Android app, or the phone on a Mac's USB). Tell the user, or do it another way",
  screen: "cannot operate other apps: that needs the phone's debugging permission (the side-loaded Android app, or the phone on a Mac's USB). Tell the user, or do it another way",
};

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: true };

export class EnvGateway extends McpGateway {
  #log: Logger;
  #registry: EnvRegistry;
  #userIdOf: (username: string) => string | null;
  #workspace: string;
  #filesFor: (userId: string) => Promise<EnvFiles>;

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links: DeviceLinks; registry: EnvRegistry; workspace: string; filesFor: (userId: string) => Promise<EnvFiles> }) {
    super({
      ...opts,
      name: "env",
      // No upstream of its own: every call is answered here, by the registry.
      upstreamUrl: "",
      secretKey: "",
      secretsFile: "",
      // Every account whose runtime runs with the environments (PA_EXEC_ENVS); its devices are its own.
      granted: (_username, runtime) => runtime.execEnvs === true,
      assign: (runtime, url) => { runtime.env = { url }; },
      timeoutMs: TIMEOUT_SEC * 1000,
    });
    this.#log = opts.log.child("envs");
    this.#registry = opts.registry;
    this.#userIdOf = opts.userIdOf;
    this.#workspace = opts.workspace.replace(/\/+$/, "");
    this.#filesFor = opts.filesFor;
  }

  override get enabled(): boolean {
    return true;
  }

  protected override async local(message: unknown, username: string, headers: http.IncomingHttpHeaders): Promise<unknown> {
    if (Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown } };
    if (id === undefined || id === null) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "aio_env", version: "1" }, instructions: ENV_POLICY });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: LISTED_TOOLS });
    if (method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } };
    const tool = typeof params?.name === "string" ? params.name : "";
    if (!TOOL_CAPABILITY.has(tool)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${tool}` } };
    const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? { ...(params.arguments as Record<string, unknown>) } : {};
    return reply(await this.#call(this.#userIdOf(username) ?? "", username, headers, tool, args));
  }

  /** Something that is not JSON never reaches a device. */
  protected override async forward(_call: McpCall, res: http.ServerResponse): Promise<boolean> {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
    return true;
  }

  async #call(userId: string, username: string, headers: http.IncomingHttpHeaders, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
    const error = (value: string): ToolResult => ({ content: [{ type: "text", text: value }], isError: true });
    if (!userId) return error("No environment is available for this account.");
    if (tool === "env_list") return text(JSON.stringify({ envs: await this.#registry.list(userId) }));
    const envId = typeof args.env === "string" ? args.env : "";
    delete args.env;
    const started = Date.now();
    const done = (ok: boolean, extra: Record<string, unknown> = {}) => this.#log.info("environment tool call", { userId, env: envId, tool, ok, ms: Date.now() - started, ...extra });

    // What leaves for a device is checked here, before it goes.
    const prepared = await this.#prepare(userId, tool, args);
    if ("error" in prepared) { done(false, { reason: "invalid" }); return error(prepared.error); }

    const out: EnvCall = await this.#registry.call(userId, { username, headers }, envId, tool, prepared.args);
    switch (out.status) {
      case "missing": done(false, { reason: "missing" }); return error(`There is no environment "${envId}" for this account: call env_list for the ids.`);
      case "sandbox": done(false, { reason: "sandbox" }); return error("The sandbox is used with your own tools (the sandbox browser, shell and files), not through aio_env.");
      case "offline": done(false, { reason: "offline" }); return error(OFFLINE[out.env.kind] ?? "The device is not reachable right now.");
      case "unable": done(false, { reason: "unable" }); return error(`${out.env.name} ${UNABLE[out.capability]}.`);
      case "failed": done(false, { reason: "no answer" }); return error(`${out.env.name} did not answer in time${TOOL_CAPABILITY.get(tool) && /create|complete|push|click|type|tap|open|bash|write|edit/.test(tool) ? "; whether it was done is unknown: check before trying again" : ""}.`);
    }
    const answer: EnvAnswer = out.answer;
    if (!answer.ok) { done(false, { reason: answer.code ?? "error" }); return error(this.#explain(out.env.name, tool, answer)); }
    done(true);
    return this.#result(userId, out.env.kind, tool, prepared, answer.result);
  }

  /** The arguments a device gets, after checking them: workspace paths stay in the workspace, a pushed file goes with its bytes. */
  async #prepare(userId: string, tool: string, args: Record<string, unknown>): Promise<{ args: Record<string, unknown>; folder?: string } | { error: string }> {
    if (tool === "photos_get") {
      const ids = Array.isArray(args.ids) ? args.ids.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200) : [];
      if (!ids.length || ids.length !== (args.ids as unknown[]).length) return { error: "ids must be 1 to 5 photo ids from photos_list." };
      if (ids.length > MAX_PHOTOS) return { error: `At most ${MAX_PHOTOS} photos per call; fetch the rest in another call, and only those the task needs.` };
      const folder = this.#folder(args.folder, "device-photos");
      if ("error" in folder) return folder;
      const size = Number(args.max_size);
      return { args: { ids, max_size: Number.isFinite(size) && size >= 64 ? Math.min(Math.round(size), 1600) : 1600 }, folder: folder.path };
    }
    if (tool === "files_pull") {
      const folder = this.#folder(args.to, "device-files");
      if ("error" in folder) return folder;
      return { args: { name: args.name }, folder: folder.path };
    }
    if (tool === "files_push") {
      const checked = requireWorkspaceFilePath(String(args.path ?? ""), this.#workspace);
      if (!checked.ok) return { error: `path: ${checked.message}` };
      let bytes: Buffer;
      try { bytes = await (await this.#filesFor(userId)).read(checked.path); } catch (err) { return { error: `path: ${err instanceof Error ? err.message : String(err)}` }; }
      if (bytes.length > MAX_FILE_BYTES) return { error: `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
      return { args: { name: path.posix.basename(checked.path), data: bytes.toString("base64") } };
    }
    return { args };
  }

  /** A workspace folder the agent named (or the default one), always inside the workspace. */
  #folder(raw: unknown, fallback: string): { path: string } | { error: string } {
    if (raw === undefined || raw === null || raw === "") return { path: `${this.#workspace}/${fallback}` };
    const checked = requireWorkspaceFilePath(String(raw).replace(/\/+$/, ""), this.#workspace);
    return checked.ok ? { path: checked.path } : { error: `folder: ${checked.message}` };
  }

  /** A device's answer as the model sees it: pictures saved and shown, a pulled file saved, anything else as JSON. */
  async #result(userId: string, kind: string, tool: string, prepared: { folder?: string }, result: unknown): Promise<ToolResult> {
    const files = () => this.#filesFor(userId);
    const r = (result ?? {}) as { image?: unknown; mimeType?: unknown; text?: unknown; photos?: unknown; missing?: unknown; name?: unknown; data?: unknown };
    if (tool === "photos_get") return this.#photos(await files(), prepared.folder!, r.photos, r.missing);
    if (tool === "files_pull") {
      const bytes = Buffer.from(typeof r.data === "string" ? r.data : "", "base64");
      const name = path.posix.basename(String(r.name ?? "file")).replace(/[^\p{L}\p{N}._ -]/gu, "_") || "file";
      const target = `${prepared.folder}/${name}`;
      await (await files()).write(target, bytes);
      return { content: [{ type: "text", text: `Saved ${target} (${bytes.length} bytes).` }] };
    }
    if (typeof r.image === "string") {
      const bytes = Buffer.from(r.image, "base64");
      const mime = r.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
      if (!bytes.length || bytes.length > MAX_PICTURE_BYTES || !isPicture(bytes, mime)) return { content: [{ type: "text", text: "The device sent no usable picture." }], isError: true };
      const target = `${this.#workspace}/device-shots/${kind}-${tool}-${stamp()}.${mime === "image/jpeg" ? "jpg" : "png"}`;
      let saved = `Saved ${target}.`;
      try { await (await files()).write(target, bytes); } catch (err) { saved = `Shown below, not saved (${err instanceof Error ? err.message : String(err)}).`; }
      return { content: [{ type: "text", text: [saved, typeof r.text === "string" ? r.text : ""].filter(Boolean).join("\n") }, { type: "image", data: bytes.toString("base64"), mimeType: mime }] };
    }
    if (typeof r.text === "string" && Object.keys(r).length === 1) return { content: [{ type: "text", text: r.text }] };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  async #photos(files: EnvFiles, folder: string, photos: unknown, missing: unknown): Promise<ToolResult> {
    const lines: string[] = [];
    const images: Content[] = [];
    for (const photo of (Array.isArray(photos) ? photos : []).slice(0, MAX_PHOTOS) as Array<{ id?: unknown; created?: unknown; jpeg?: unknown }>) {
      const jpeg = Buffer.from(typeof photo?.jpeg === "string" ? photo.jpeg : "", "base64");
      if (!isPicture(jpeg, "image/jpeg") || jpeg.length > MAX_PICTURE_BYTES) { lines.push(`- ${String(photo?.id)}: the device sent no usable picture`); continue; }
      const id = String(photo.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "photo";
      const taken = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(photo.created ?? ""));
      const target = `${folder}/IMG-${taken ? `${taken.slice(1, 4).join("")}-${taken.slice(4, 7).join("")}` : "undated"}-${id}.jpg`;
      try { await files.write(target, jpeg); lines.push(`- ${String(photo.id)}: saved ${target}`); } catch (err) { lines.push(`- ${String(photo.id)}: shown below, not saved (${err instanceof Error ? err.message : String(err)})`); }
      images.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
    }
    for (const id of Array.isArray(missing) ? missing : []) lines.push(`- ${String(id)}: not found on the device`);
    const head = images.length ? `Fetched ${images.length} photo(s). Show a saved one in your reply with ![description](path).` : "No photo could be fetched.";
    return { content: [{ type: "text", text: [head, ...lines].join("\n") }, ...images], ...(images.length ? {} : { isError: true as const }) };
  }

  /** The model-facing reading of an error code a device answered with. */
  #explain(name: string, tool: string, answer: { code?: string; message?: string }): string {
    const detail = typeof answer.message === "string" && answer.message ? answer.message.slice(0, 300) : "";
    switch (answer.code) {
      case "needs_confirmation": return `Waiting for the user to confirm on the device (${name}): ${detail || tool}. Tell the user it is waiting for their tap there; do not retry or work around it.`;
      case "declined": return `The user declined it on ${name}${detail ? ` (${detail})` : ""}. Do not try again unless they ask.`;
      case "off": return `${name}: this is turned off for the agent. Ask the user to turn it on in the app's settings.`;
      case "denied": return `${name}: the system does not allow the app to do this. Ask the user to allow it in the app's settings.`;
      case "not_found": return `Not found on ${name}${detail ? ` (${detail})` : ""}.`;
      case "invalid": return `${name} refused the request${detail ? ` (${detail})` : ""}; check the arguments.`;
      case "busy": return `${name} is busy with something else${detail ? ` (${detail})` : ""}; try again shortly.`;
      case "unknown_tool": return `The app on ${name} is too old for ${tool}; ask the user to update it.`;
      default: return `${name} could not do it${detail ? ` (${detail})` : ""}.`;
    }
  }
}

function isPicture(bytes: Buffer, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}
