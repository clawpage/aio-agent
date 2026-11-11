/*
 * 一站 service worker: phone notifications, and opening the console fast and without a network.
 *
 * Opening the console shows the last page that loaded at once, without waiting on the network,
 * and fetches the deployed page behind it for the next opening. Only a console that has never
 * loaded asks the network first. A saved page too old for the service it talks to is dropped by
 * the page itself (App.tsx), which then loads the deployed one. Hashed build files never change,
 * so they come from the cache once fetched. /api and other sites are never touched.
 * A deployed page that arrives but cannot be kept drops the saved one, so a device whose saves fail
 * opens from the network instead of staying on an old console for good.
 */
/**
 * v2: a fresh start for devices left on an old saved page by saves that failed (2026-11-06).
 * v3: again, for iPhones whose saved page was never replaced after a deploy (2026-11-11, see openPage).
 */
const CACHE = "aio-console-v3";
/** The one console page: every console route (/, /login, /u/<name>/…) is the same index.html. */
const PAGE = "/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // The page open right now loaded before this worker existed: keep a copy of it at once.
  event.waitUntil(fetch(PAGE, { cache: "no-store" }).then((response) => (response.ok ? remember(response) : undefined)).catch(() => undefined));
});
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  // No navigation preload: in Safari its answer could stay pending for good, and the saved page with it.
  await self.registration.navigationPreload?.disable().catch(() => undefined);
  for (const name of await caches.keys()) if (name.startsWith("aio-console-") && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Console routes have no file extension; the policy pages and other files are left alone.
  if (request.mode === "navigate" && request.destination === "document" && !/\.[^/]*$/.test(url.pathname)) event.respondWith(openPage(event));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(buildFile(event));
  else if (url.pathname === GUARD) event.respondWith(guardFile(event));
});

/** The start guard the page loads before the app (boot.js): from the cache at once, refreshed behind, so it never holds an opening up. */
const GUARD = "/boot.js";
async function guardFile(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(GUARD);
  // Past the browser's own cache: a proxy in front may let it keep this file for hours.
  const fresh = fetch(GUARD, { cache: "no-store" }).then(async (response) => {
    if (response.ok && response.status === 200) await cache.put(GUARD, response.clone());
    return response;
  });
  if (saved) { event.waitUntil(fresh.catch(() => undefined)); return saved; }
  return fresh;
}

async function openPage(event) {
  const saved = await caches.match(PAGE, { cacheName: CACHE });
  if (saved) {
    // The deployed page is fetched behind the saved one and kept for the next opening.
    event.waitUntil((async () => {
      const response = await fetch(PAGE, { cache: "no-store" });
      if (!response.ok || response.redirected || !(response.headers.get("content-type") || "").startsWith("text/html")) return;
      // Offline the fetch above fails and the saved page stays; here the server answered and keeping it failed.
      try { await remember(response); } catch { await (await caches.open(CACHE)).delete(PAGE).catch(() => undefined); }
    })().catch(() => undefined));
    // Said in Server-Timing, so the page can report how it was opened (src/ui/src/bootTiming.ts).
    const headers = new Headers(saved.headers);
    headers.set("Server-Timing", "sw;desc=cache");
    return new Response(saved.body, { status: saved.status, statusText: saved.statusText, headers });
  }
  const response = await fetch(event.request);
  if (response.ok && !response.redirected && (response.headers.get("content-type") || "").startsWith("text/html")) event.waitUntil(remember(response.clone()));
  return response;
}

/**
 * Keeps the deployed page for the next opening and the build files it names. A new deploy drops
 * the files of the build before the one being replaced: the page open now may still be that one.
 */
async function remember(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  const before = await cache.match(PAGE);
  const previous = before ? await before.text() : null;
  await cache.put(PAGE, response);
  if (previous !== null && previous !== html) {
    // Lazily loaded files of the new build are fetched (and kept) again on use.
    for (const key of await cache.keys()) {
      const path = new URL(key.url).pathname;
      if (path.startsWith("/assets/") && !html.includes(path) && !previous.includes(path)) await cache.delete(key);
    }
  }
  const named = new Set(html.match(/\/assets\/[^"'\s)]+/g) || []);
  await Promise.all([...named].map(async (path) => {
    if (await cache.match(path)) return;
    const file = await fetch(path).catch(() => undefined);
    if (file && keepable(file)) await cache.put(path, file);
  }));
}

async function buildFile(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(event.request);
  if (saved) return saved;
  const response = await fetch(event.request);
  if (keepable(response)) event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

/** A build file as built. The sheet a gone build's page gets in place of its styles (edge.mjs, no-store) is never kept. */
const keepable = (response) => response.status === 200 && !/no-store/i.test(response.headers.get("cache-control") || "");

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil((async () => {
    // Not shown while the console is on screen, which already says it (the server skips such a
    // device by its heartbeat, so one can still arrive in the meantime).
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((client) => client.visibilityState === "visible" && new URL(client.url).origin === self.location.origin)) return;
    await self.registration.showNotification(data.title || "Clawpage Agent", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && "focus" in client) return client.focus();
    }
    return self.clients.openWindow(url);
  }));
});
