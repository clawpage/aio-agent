import type { LoginStep } from "./browser/tabs.js";
import { siteCovers } from "./vault.js";

/**
 * The password manager's sign-in in the AI's Chrome on the user's Mac. It runs
 * here, in the control plane, through the browser tools the Mac's bridge already
 * offers (navigate_page, evaluate_script, type_text, press_key), so the Mac app
 * needs nothing new. The account and the password only travel in these calls,
 * which never reach the agent, a task's record or a log; what the agent hears is
 * the outcome, scrubbed of both. The same rules as the sandbox browser's
 * (tab-server.cjs): steps start from a fresh load of the page, the password only
 * goes into a type=password box, and password boxes are emptied afterwards.
 */

/** One call to a browser tool on the Mac: its text, or an Error. */
export type MacCall = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface MacLoginOutcome {
  result: "submitted" | "username_only" | "no_form" | "failed";
  error?: string;
}

const STEP_MS = 8000;
const STEP_ACTIONS = new Set(["click", "fill", "press", "wait", "select"]);
const STEP_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]);
const PLACEHOLDERS = new Set(["{{username}}", "{{password}}"]);
export const MAX_MAC_LOGIN_TRIES = 3;

/** The agent's sign-in steps, checked as the sandbox browser checks them; a string says what is wrong. */
export function loginSteps(raw: unknown): LoginStep[] | string | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || !raw.length || raw.length > 15) return "steps must be a list of 1–15 steps";
  const steps: LoginStep[] = [];
  for (const [i, step] of (raw as Array<Record<string, unknown>>).entries()) {
    const n = i + 1;
    if (!step || typeof step !== "object" || !STEP_ACTIONS.has(String(step.action))) return `Step ${n}: action must be one of click, fill, press, wait, select`;
    const out: LoginStep = { action: step.action as LoginStep["action"] };
    if (step.selector !== undefined) {
      if (typeof step.selector !== "string" || !step.selector.trim() || step.selector.length > 300) return `Step ${n}: the selector is invalid`;
      out.selector = step.selector;
    }
    if (["click", "fill", "select"].includes(out.action) && !out.selector) return `Step ${n} (${out.action}) needs a selector`;
    if (out.action === "fill" || out.action === "select") {
      if (typeof step.value !== "string" || step.value.length > 200) return `Step ${n} needs a value (use {{username}} and {{password}} for the account and password)`;
      if (/\{\{/.test(step.value) && !PLACEHOLDERS.has(step.value)) return `Step ${n}: a placeholder must be the whole value, exactly {{username}} or {{password}}`;
      if (out.action === "select" && PLACEHOLDERS.has(step.value)) return `Step ${n}: a dropdown cannot be filled with the account or password`;
      out.value = step.value;
    }
    if (out.action === "press") {
      if (!STEP_KEYS.has(String(step.key))) return `Step ${n}: key must be one of ${[...STEP_KEYS].join(", ")}`;
      out.key = String(step.key);
    }
    if (out.action === "wait") {
      if (!out.selector && !(Number(step.ms) > 0)) return `Step ${n} (wait) needs a selector or ms`;
      if (step.ms !== undefined) out.ms = Math.min(10000, Math.max(0, Number(step.ms) || 0));
    }
    steps.push(out);
  }
  if (!steps.some((s) => s.value === "{{password}}")) return "steps must include a step that fills {{password}} into the password box";
  return steps;
}

/** Text the agent may read: never the values that were being typed. */
export function scrub(message: string, secrets: string[]): string {
  let text = message.split("\n").slice(0, 4).join("\n").slice(0, 400);
  for (const secret of secrets) if (secret) text = text.split(secret).join("***");
  return text;
}

const label = (step: LoginStep) => `${step.action}${step.selector ? ` ${step.selector}` : ""}${step.key ? ` ${step.key}` : ""}`;

/** What evaluate_script returned: chrome-devtools-mcp puts it in a ```json block. */
export function scriptValue(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1]![1]! : text;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * In the page: wait (up to the step's time) for the first visible element matching
 * `selector`, then act on it. Returns {ok} or {error, type}. Only `selector` and
 * the action are put into the script, never a value typed into the page.
 */
function findScript(selector: string, action: "focus" | "focus-password" | "click" | "exists" | { select: string }): string {
  return `async () => {
  const sel = ${JSON.stringify(selector)};
  const until = Date.now() + ${STEP_MS};
  let el = null;
  for (;;) {
    try { el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0) || null; } catch (e) { return { error: "the selector is invalid" }; }
    if (el || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!el) return { error: "no visible element matches it" };
  const action = ${JSON.stringify(action)};
  if (action === "exists") return { ok: true };
  el.scrollIntoView({ block: "center" });
  if (action === "click") { el.click(); return { ok: true }; }
  if (typeof action === "object") {
    el.value = action.select;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (action === "focus-password" && type !== "password") return { error: "not_password", type: type || "text" };
  el.focus();
  if (typeof el.select === "function") el.select();
  return { ok: document.activeElement === el, host: location.hostname };
}`;
}

/** Marks the sign-in form's boxes (data-aio-login="password" / "username"): the password box, else a likely account box. */
const GUESS_SCRIPT = `() => {
  for (const el of document.querySelectorAll("[data-aio-login]")) el.removeAttribute("data-aio-login");
  const visible = (e) => e.getClientRects().length > 0 && !e.disabled && !e.readOnly;
  const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (password) {
    password.setAttribute("data-aio-login", "password");
    const inputs = [...(password.form || document).querySelectorAll("input")];
    const before = inputs.slice(0, inputs.indexOf(password)).filter((i) => ["text", "email", "tel"].includes((i.getAttribute("type") || "text").toLowerCase()) && visible(i));
    const username = before[before.length - 1];
    if (username) username.setAttribute("data-aio-login", "username");
    return { password: true, username: Boolean(username) };
  }
  const likely = 'input[autocomplete~="username" i], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[name*="account" i], input[id*="user" i], input[id*="email" i], input[id*="login" i]';
  const username = [...document.querySelectorAll(likely)].find(visible);
  if (username) username.setAttribute("data-aio-login", "username");
  return { password: false, username: Boolean(username) };
}`;

/** Empties every password box on the page, so nothing the agent reads afterwards holds the password. */
export const CLEAR_PASSWORDS_SCRIPT = `() => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  for (const el of document.querySelectorAll('input[type="password"]')) {
    if (!el.value) continue;
    set.call(el, "");
    el.setAttribute("value", "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  for (const el of document.querySelectorAll("[data-aio-login]")) el.removeAttribute("data-aio-login");
  return true;
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign in on one page of the Mac's Chrome: from a fresh load of `startUrl`, the
 * steps (the agent's, or the ones kept for the site), else the form guessed.
 * The caller locks the page meanwhile and empties its password boxes after.
 */
export async function runMacLogin(call: MacCall, pageId: number, plan: { site: string; steps: LoginStep[] | null; startUrl: string }, username: string, password: string): Promise<MacLoginOutcome> {
  const secrets = [username, password];
  const run = async (name: string, args: Record<string, unknown>) => call(name, { pageId, ...args });
  const act = async (selector: string, action: Parameters<typeof findScript>[1]) => scriptValue(await run("evaluate_script", { function: findScript(selector, action) })) as { ok?: boolean; error?: string; type?: string; host?: string } | null;
  const type = async (selector: string, value: string, isPassword: boolean): Promise<string | null> => {
    const found = await act(selector, isPassword ? "focus-password" : "focus");
    if (found?.error === "not_password") return `does not point at a password box (type=${found.type}); the password only goes into a password box`;
    if (!found?.ok) return found?.error ?? "the box could not be focused";
    // An account is only ever typed into the site it was saved for, wherever the steps led.
    if (!found.host || !siteCovers(plan.site, found.host.toLowerCase())) return `the page is on ${found.host || "another page"}, not ${plan.site}; nothing was typed`;
    await run("type_text", { text: value });
    return null;
  };
  try {
    await run("navigate_page", { type: "url", url: plan.startUrl });
    if (plan.steps) {
      for (const [i, step] of plan.steps.entries()) {
        const where = `Step ${i + 1} (${label(step)})`;
        let problem: string | null = null;
        if (step.action === "fill") {
          const value = step.value === "{{username}}" ? username : step.value === "{{password}}" ? password : step.value!;
          problem = await type(step.selector!, value, step.value === "{{password}}");
        } else if (step.action === "click") {
          const done = await act(step.selector!, "click");
          if (!done?.ok) problem = done?.error ?? "the click did not happen";
        } else if (step.action === "select") {
          const done = await act(step.selector!, { select: step.value! });
          if (!done?.ok) problem = done?.error ?? "the option could not be chosen";
        } else if (step.action === "press") {
          if (step.selector) {
            const done = await act(step.selector, "focus");
            if (!done?.ok) problem = done?.error ?? "the box could not be focused";
          }
          if (!problem) await run("press_key", { key: step.key! });
        } else if (step.selector) {
          const done = await act(step.selector, "exists");
          if (!done?.ok) problem = done?.error ?? "it did not appear";
        } else await sleep(step.ms ?? 0);
        if (problem) return { result: "failed", error: scrub(`${where} failed: ${problem}`, secrets) };
      }
      await sleep(1500);
      return { result: "submitted" };
    }
    // No steps: find the form, as a person would.
    let form = scriptValue(await run("evaluate_script", { function: GUESS_SCRIPT })) as { password?: boolean; username?: boolean } | null;
    if (!form?.password && !form?.username) return { result: "no_form" };
    if (!form.password) {
      // An account-first sign-in: the password box appears after the account is sent.
      const problem = await type('[data-aio-login="username"]', username, false);
      if (problem) return { result: "failed", error: scrub(`Filling the account failed: ${problem}`, secrets) };
      await run("press_key", { key: "Enter" });
      const until = Date.now() + STEP_MS;
      do {
        await sleep(400);
        form = scriptValue(await run("evaluate_script", { function: GUESS_SCRIPT })) as typeof form;
      } while (!form?.password && Date.now() < until);
      if (!form?.password) return { result: "username_only" };
    } else if (form.username && username) {
      const problem = await type('[data-aio-login="username"]', username, false);
      if (problem) return { result: "failed", error: scrub(`Filling the account failed: ${problem}`, secrets) };
    }
    const problem = await type('[data-aio-login="password"]', password, true);
    if (problem) return { result: "failed", error: scrub(`Filling the password failed: ${problem}`, secrets) };
    await run("press_key", { key: "Enter" });
    await sleep(1500);
    return { result: "submitted" };
  } catch (err) {
    return { result: "failed", error: scrub(err instanceof Error ? err.message : String(err), secrets) };
  }
}
