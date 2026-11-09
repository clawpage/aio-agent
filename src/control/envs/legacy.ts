import type http from "node:http";
import type { Capability, EnvAnswer } from "./catalog.js";
import type { PhoneGateway } from "../phone.js";
import type { UserBrowserGateway } from "../userBrowser.js";
import type { MacShellGateway } from "../macShell.js";

/**
 * Devices from before protocol 1 (docs/EXEC-ENVS.md, "Old devices keep working"): the Mac app's bridge
 * and the first iPhone app answer no /env/manifest. Their environments are read from what they did
 * offer, and aio_env's tools are translated to their own: the iPhone's /ios/call already answers in
 * protocol 1's shape; the Mac's phone, Chrome and terminal are reached through the gateways that serve
 * aio_mac_native today. Removed with them once no old device is left.
 */

/** The abilities an old iPhone reports at /ios/status, as capabilities (only those turned on there). */
export function iosCapabilities(status: unknown): Capability[] {
  const abilities = (status as { abilities?: Record<string, { enabled?: unknown }> } | null)?.abilities ?? {};
  return (["photos", "reminders", "calendar"] as const).filter((a) => abilities[a]?.enabled === true);
}

/** Who is calling through an old Mac's gateways: they answer by account, and a task's Chrome page is found by its header. */
export interface MacCaller { username: string; headers: http.IncomingHttpHeaders }

type Rpc = { result?: { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }; error?: { message?: string } };

/** A JSON-RPC answer from one of the Mac's gateways as protocol 1's answer: a picture, text, or the failure in its words. */
function fromRpc(reply: unknown): EnvAnswer {
  const rpc = (reply ?? {}) as Rpc;
  if (rpc.error) return { ok: false, message: String(rpc.error.message ?? "the Mac could not do it") };
  const content = rpc.result?.content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (rpc.result?.isError) return { ok: false, message: text || "the Mac could not do it" };
  const image = content.find((c) => c.type === "image" && c.data);
  if (image) return { ok: true, result: { image: image.data, mimeType: image.mimeType ?? "image/png", ...(text ? { text } : {}) } };
  return { ok: true, result: { text } };
}

const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

/** aio_env's screen and app tools as mobile-mcp's, for the phone on an old Mac's USB (`device` is its adb serial). */
export function phoneCall(tool: string, args: Record<string, unknown>, device: string): { name: string; arguments: Record<string, unknown> } | null {
  const tap = { tap: "mobile_click_on_screen_at_coordinates", double: "mobile_double_tap_on_screen", long: "mobile_long_press_on_screen_at_coordinates" } as Record<string, string>;
  switch (tool) {
    case "apps_list": return { name: "mobile_list_apps", arguments: { device } };
    case "app_open": return { name: "mobile_launch_app", arguments: { device, packageName: args.app } };
    case "app_close": return { name: "mobile_terminate_app", arguments: { device, packageName: args.app } };
    case "screen_read": return { name: "mobile_list_elements_on_screen", arguments: { device } };
    case "screen_tap": return { name: tap[String(args.mode ?? "tap")] ?? tap.tap!, arguments: { device, x: args.x, y: args.y } };
    case "screen_type": return { name: "mobile_type_keys", arguments: { device, text: args.text, submit: args.submit === true } };
    case "screen_swipe": return { name: "mobile_swipe_on_screen", arguments: { device, direction: args.direction, ...pick(args, ["x", "y", "distance"]) } };
    case "screen_key": return { name: "mobile_press_button", arguments: { device, button: args.key } };
    case "screen_shot": return { name: "mobile_take_screenshot", arguments: { device } };
    default: return null;
  }
}

/** aio_env's browser tools as the Mac Chrome's (chrome-devtools-mcp's names, element uid = ref). */
export function macBrowserCalls(tool: string, args: Record<string, unknown>): Array<{ name: string; arguments: Record<string, unknown> }> | null {
  switch (tool) {
    case "browser_open": return [{ name: "new_page", arguments: { url: args.url } }];
    case "browser_read": return [{ name: "take_snapshot", arguments: {} }];
    case "browser_click": return [{ name: "click", arguments: { uid: args.ref } }];
    case "browser_type": return [{ name: "fill", arguments: { uid: args.ref, value: args.text } }, ...(args.submit === true ? [{ name: "press_key", arguments: { key: "Enter" } }] : [])];
    case "browser_scroll": return [{ name: "press_key", arguments: { key: args.direction === "up" ? "PageUp" : "PageDown" } }];
    case "browser_back": return [{ name: "navigate_page", arguments: { type: "back" } }];
    case "browser_screenshot": return [{ name: "take_screenshot", arguments: {} }];
    case "browser_request_human": return [{ name: "request_human", arguments: { reason: args.reason } }];
    default: return null;
  }
}

/** aio_env's shell tools as the Mac terminal's. */
export function macShellCall(tool: string, args: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } | null {
  switch (tool) {
    case "shell_bash": return { name: "bash", arguments: { command: args.command, ...(args.timeout_sec !== undefined ? { timeout: args.timeout_sec } : {}) } };
    case "shell_read": return { name: "read", arguments: { path: args.path, ...pick(args, ["offset", "limit"]) } };
    case "shell_write": return { name: "write", arguments: { path: args.path, content: args.content } };
    case "shell_edit": return { name: "edit", arguments: { path: args.path, edits: [{ oldText: args.old_text, newText: args.new_text }] } };
    default: return null;
  }
}

/** The Mac's three gateways, reached as aio_mac_native reaches them. */
export class OldMac {
  constructor(private parts: { phone?: PhoneGateway; browser?: UserBrowserGateway; shell?: MacShellGateway }) {}

  async phone(caller: MacCaller, tool: string, args: Record<string, unknown>, device: string): Promise<EnvAnswer> {
    const mapped = phoneCall(tool, args, device);
    if (!mapped || !this.parts.phone) return { ok: false, code: "unknown_tool" };
    return fromRpc(await this.parts.phone.answer(call(mapped.name, mapped.arguments), caller.username));
  }

  async browser(caller: MacCaller, tool: string, args: Record<string, unknown>): Promise<EnvAnswer> {
    const mapped = macBrowserCalls(tool, args);
    if (!mapped || !this.parts.browser) return { ok: false, code: "unknown_tool" };
    let last: EnvAnswer = { ok: false, code: "unknown_tool" };
    for (const step of mapped) {
      last = fromRpc(await this.parts.browser.answer(call(step.name, step.arguments), caller.username, caller.headers));
      if (!last.ok) return last;
    }
    return last;
  }

  async shell(caller: MacCaller, tool: string, args: Record<string, unknown>): Promise<EnvAnswer> {
    const mapped = macShellCall(tool, args);
    if (!mapped || !this.parts.shell) return { ok: false, code: "unknown_tool" };
    return fromRpc(await this.parts.shell.answer(call(mapped.name, mapped.arguments), caller.username, caller.headers));
  }

  /** Whether the Mac's terminal is on (the person turns it on in the Mac app). */
  async shellOn(userId: string): Promise<boolean> {
    const status = await this.parts.shell?.status(userId).catch(() => null);
    return Boolean(status && status.state === "ready" && status.enabled);
  }
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
}
