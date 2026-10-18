import type { Db } from "./db.js";
import { getMeta, setMeta } from "./db.js";

/**
 * The console languages (the same ids as LOCALES in src/ui/src/i18n). Prompts are
 * written in English; what a model writes for people follows the account's choice.
 */
export const LOCALE_NAMES = {
    "zh-CN": "Simplified Chinese (简体中文)", // i18n-exempt: language name in English prompts for the model
    en: "English",
    es: "Spanish (español)",
    "zh-TW": "Traditional Chinese (繁體中文)", // i18n-exempt: language name in English prompts for the model
} as const;
export type Locale = keyof typeof LOCALE_NAMES;
/** The language of an account, a request or a process that has none of its own. */
export const DEFAULT_LOCALE: Locale = "en";
const LOCALE_META_KEY = "account.locale";

export function isLocale(value: unknown): value is Locale {
    return typeof value === "string" && Object.hasOwn(LOCALE_NAMES, value);
}

/** The console language closest to a BCP 47 tag such as "es-ES" or "zh-Hant-HK", if any (as the console's matchLocale). */
export function matchLocale(tag: string): Locale | null {
    const lower = tag.trim().toLowerCase();
    if (lower === "zh" || lower.startsWith("zh-")) return /^zh-(hant|tw|hk|mo)\b/.test(lower) ? "zh-TW" : "zh-CN";
    if (lower === "en" || lower.startsWith("en-")) return "en";
    if (lower === "es" || lower.startsWith("es-")) return "es";
    return null;
}

/** The first language of an Accept-Language header the console speaks, in the order of preference it gives. */
export function acceptedLocale(header: string | undefined): Locale | null {
    const tags = (header ?? "").split(",").map((part, index) => {
        const [tag, ...params] = part.split(";");
        const q = params.map(p => p.trim()).find(p => p.startsWith("q="));
        return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, index };
    }).filter(e => e.tag && e.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
    for (const { tag } of tags) {
        const match = matchLocale(tag);
        if (match) return match;
    }
    return null;
}

/** The account's console language; each account's runtime database holds its own. */
export function readLocale(db: Db): Locale {
    const value = getMeta(db, LOCALE_META_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Set once the person picks a language on the settings page; nothing automatic overrides it after that. */
const MANUAL_META_KEY = "account.locale.manual";
/** Set once a console has reported its system language on opening; that happens only once per account. */
const SYNCED_META_KEY = "account.locale.synced";

/**
 * How a language reaches the account: `manual` is a choice on the settings page
 * and always applies; `message` is the console a message was sent from, and
 * `open` the language a console opened in (once per account); both only apply
 * while the person has not chosen one. Returns whether this write applied.
 */
export function writeLocale(db: Db, locale: Locale, source: "manual" | "message" | "open"): boolean {
    if (source === "manual") setMeta(db, MANUAL_META_KEY, "1");
    else if (getMeta(db, MANUAL_META_KEY)) return false;
    if (source === "open") {
        if (getMeta(db, SYNCED_META_KEY)) return false;
        setMeta(db, SYNCED_META_KEY, "1");
    }
    if (getMeta(db, LOCALE_META_KEY) !== locale) setMeta(db, LOCALE_META_KEY, locale);
    return true;
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
