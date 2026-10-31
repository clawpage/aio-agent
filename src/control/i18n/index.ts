import { AsyncLocalStorage } from "node:async_hooks";
import { acceptedLocale, DEFAULT_LOCALE, isLocale, type Locale } from "../locale.js";
import { zh, type Messages } from "./locales/zh/index.js";
import { en } from "./locales/en/index.js";
import { es } from "./locales/es/index.js";
import { zhTW } from "./locales/zh-TW/index.js";

/**
 * Every word the control plane writes for people (error messages, task and
 * browser notes, schedule replies, notifications, pages) lives in
 * `locales/<language>/`, one file per area, as the console's own words do in
 * src/ui/src/i18n. The Chinese files define the shape and every other language
 * matches it exactly, which the type checker enforces. What only a model or a
 * log reads is written in English in the code instead.
 *
 * Which language: a request is answered in the language of the console that
 * sent it (`x-aio-locale`), else the browser's (`Accept-Language`); work that
 * runs on its own (a task, a timer) in its account's language. English when
 * none is known.
 */
export const MESSAGES = { "zh-CN": zh, en, es, "zh-TW": zhTW } satisfies Record<Locale, Messages>;

const current = new AsyncLocalStorage<() => Locale>();

/** The language of the request or account this code runs for. */
export function currentLocale(): Locale {
    return current.getStore()?.() ?? DEFAULT_LOCALE;
}

/** The messages of a language; by default the one this code runs for. */
export function t(locale: Locale = currentLocale()): Messages {
    return MESSAGES[locale];
}

/**
 * Run `fn`, and everything it starts (promises, timers), in a language. A
 * function is read each time a message is written, so an account that changes
 * its language is answered in the new one.
 */
export function runInLocale<T>(locale: Locale | (() => Locale), fn: () => T): T {
    return current.run(typeof locale === "function" ? locale : () => locale, fn);
}

/** Run `fn` in the language already in force (a request's), or else in `fallback` (e.g. a timer's, the account's). */
export function runInLocaleOr<T>(fallback: () => Locale, fn: () => T): T {
    return current.getStore() ? fn() : current.run(fallback, fn);
}

/** The language a request asks for: the console's own, else the browser's, else English. */
export function requestLocale(headers: { [name: string]: string | string[] | undefined }): Locale {
    const own = headers["x-aio-locale"];
    if (isLocale(own)) return own;
    const accept = headers["accept-language"];
    return acceptedLocale(Array.isArray(accept) ? accept.join(",") : accept) ?? DEFAULT_LOCALE;
}

export type { Messages };
