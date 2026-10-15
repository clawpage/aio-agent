import { zh, type Messages } from "./locales/zh";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { zhTW } from "./locales/zh-TW";

/**
 * Every word the console shows lives in `locales/<language>/`, one file per
 * area, never in a component. A message is a string, or a function when it
 * takes values (so each language words counts and order its own way); the
 * Chinese files define the shape and every other language must match it
 * exactly, which the type checker enforces.
 *
 * The language is chosen once at load: switching stores the choice and
 * reloads, so no component needs to re-render on a language change and plain
 * modules can use `t` too. Until a language is chosen on the settings page the
 * console follows the browser's (or the phone's) languages: the first one it
 * speaks, English when it speaks none of them.
 */
export const LOCALES = { "zh-CN": zh, en, es, "zh-TW": zhTW } satisfies Record<string, Messages>;
export type Locale = keyof typeof LOCALES;

const STORAGE_KEY = "aio.locale";
const DEFAULT_LOCALE: Locale = "zh-CN";

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(LOCALES, value);
}

/** The console language closest to a BCP 47 tag such as "es-ES" or "zh-Hant-HK", if any. */
export function matchLocale(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-")) return /^zh-(hant|tw|hk|mo)\b/.test(lower) ? "zh-TW" : "zh-CN";
  if (lower === "en" || lower.startsWith("en-")) return "en";
  if (lower === "es" || lower.startsWith("es-")) return "es";
  return null;
}

/** The first of the system's preferred languages the console speaks; English when it speaks none. */
export function systemLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return "en";
}

function initialLocale(): Locale {
  // Outside a browser (unit tests) there is no stored choice.
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isLocale(value)) return value;
  } catch { /* private mode: no stored choice */ }
  const nav = globalThis.navigator;
  return systemLocale(nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []);
}

export const locale: Locale = initialLocale();

/** The messages of the current language. */
export const t: Messages = LOCALES[locale];

/** Store a language and reload into it. */
export function setLocale(next: Locale): void {
  if (next === locale) return;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode: nothing to remember */ }
  location.reload();
}

export type { Messages };
