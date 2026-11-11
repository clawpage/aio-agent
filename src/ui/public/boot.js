/*
 * Start guard for the console. Loaded in <head> before the app's module script: if that script
 * fails to load (a phone on a poor network once never got the 1.3 MB bundle and sat on the splash
 * for good) or throws before main.tsx starts, the page is loaded again, the second time without the
 * service worker's saved copies; after that it says what went wrong and offers to try again, so a
 * screenshot shows the cause. main.tsx sets window.__aioStarted as it begins.
 */
(() => {
  const KEY = "aio-boot-retry";
  const WAIT_MS = 20000;
  const errors = [];
  let settled = false;
  addEventListener("error", (event) => {
    const target = event.target;
    if (target && target.tagName === "SCRIPT") errors.push(`script not loaded: ${String(target.src).split("/").pop()}`);
    else if (event.message) errors.push(`${event.message}${event.filename ? ` (${String(event.filename).split("/").pop()}:${event.lineno})` : ""}`);
    if (target && target.tagName === "SCRIPT" && target.type === "module") setTimeout(check, 0);
  }, true);
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    errors.push(`unhandled: ${(reason && reason.message) || String(reason)}`);
  });
  setTimeout(check, WAIT_MS);

  // The service worker opens the console from a saved page and replaces it with the deployed one behind
  // it. In Safari an older worker never did (its page request stayed pending, which also kept a newer
  // worker from taking over), so a phone stayed on an old build for good. The guard does the same job
  // for whichever worker runs: no-op when the saved page is already the deployed one.
  async function refresh() {
    const response = await fetch("/", { cache: "no-store" });
    if (!response.ok || response.redirected || !(response.headers.get("content-type") || "").startsWith("text/html")) return;
    const html = await response.text();
    for (const name of await caches.keys()) {
      if (!name.startsWith("aio-console-")) continue;
      const cache = await caches.open(name);
      const saved = await cache.match("/");
      if (saved && (await saved.text()) !== html) await cache.put("/", new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
    }
  }
  // A page from a build that is gone got the "out of date" sheet in place of its styles (edge.mjs marks it
  // with --aio-stale), and reloading would open the same saved page: the saved page is replaced first, and
  // if that did not help, the saved copies and the worker go.
  const STALE = "aio-stale-retry";
  addEventListener("load", () => {
    let n = 2;
    try {
      if (!getComputedStyle(document.documentElement).getPropertyValue("--aio-stale").trim()) {
        sessionStorage.removeItem(STALE);
        setTimeout(() => void refresh().catch(() => undefined), 3000);
        return;
      }
      n = Number(sessionStorage.getItem(STALE) || 0);
      if (n < 2) sessionStorage.setItem(STALE, String(n + 1));
    } catch { return; }
    if (n >= 2) return;
    settled = true;
    void (n === 0 ? refresh() : forget()).catch(() => undefined).then(() => location.reload());
  });

  const tries = () => { try { return Number(sessionStorage.getItem(KEY) || 0); } catch { return 2; } };
  function check() {
    if (settled) return;
    if (window.__aioStarted) { settled = true; try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ } return; }
    settled = true;
    const n = tries();
    if (n >= 2) return show();
    try { sessionStorage.setItem(KEY, String(n + 1)); } catch { return show(); }
    // The first time just again; the second without the saved page and files, in case a saved copy is the broken part.
    if (n === 0) location.reload();
    else void forget().then(() => location.reload());
  }

  async function forget() {
    try {
      for (const name of await caches.keys()) if (name.startsWith("aio-console-")) await caches.delete(name);
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    } catch { /* nothing to forget */ }
  }

  function show() {
    const zh = /^zh\b/i.test(navigator.language || "");
    const root = document.getElementById("root") || document.body;
    root.innerHTML = "";
    const box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#9d98ae";
    const text = document.createElement("p");
    text.style.margin = "0";
    text.textContent = zh ? "页面没能加载完成，可能是网络不稳定。" : "The page did not finish loading. The network may be unstable.";
    const detail = document.createElement("p");
    detail.style.cssText = "margin:0;font-size:12px;max-width:100%;overflow-wrap:anywhere;opacity:.8";
    detail.textContent = errors.length ? errors.slice(-3).join(" · ") : (zh ? "加载超时" : "Timed out");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = zh ? "重新加载" : "Reload";
    button.style.cssText = "font:inherit;padding:8px 18px;border-radius:20px;border:0;background:#8f86ff;color:#15131c";
    button.addEventListener("click", () => { try { sessionStorage.removeItem(KEY); } catch { /* fine */ } void forget().then(() => location.reload()); });
    box.append(text, detail, button);
    root.append(box);
  }
})();
