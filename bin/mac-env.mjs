/**
 * Device protocol 1 (docs/EXEC-ENVS.md) for the Mac app's bridge: the Mac and every
 * Android phone on its USB described as execution environments (GET /env/manifest)
 * and acted on by aio_env's tool names (POST /env/call). The tools are translated
 * here to the bridge's own: mobile-mcp's whitelisted tools for a phone (by its adb
 * serial), the AI's Chrome (user-browser.mjs) and the terminal (mac-shell.mjs) for
 * the Mac. A phone on USB is an ordinary Android environment; nothing says how it
 * is connected. The control plane keeps a copy of this translation
 * (src/control/envs/legacy.ts) only for bridges from before protocol 1.
 */

/** aio_env's screen and app tools as mobile-mcp's, for the phone with adb serial `device`. */
export function phoneCall(tool, args, device) {
  const tap = { tap: "mobile_click_on_screen_at_coordinates", double: "mobile_double_tap_on_screen", long: "mobile_long_press_on_screen_at_coordinates" };
  switch (tool) {
    case "apps_list": return { name: "mobile_list_apps", arguments: { device } };
    case "app_open": return { name: "mobile_launch_app", arguments: { device, packageName: args.app } };
    case "app_close": return { name: "mobile_terminate_app", arguments: { device, packageName: args.app } };
    case "screen_read": return { name: "mobile_list_elements_on_screen", arguments: { device } };
    case "screen_tap": return { name: tap[String(args.mode ?? "tap")] ?? tap.tap, arguments: { device, x: args.x, y: args.y } };
    case "screen_type": return { name: "mobile_type_keys", arguments: { device, text: args.text, submit: args.submit === true } };
    case "screen_swipe": return { name: "mobile_swipe_on_screen", arguments: { device, direction: args.direction, ...pick(args, ["x", "y", "distance"]) } };
    case "screen_key": return { name: "mobile_press_button", arguments: { device, button: args.key } };
    case "screen_shot": return { name: "mobile_take_screenshot", arguments: { device } };
    default: return null;
  }
}

/** aio_env's browser tools as chrome-devtools-mcp's (element uid = ref). browser_request_human is the console's, not the Mac's. */
export function browserCalls(tool, args) {
  switch (tool) {
    case "browser_open": return [{ name: "new_page", arguments: { url: args.url } }];
    case "browser_read": return [{ name: "take_snapshot", arguments: {} }];
    case "browser_click": return [{ name: "click", arguments: { uid: args.ref } }];
    case "browser_type": return [{ name: "fill", arguments: { uid: args.ref, value: args.text } }, ...(args.submit === true ? [{ name: "press_key", arguments: { key: "Enter" } }] : [])];
    case "browser_scroll": return [{ name: "press_key", arguments: { key: args.direction === "up" ? "PageUp" : "PageDown" } }];
    case "browser_back": return [{ name: "navigate_page", arguments: { type: "back" } }];
    case "browser_screenshot": return [{ name: "take_screenshot", arguments: {} }];
    default: return null;
  }
}

/** aio_env's shell tools as the terminal's. */
export function shellCall(tool, args) {
  switch (tool) {
    case "shell_bash": return { name: "bash", arguments: { command: args.command, ...(args.timeout_sec !== undefined ? { timeout: args.timeout_sec } : {}) } };
    case "shell_read": return { name: "read", arguments: { path: args.path, ...pick(args, ["offset", "limit"]) } };
    case "shell_write": return { name: "write", arguments: { path: args.path, content: args.content } };
    case "shell_edit": return { name: "edit", arguments: { path: args.path, edits: [{ oldText: args.old_text, newText: args.new_text }] } };
    default: return null;
  }
}

/** A JSON-RPC answer as protocol 1's: a picture, text, or the failure in its words. */
export function fromRpc(reply) {
  if (reply?.error) return { ok: false, message: String(reply.error.message ?? "the Mac could not do it") };
  const content = reply?.result?.content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (reply?.result?.isError) return { ok: false, message: text || "the Mac could not do it" };
  const image = content.find((c) => c.type === "image" && c.data);
  if (image) return { ok: true, result: { image: image.data, mimeType: image.mimeType ?? "image/png", ...(text ? { text } : {}) } };
  return { ok: true, result: { text } };
}

/** The page new_page opened, from its page list (`3: Title (https://…) [selected]`): the console shows it on the task's card. */
export function openedPage(text) {
  const line = /^(\d+): (?:(.*?) ?\((\S+)\)|(\S+)) \[selected\]\s*$/m.exec(text);
  return line ? { page: Number(line[1]), title: (line[2] ?? "").slice(0, 200), url: (line[3] ?? line[4]).slice(0, 2000) } : null;
}

const TASK = /^[A-Za-z0-9_-]{1,80}$/;
let ids = 0;
const rpc = (name, args) => ({ jsonrpc: "2.0", id: `env-${++ids}`, method: "tools/call", params: { name, arguments: args } });

/**
 * @param {object} opts
 * @param {string} opts.deviceId  this Mac's stable id (a hash of its hardware id)
 * @param {string} opts.name      this Mac's name
 * @param {() => Promise<Array<{serial: string, name: string}>>} opts.phones  the phones on USB now
 * @param {(name: string, args: object) => Promise<object>} opts.mobile  one whitelisted mobile-mcp tool call: its JSON-RPC answer
 * @param {null | {status(): Promise<{available: boolean}>, handle(msg: object): Promise<object>}} opts.browser
 * @param {{status(): {enabled: boolean}, handle(msg: object, session?: string): Promise<object>}} opts.shell
 * @param {string} opts.off  what the terminal says while it is off
 * @param {string} opts.noBrowser  what the Mac says without a Chrome for the AI
 */
export function createMacEnv({ deviceId, name, phones, mobile, browser, shell, off, noBrowser }) {
  const hasBrowser = async () => Boolean(browser && (await browser.status()).available);
  return {
    async manifest() {
      const capabilities = [...((await hasBrowser()) ? ["browser"] : []), ...(shell.status().enabled ? ["shell"] : [])];
      const usb = await phones().catch(() => []);
      return {
        protocol: 1,
        envs: [
          { deviceId, kind: "mac", name, capabilities, foreground: false },
          ...usb.map((p) => ({ deviceId: p.serial, kind: "android", name: p.name, capabilities: ["apps", "screen"], foreground: false })),
        ],
      };
    },

    /** One aio_env call; `task` (X-AIO-Task) names the task, whose own shell runs its commands. */
    async call(body, task) {
      const tool = typeof body?.tool === "string" ? body.tool : "";
      const args = body?.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? body.arguments : {};
      if (body?.env === deviceId) {
        const shellStep = shellCall(tool, args);
        if (shellStep) {
          if (!shell.status().enabled) return { ok: false, code: "off", message: off };
          return fromRpc(await shell.handle(rpc(shellStep.name, shellStep.arguments), typeof task === "string" && TASK.test(task) ? task : undefined));
        }
        const steps = browserCalls(tool, args);
        if (!steps) return { ok: false, code: "unknown_tool" };
        if (!(await hasBrowser())) return { ok: false, code: "off", message: noBrowser };
        let last = null;
        for (const step of steps) {
          last = fromRpc(await browser.handle(rpc(step.name, step.arguments)));
          if (!last.ok) return last;
        }
        if (tool === "browser_open") return { ok: true, result: { ...openedPage(last.result.text ?? ""), ...last.result } };
        return last;
      }
      const phone = (await phones().catch(() => [])).find((p) => p.serial === body?.env);
      if (!phone) return { ok: false, code: "not_found", message: "that phone is not plugged into this Mac now" };
      const step = phoneCall(tool, args, phone.serial);
      if (!step) return { ok: false, code: "unknown_tool" };
      return fromRpc(await mobile(step.name, step.arguments));
    },
  };
}

function pick(args, keys) {
  return Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
}
