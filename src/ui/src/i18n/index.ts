import { zh, type Messages } from "./locales/zh";
import { en } from "./locales/en";

/**
 * Every word the console shows lives in `locales/<language>/`, one file per
 * area, never in a component. A message is a string, or a function when it
 * takes values (so each language words counts and order its own way); the
 * Chinese files define the shape and every other language must match it
 * exactly, which the type checker enforces.
 *
 * The language is chosen once at load: switching stores the choice and
 * reloads, so no component needs to re-render on a language change and plain
 * modules can use `t` too. Chinese is the default; English only when chosen.
 */
export const LOCALES = { "zh-CN": zh, en } satisfies Record<string, Messages>;
export type Locale = keyof typeof LOCALES;

const STORAGE_KEY = "aio.locale";
const DEFAULT_LOCALE: Locale = "zh-CN";

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(LOCALES, value);
}

function storedLocale(): Locale {
  // Outside a browser (unit tests) there is no stored choice.
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export const locale: Locale = storedLocale();

/** The messages of the current language. */
export const t: Messages = LOCALES[locale];

/** Store a language and reload into it. */
export function setLocale(next: Locale): void {
  if (next === locale) return;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode: nothing to remember */ }
  location.reload();
}

export type { Messages };
