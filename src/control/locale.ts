import type { Db } from "./db.js";
import { getMeta, setMeta } from "./db.js";

/**
 * The console languages (the same ids as LOCALES in src/ui/src/i18n). Prompts are
 * written in English; what a model writes for people follows the account's choice.
 */
export const LOCALE_NAMES = {
    "zh-CN": "Simplified Chinese (简体中文)",
    en: "English",
    es: "Spanish (español)",
    "zh-TW": "Traditional Chinese (繁體中文)",
} as const;
export type Locale = keyof typeof LOCALE_NAMES;
export const DEFAULT_LOCALE: Locale = "zh-CN";
const LOCALE_META_KEY = "account.locale";

export function isLocale(value: unknown): value is Locale {
    return typeof value === "string" && Object.hasOwn(LOCALE_NAMES, value);
}

/** The account's console language; each account's runtime database holds its own. */
export function readLocale(db: Db): Locale {
    const value = getMeta(db, LOCALE_META_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function writeLocale(db: Db, locale: Locale): void {
    if (getMeta(db, LOCALE_META_KEY) !== locale) setMeta(db, LOCALE_META_KEY, locale);
}

/**
 * The last line of every prompt whose output people see. With `followMessage`
 * the answer is in the language the person wrote in, and the console language
 * only settles a message without one of its own (a new account starts in a
 * console language it never chose); without it (a scheduled run, whose
 * instruction may be system-written) the console language decides.
 */
export function answerLanguage(locale: Locale, followMessage = false): string {
    const target = followMessage
        ? `in the language the user's own message is written in, whatever language these instructions and the other materials are in; only when that message has no clear language of its own (just a link, numbers, a name or emoji) use ${LOCALE_NAMES[locale]}, the language of their console`
        : `in ${LOCALE_NAMES[locale]}, whatever language these instructions and the materials above are in`;
    return `Language: write everything the user will see (replies, questions, titles, cards, notes and files made for the user) ${target}. Keep names, quotations, code, links and identifiers as they are.`;
}
