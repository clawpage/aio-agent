/*
 * The public pages (about, privacy, terms, support) hold one complete <section lang="…"> per
 * language and show only the chosen one: `?lang=` in the URL, else the console's own choice
 * (localStorage `aio.locale`), else the first of the browser's languages the console speaks
 * (matched like matchLocale in src/ui/src/i18n/index.ts), else English. Without JavaScript,
 * policy.css shows English. Loaded in <head> without defer, so the page is drawn in the chosen
 * language from the start.
 */
(() => {
  const LOCALES = ["en", "es", "zh-CN", "zh-TW"];
  const match = (tag) => {
    const lower = String(tag).toLowerCase();
    if (lower === "zh" || lower.startsWith("zh-")) return /^zh-(hant|tw|hk|mo)\b/.test(lower) ? "zh-TW" : "zh-CN";
    if (lower === "en" || lower.startsWith("en-")) return "en";
    if (lower === "es" || lower.startsWith("es-")) return "es";
    return null;
  };
  const asked = new URLSearchParams(location.search).get("lang");
  const fromUrl = asked ? match(asked) : null;
  let saved = null;
  try { saved = localStorage.getItem("aio.locale"); } catch { /* private mode: no stored choice */ }
  const system = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  const lang = fromUrl || (LOCALES.includes(saved) ? saved : null) || system.map(match).find(Boolean) || "en";

  const root = document.documentElement;
  root.lang = lang;
  root.dataset.lang = lang;
  document.addEventListener("DOMContentLoaded", () => {
    const section = document.querySelector(`main > section[lang="${lang}"]`);
    if (section?.dataset.title) document.title = section.dataset.title;
    for (const a of document.querySelectorAll(".langs a")) if (a.hreflang === lang) a.setAttribute("aria-current", "true");
    // A language picked in the URL stays picked on the other public pages.
    if (fromUrl) for (const a of document.querySelectorAll("main > section a[href$='.html']")) a.setAttribute("href", `${a.getAttribute("href")}?lang=${lang}`);
  });
})();
