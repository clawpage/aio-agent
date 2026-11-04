import type http from "node:http";
import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { McpGateway, type McpCall } from "./mcpGateway.js";
import type { DeviceLinks, Tunnel } from "./deviceLink.js";
import type { ImageFiles } from "./imageTool.js";
import { requireWorkspaceFilePath } from "./documents/paths.js";

/**
 * The account's own iPhone: the iOS app links itself to the account signed in
 * on it (DeviceLinks, kind `ios`) and, while it is open, answers over that
 * socket for the abilities the person turned on there (Photos, Reminders,
 * Calendar; DeviceTools.swift). The executor reaches them as one MCP server,
 * aio_ios, on the member gateway (`/ios-device/<token>/mcp`); each account only
 * the iPhones it linked, never another account's, a gadget's or a page's.
 *
 * As with the Mac (MacNativeGateway), the handshake and the tool list never
 * depend on the phone: Codex starts a thread's MCP servers once, and iOS
 * suspends the app's socket whenever the app leaves the screen. Calls go down
 * the socket and come back as tool errors while the app is away.
 * Photos come back downscaled (JPEG, at most 1600 px), a few at a time, saved
 * in the account's workspace and shown to the model; nothing else of the
 * library leaves the phone. Logs name the account and the tool, never content.
 */
const CALL_PATH = "/ios/call";
const STATUS_PATH = "/ios/status";
const CALL_TIMEOUT_MS = 30_000;
/** A photo may first have to come down from iCloud. */
const PHOTO_TIMEOUT_MS = 90_000;
const TIMEOUT_SEC = PHOTO_TIMEOUT_MS / 1000 + 30;
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_SIZE = 1600;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const IPHONE_OFFLINE =
  "The user's iPhone is not reachable right now: the app on it is closed or in the background (iOS pauses it there). Ask the user to open the app on their iPhone and keep it on screen, then try again.";

export const IOS_POLICY =
  "aio_ios reaches the user's own iPhone (not the sandbox), through the app on it: its Photos (photos_albums, photos_list, photos_get), Reminders (reminders_lists, reminders_list, reminders_create, reminders_complete) and Calendar (calendar_calendars, calendar_events, calendar_create_event). Use them when the user's request is about their photos, reminders or schedule. " +
  "The iPhone answers only while the app is open on screen; if a call says it is not reachable, or that an ability is off or not allowed, tell the user in one sentence what to do (open the app; turn it on in Settings → iPhone abilities) and do not keep retrying. " +
  "Reading is fine whenever it serves the request. Creating or completing reminders and creating calendar events changes the user's own data: do it only when the user asked for it, and otherwise tell them exactly what you would add and wait for confirmation. If a write's result is unknown, list again to check before repeating it. " +
  "photos_get saves downscaled copies into the workspace and shows them to you; fetch only the photos the task needs (at most 5 per call), find them first with photos_list, and never try to copy the whole library. Photos and calendars are private: do not send them anywhere the user did not ask for.";

const DATE = { type: "string", description: "ISO 8601 date or date-time, e.g. 2026-11-04 or 2026-11-04T15:30:00+08:00 (without an offset, the iPhone's own time zone)" };
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const IOS_TOOLS = [
  {
    name: "iphone_status",
    title: "iPhone abilities",
    description: "Which abilities the user turned on for the agent in the iPhone app (photos, reminders, calendar), whether iOS allows each (photos may be limited to a selection), and the iPhone's time zone.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "photos_albums",
    title: "List photo albums",
    description: "The iPhone's photo albums: the user's own albums and the main smart albums (Favorites, Recents, Screenshots, Selfies, …), with their ids and photo counts.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "photos_list",
    title: "Find photos",
    description: "List photos and videos on the iPhone, newest first, by album, date range, favorites and media type. Returns metadata only (id, date taken, size, favorite, approximate location); fetch the pictures themselves with photos_get. Photos have no text search: narrow by date and album.",
    inputSchema: {
      type: "object",
      properties: {
        album_id: { type: "string", description: "An album id from photos_albums (default: the whole library)" },
        from: { ...DATE, description: `Taken at or after this time. ${DATE.description}` },
        to: { ...DATE, description: `Taken before this time (a date alone means the end of that day). ${DATE.description}` },
        favorites: { type: "boolean", description: "Only favorites" },
        media: { type: "string", enum: ["image", "video", "any"], description: "Default image" },
        limit: { type: "number", description: "At most this many (default 20, at most 100)" },
        offset: { type: "number", description: "Skip this many of the matches (to page through)" },
      },
    },
    annotations: READ,
  },
  {
    name: "photos_get",
    title: "Fetch photos",
    description: `Fetch photos from the iPhone by id (from photos_list), at most ${MAX_PHOTOS} per call: each is downscaled to a JPEG (longest side at most ${MAX_PHOTO_SIZE} px), saved in the workspace and returned as a picture. For a video, its still frame.`,
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: `Photo ids from photos_list (1–${MAX_PHOTOS})` },
        max_size: { type: "number", description: `Longest side in pixels (default and at most ${MAX_PHOTO_SIZE})` },
        folder: { type: "string", description: "Workspace folder to save into, e.g. this task's folder /home/gem/workspace/tasks/<task id>/ (default /home/gem/workspace/iphone-photos/)" },
      },
      required: ["ids"],
    },
    annotations: READ,
  },
  {
    name: "reminders_lists",
    title: "List reminder lists",
    description: "The iPhone's reminder lists (ids, names, which one is the default).",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "reminders_list",
    title: "List reminders",
    description: "Reminders on the iPhone: open ones by default (sorted by due date), or completed ones, from one list or all.",
    inputSchema: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "A list id from reminders_lists (default: all lists)" },
        status: { type: "string", enum: ["open", "completed", "all"], description: "Default open" },
        due_before: { ...DATE, description: `Only open reminders due before this time. ${DATE.description}` },
        limit: { type: "number", description: "At most this many (default 50, at most 200)" },
      },
    },
    annotations: READ,
  },
  {
    name: "reminders_create",
    title: "Create a reminder",
    description: "Add a reminder on the iPhone. Only when the user asked for it or confirmed it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What to be reminded of" },
        notes: { type: "string" },
        due: { ...DATE, description: `When it is due; a date alone makes an all-day reminder. ${DATE.description}` },
        list_id: { type: "string", description: "A list id from reminders_lists (default: the default list)" },
        priority: { type: "string", enum: ["none", "low", "medium", "high"] },
      },
      required: ["title"],
    },
    annotations: WRITE,
  },
  {
    name: "reminders_complete",
    title: "Complete a reminder",
    description: "Mark a reminder on the iPhone done (or open again with completed false). Only when the user asked for it or confirmed it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The reminder's id from reminders_list" },
        completed: { type: "boolean", description: "Default true" },
      },
      required: ["id"],
    },
    annotations: { ...WRITE, idempotentHint: true },
  },
  {
    name: "calendar_calendars",
    title: "List calendars",
    description: "The iPhone's calendars (ids, names, account, whether events can be added, which one is the default).",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "calendar_events",
    title: "List events",
    description: "Events on the iPhone's calendars between two times (at most 366 days apart), in time order.",
    inputSchema: {
      type: "object",
      properties: {
        from: { ...DATE, description: `Start of the range. ${DATE.description}` },
        to: { ...DATE, description: `End of the range (a date alone means the end of that day). ${DATE.description}` },
        calendar_id: { type: "string", description: "A calendar id from calendar_calendars (default: all)" },
        limit: { type: "number", description: "At most this many (default 100, at most 300)" },
      },
      required: ["from", "to"],
    },
    annotations: READ,
  },
  {
    name: "calendar_create_event",
    title: "Create an event",
    description: "Add an event to a calendar on the iPhone. Only when the user asked for it or confirmed it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: DATE,
        end: { ...DATE, description: `Default: one hour after start (all-day: the same day). ${DATE.description}` },
        all_day: { type: "boolean" },
        location: { type: "string" },
        notes: { type: "string" },
        calendar_id: { type: "string", description: "A writable calendar id from calendar_calendars (default: the default calendar)" },
      },
      required: ["title", "start"],
    },
    annotations: WRITE,
  },
] as const;

const TOOL_NAMES = new Set<string>(IOS_TOOLS.map((t) => t.name));
const WRITES = new Set(["reminders_create", "reminders_complete", "calendar_create_event"]);
const ABILITY: Record<string, string> = { photos: "Photos", reminders: "Reminders", calendar: "Calendar" };

/** What the iPhone answers for one call: a result, or an error code with the app's own words. */
type Answer = { ok: true; result: unknown } | { ok: false; code?: string; message?: string };
type Photo = { id: string; created?: string; width?: number; height?: number; mediaType?: string; jpeg: string };

/** Thread-level MCP wiring for a Codex executor. */
export function iosThreadServers(cfg: Config): Record<string, unknown> {
  return cfg.ios ? { aio_ios: { url: cfg.ios.url, tool_timeout_sec: TIMEOUT_SEC } } : {};
}

/** The same for a Claude Code turn (`--mcp-config`). */
export function iosMcpServers(cfg: Config): Record<string, unknown> {
  return cfg.ios ? { aio_ios: { type: "http", url: cfg.ios.url } } : {};
}

/** What the account's iPhone reports about its abilities, for the console; null when no iPhone of the account is connected. */
export type IosStatus = { abilities: Record<string, { enabled: boolean; permission: string }>; timeZone?: string } | null;

export class IosDeviceGateway extends McpGateway {
  #log: Logger;
  #links: DeviceLinks;
  #userIdOf: (username: string) => string | null;
  #workspace: string;
  #filesFor: (userId: string) => Promise<ImageFiles>;

  constructor(opts: { cfg: Config; log: Logger; port: number; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links: DeviceLinks; workspace: string; filesFor: (userId: string) => Promise<ImageFiles> }) {
    super({
      ...opts,
      name: "ios-device",
      // No upstream of its own: every call goes down the socket of the account's iPhone (local).
      upstreamUrl: "",
      secretKey: "",
      secretsFile: "",
      // Each account only the iPhones it linked; which abilities are on is each iPhone's to say.
      granted: (username) => opts.links.hasLink(opts.userIdOf(username) ?? "", "ios"),
      assign: (runtime, url) => { runtime.ios = { url }; },
      timeoutMs: TIMEOUT_SEC * 1000,
    });
    this.#log = opts.log.child("ios-device");
    this.#links = opts.links;
    this.#userIdOf = opts.userIdOf;
    this.#workspace = opts.workspace.replace(/\/+$/, "");
    this.#filesFor = opts.filesFor;
  }

  override get enabled(): boolean {
    return true;
  }

  /** Give or take away the runtime's iPhone tools after its account linked or unlinked an iPhone. */
  refresh(runtime: Config): void {
    if (this.#links.hasLink(runtime.runtimeUserId ?? "", "ios")) this.provision(runtime);
    else delete runtime.ios;
  }

  /** The abilities the account's connected iPhone reports. */
  async status(userId: string): Promise<IosStatus> {
    const tunnel = this.#links.tunnelFor(userId, "ios");
    if (!tunnel) return null;
    try {
      const reply = await tunnel.request("GET", STATUS_PATH, { timeoutMs: 15_000 });
      return reply.status === 200 ? (JSON.parse(reply.body.toString("utf8")) as IosStatus) : null;
    } catch {
      return null;
    }
  }

  protected override async local(message: unknown, username: string, _headers: http.IncomingHttpHeaders): Promise<unknown> {
    if (Array.isArray(message)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } };
    const { method, id, params } = (message ?? {}) as { method?: string; id?: unknown; params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown } };
    if (id === undefined || id === null) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "aio_ios", version: "1" }, instructions: IOS_POLICY });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: IOS_TOOLS });
    if (method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } };
    const tool = typeof params?.name === "string" ? params.name : "";
    if (!TOOL_NAMES.has(tool)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${tool}` } };
    const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    return reply(await this.#call(this.#userIdOf(username) ?? "", tool, args));
  }

  /** Something that is not JSON never reaches the iPhone. */
  protected override async forward(_call: McpCall, res: http.ServerResponse): Promise<boolean> {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
    return true;
  }

  async #call(userId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
    const started = Date.now();
    const done = (ok: boolean, extra: Record<string, unknown> = {}) => this.#log.info("iphone tool call", { userId, tool, ok, ms: Date.now() - started, ...extra });
    const tunnel = userId && this.#links.hasLink(userId, "ios") ? this.#links.tunnelFor(userId, "ios") : null;
    if (!tunnel) { done(false, { reason: "offline" }); return text(IPHONE_OFFLINE, true); }
    let folder = "";
    if (tool === "photos_get") {
      const ids = Array.isArray(args.ids) ? args.ids.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200) : [];
      if (!ids.length || ids.length !== (args.ids as unknown[]).length) { done(false, { reason: "invalid" }); return text("ids must be 1 to 5 photo ids from photos_list.", true); }
      if (ids.length > MAX_PHOTOS) { done(false, { reason: "invalid" }); return text(`At most ${MAX_PHOTOS} photos per call; fetch the rest in another call, and only those the task needs.`, true); }
      const checked = this.#folder(args.folder);
      if (!checked.ok) { done(false, { reason: "invalid" }); return text(`folder: ${checked.message}`, true); }
      folder = checked.path;
      const size = Number(args.max_size);
      args = { ids, max_size: Number.isFinite(size) && size >= 64 ? Math.min(Math.round(size), MAX_PHOTO_SIZE) : MAX_PHOTO_SIZE };
    }
    let answer: Answer;
    try {
      answer = await this.#rpc(tunnel, tool, args);
    } catch (err) {
      this.#log.warn("iphone call failed", { userId, tool, error: err instanceof Error ? err.message : String(err) });
      done(false, { reason: "no answer" });
      const away = !this.#links.tunnelFor(userId, "ios");
      const why = away ? IPHONE_OFFLINE : "The iPhone did not answer in time (the app may have left the screen, or it is still loading from iCloud).";
      // Unknown, not failed: the iPhone may have saved it even though no answer came back.
      return text(WRITES.has(tool) ? `${why} Whether it was saved is unknown: list to check before trying again.` : why, true);
    }
    if (!answer.ok) {
      done(false, { reason: answer.code ?? "error" });
      return text(this.#explain(tool, answer), true);
    }
    if (tool !== "photos_get") {
      done(true);
      return text(JSON.stringify(answer.result));
    }
    return this.#photos(userId, folder, answer.result, done);
  }

  /** Save the fetched photos in the account's workspace and show them to the model. */
  async #photos(userId: string, folder: string, result: unknown, done: (ok: boolean, extra?: Record<string, unknown>) => void): Promise<unknown> {
    const { photos = [], missing = [] } = (result ?? {}) as { photos?: Photo[]; missing?: string[] };
    const files = await this.#filesFor(userId);
    const lines: string[] = [];
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    let bytes = 0;
    for (const photo of photos.slice(0, MAX_PHOTOS)) {
      const jpeg = Buffer.from(typeof photo?.jpeg === "string" ? photo.jpeg : "", "base64");
      // Only JPEG bytes are saved under a .jpg name, and none larger than a downscaled photo can be.
      if (jpeg.length < 4 || jpeg.length > MAX_PHOTO_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
        lines.push(`- ${String(photo?.id)}: the iPhone sent no usable picture`);
        continue;
      }
      const target = `${folder}/${photoName(photo)}`;
      const meta = [photo.created && `taken ${photo.created}`, photo.mediaType === "video" && "still frame of a video", photo.width && photo.height && `original ${photo.width}×${photo.height}`].filter(Boolean).join(", ");
      try {
        await files.write(target, jpeg);
        lines.push(`- ${photo.id}: saved ${target}${meta ? ` (${meta})` : ""}`);
      } catch (err) {
        lines.push(`- ${photo.id}: shown below, but not saved (${err instanceof Error ? err.message : String(err)})${meta ? ` (${meta})` : ""}`);
      }
      images.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
      bytes += jpeg.length;
    }
    for (const id of missing) lines.push(`- ${id}: not found on the iPhone (deleted, or not in the photos the user allowed)`);
    done(images.length > 0, { photos: images.length, missing: missing.length, bytes });
    const head = images.length ? `Fetched ${images.length} photo(s) from the iPhone. Show a saved one in your reply with ![description](path).` : "No photo could be fetched.";
    return { content: [{ type: "text", text: [head, ...lines].join("\n") }, ...images], ...(images.length ? {} : { isError: true }) };
  }

  /** Where fetched photos go: a folder the executor named inside the workspace, or the default one. */
  #folder(raw: unknown): { ok: true; path: string } | { ok: false; message: string } {
    if (raw === undefined || raw === null || raw === "") return { ok: true, path: `${this.#workspace}/iphone-photos` };
    return requireWorkspaceFilePath(String(raw), this.#workspace);
  }

  /** The model-facing reading of an error code the app answered with. */
  #explain(tool: string, answer: { code?: string; message?: string }): string {
    const ability = ABILITY[tool.split("_")[0]!] ?? "This ability";
    const detail = typeof answer.message === "string" && answer.message ? ` (${answer.message.slice(0, 300)})` : "";
    switch (answer.code) {
      case "off": return `${ability} is turned off for the agent on the user's iPhone. Ask the user to turn it on in the app: Settings → iPhone abilities.`;
      case "denied": return `iOS does not allow the app to use ${ability}. Ask the user to allow it: Settings → iPhone abilities in the app, then "Open iOS Settings".`;
      case "not_found": return `Not found on the iPhone${detail}.`;
      case "invalid": return `The iPhone refused the request${detail}; check the arguments.`;
      case "unknown_tool": return "The app on the iPhone is too old for this tool; ask the user to update it.";
      default: return `The iPhone could not do it${detail}.`;
    }
  }

  async #rpc(tunnel: Tunnel, tool: string, args: Record<string, unknown>): Promise<Answer> {
    const reply = await tunnel.request("POST", CALL_PATH, {
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ tool, arguments: args })),
      timeoutMs: tool === "photos_get" ? PHOTO_TIMEOUT_MS : CALL_TIMEOUT_MS,
    });
    if (reply.status === 404) return { ok: false, code: "unknown_tool" };
    if (reply.status !== 200) throw new Error(`iphone answered ${reply.status}`);
    return JSON.parse(reply.body.toString("utf8")) as Answer;
  }
}

/** `IMG-20261104-153012-<id>.jpg` from the date taken, in the iPhone's own time; the id keeps two photos of one second apart. */
function photoName(photo: Photo): string {
  const id = String(photo.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "photo";
  const taken = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(photo.created ?? "");
  return `IMG-${taken ? `${taken.slice(1, 4).join("")}-${taken.slice(4, 7).join("")}` : "undated"}-${id}.jpg`;
}
