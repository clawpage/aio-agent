/**
 * What an execution environment can be and do (docs/EXEC-ENVS.md): the kinds, the capabilities, and
 * the one fixed list of aio_env tools, each tied to the capability it needs. Model-facing, so English.
 */
export type EnvKind = "sandbox" | "mac" | "ios" | "android";
export type Capability = "browser" | "files" | "shell" | "photos" | "reminders" | "calendar" | "apps" | "screen";
export const CAPABILITIES: readonly Capability[] = ["browser", "files", "shell", "photos", "reminders", "calendar", "apps", "screen"];

/** One environment as the agent sees it. */
export interface EnvInfo {
  id: string;
  kind: EnvKind;
  name: string;
  online: boolean;
  foreground: boolean;
  capabilities: Capability[];
}

/** What a device answers for one call (`/env/call`, and the old iPhone's `/ios/call`). */
export type EnvAnswer = { ok: true; result: unknown } | { ok: false; code?: string; message?: string };

const ENV = { type: "string", description: "The environment to act in: an id from env_list" };
const DATE = { type: "string", description: "ISO 8601 date or date-time, e.g. 2026-11-04 or 2026-11-04T15:30:00+08:00 (without an offset, the device's own time zone)" };
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

type Tool = { name: string; title: string; capability: Capability | null; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }; annotations: Record<string, boolean> };

const tool = (name: string, title: string, capability: Capability | null, description: string, properties: Record<string, unknown> = {}, required: string[] = [], annotations: Record<string, boolean> = WRITE): Tool => ({
  name, title, capability, description,
  inputSchema: { type: "object", properties: capability ? { env: ENV, ...properties } : properties, ...(capability || required.length ? { required: capability ? ["env", ...required] : required } : {}) },
  annotations,
});

export const ENV_TOOLS: readonly Tool[] = [
  tool("env_list", "List environments", null, "The places you can act in right now: the sandbox (your own tools) and each of the user's linked devices (a Mac, an iPhone, Android phones), with whether each is online, whether the user has its app on screen now (foreground), and what each can do (capabilities). Call it before acting on a device.", {}, [], READ),

  tool("browser_open", "Open a page", "browser", "Open a web address in the environment's browser (on a phone: the app's own in-app browser, which the user can see and take over).", { url: { type: "string", description: "An http(s) address" } }, ["url"]),
  tool("browser_read", "Read the page", "browser", "The current page's address, title, text and its interactive elements, each with a ref for browser_click and browser_type.", {}, [], READ),
  tool("browser_click", "Click", "browser", "Click an element of the current page by its ref from browser_read.", { ref: { type: "string" } }, ["ref"]),
  tool("browser_type", "Type", "browser", "Type into a field of the current page by its ref from browser_read; submit presses Enter afterwards.", { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, ["ref", "text"]),
  tool("browser_scroll", "Scroll", "browser", "Scroll the current page.", { direction: { type: "string", enum: ["up", "down"] } }, ["direction"]),
  tool("browser_back", "Go back", "browser", "Go back to the previous page."),
  tool("browser_screenshot", "Screenshot the page", "browser", "A picture of the current page, saved in the workspace and shown to you. Prefer browser_read; use this for what text does not show.", {}, [], READ),
  tool("browser_request_human", "Ask the user to act", "browser", "Ask the user to do a step in the browser themselves (a captcha, a sign-in only they can do) and wait; say why in reason.", { reason: { type: "string" } }, ["reason"]),

  tool("files_list", "List files", "files", "Files in the app's own folder on the device (on an iPhone, shown in the Files app under the app's name).", { folder: { type: "string", description: "A folder inside it (default: the top)" } }, [], READ),
  tool("files_pull", "Copy a file into the workspace", "files", "Copy a file from the device's app folder into the workspace.", { name: { type: "string", description: "The file's name (or path) from files_list" }, to: { type: "string", description: "A workspace folder, e.g. /home/gem/workspace/tasks/<task id>/" } }, ["name"]),
  tool("files_push", "Copy a file to the device", "files", "Copy a workspace file into the device's app folder, for the user to open there.", { path: { type: "string", description: "The workspace file" } }, ["path"]),

  tool("photos_albums", "List photo albums", "photos", "The device's photo albums with their ids and photo counts.", {}, [], READ),
  tool("photos_list", "Find photos", "photos", "Photos and videos on the device, newest first, by album, date range, favorites and media type: metadata only; fetch pictures with photos_get.", { album_id: { type: "string" }, from: DATE, to: DATE, favorites: { type: "boolean" }, media: { type: "string", enum: ["image", "video", "any"] }, limit: { type: "number" }, offset: { type: "number" } }, [], READ),
  tool("photos_get", "Fetch photos", "photos", "Fetch photos by id (at most 5 per call): downscaled, saved in the workspace and shown to you.", { ids: { type: "array", items: { type: "string" } }, max_size: { type: "number" }, folder: { type: "string" } }, ["ids"], READ),

  tool("reminders_lists", "List reminder lists", "reminders", "The device's reminder lists.", {}, [], READ),
  tool("reminders_list", "List reminders", "reminders", "Reminders: open ones by default, or completed ones, from one list or all.", { list_id: { type: "string" }, status: { type: "string", enum: ["open", "completed", "all"] }, due_before: DATE, limit: { type: "number" } }, [], READ),
  tool("reminders_create", "Create a reminder", "reminders", "Add a reminder. Only when the user asked for it or confirmed it.", { title: { type: "string" }, notes: { type: "string" }, due: DATE, list_id: { type: "string" }, priority: { type: "string", enum: ["none", "low", "medium", "high"] } }, ["title"]),
  tool("reminders_complete", "Complete a reminder", "reminders", "Mark a reminder done (or open again). Only when the user asked for it or confirmed it.", { id: { type: "string" }, completed: { type: "boolean" } }, ["id"]),

  tool("calendar_calendars", "List calendars", "calendar", "The device's calendars.", {}, [], READ),
  tool("calendar_events", "List events", "calendar", "Events between two times (at most 366 days apart).", { from: DATE, to: DATE, calendar_id: { type: "string" }, limit: { type: "number" } }, ["from", "to"], READ),
  tool("calendar_create_event", "Create an event", "calendar", "Add an event. Only when the user asked for it or confirmed it.", { title: { type: "string" }, start: DATE, end: DATE, all_day: { type: "boolean" }, location: { type: "string" }, notes: { type: "string" }, calendar_id: { type: "string" } }, ["title", "start"]),

  tool("apps_list", "List apps", "apps", "The apps installed on the phone (names and package names).", {}, [], READ),
  tool("app_open", "Open an app", "apps", "Start an app on the phone by its package name from apps_list. On a phone with its own app this runs on a hidden screen, so the user can keep using the phone.", { app: { type: "string", description: "Package name" } }, ["app"]),
  tool("app_close", "Close an app", "apps", "Stop an app on the phone.", { app: { type: "string" } }, ["app"]),

  tool("screen_read", "Read the screen", "screen", "The elements on the phone's screen (text, labels, coordinates). Prefer it to screen_shot.", {}, [], READ),
  tool("screen_tap", "Tap", "screen", "Tap at a point of the screen (mode double or long for a double tap or a long press).", { x: { type: "number" }, y: { type: "number" }, mode: { type: "string", enum: ["tap", "double", "long"] } }, ["x", "y"]),
  tool("screen_type", "Type", "screen", "Type text into the focused field; submit presses Enter.", { text: { type: "string" }, submit: { type: "boolean" } }, ["text"]),
  tool("screen_swipe", "Swipe", "screen", "Swipe on the screen.", { direction: { type: "string", enum: ["up", "down", "left", "right"] }, x: { type: "number" }, y: { type: "number" }, distance: { type: "number" } }, ["direction"]),
  tool("screen_key", "Press a key", "screen", "Press a button: BACK, HOME, ENTER, VOLUME_UP, VOLUME_DOWN.", { key: { type: "string", enum: ["BACK", "HOME", "ENTER", "VOLUME_UP", "VOLUME_DOWN"] } }, ["key"]),
  tool("screen_shot", "Screenshot", "screen", "A picture of the phone's screen, saved in the workspace and shown to you.", {}, [], READ),

  tool("shell_bash", "Run a command", "shell", "Run a shell command on the user's Mac (its terminal, which the user turned on in the Mac app). Only for work about that Mac or its files.", { command: { type: "string" }, timeout_sec: { type: "number" } }, ["command"]),
  tool("shell_read", "Read a file", "shell", "Read a text file on the user's Mac.", { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["path"], READ),
  tool("shell_write", "Write a file", "shell", "Write a text file on the user's Mac.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  tool("shell_edit", "Edit a file", "shell", "Replace exact text in a file on the user's Mac.", { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, ["path", "old_text", "new_text"]),
];

export const TOOL_CAPABILITY: ReadonlyMap<string, Capability | null> = new Map(ENV_TOOLS.map((t) => [t.name, t.capability]));

/** The tools as tools/list gives them (the capability is the gateway's own bookkeeping). */
export const LISTED_TOOLS = ENV_TOOLS.map(({ capability: _capability, ...rest }) => rest);
