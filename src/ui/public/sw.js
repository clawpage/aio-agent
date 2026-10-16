/*
 * 一站 service worker: phone notifications, and opening the console without a network.
 *
 * Opening the console always asks the network first, so it is the latest deployed page
 * whenever the server answers; only when it cannot be reached does the last page that
 * loaded open instead (the console then says it is offline). Hashed build files never
 * change, so they come from the cache once fetched. /api and other sites are never touched.
 */
const CACHE = "aio-console-v1";
/** The one console page: every console route (/, /login, /u/<name>/…) is the same index.html. */
const PAGE = "/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // The page open right now loaded before this worker existed: keep a copy of it at once.
  event.waitUntil(fetch(PAGE, { cache: "no-store" }).then((response) => (response.ok ? remember(response) : undefined)).catch(() => undefined));
});
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  // The page request starts while the worker wakes up, so the network is not waited on twice.
  await self.registration.navigationPreload?.enable().catch(() => undefined);
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
});

async function openPage(event) {
  let response;
  try {
    response = (await event.preloadResponse) || await fetch(event.request);
  } catch (err) {
    const saved = await caches.match(PAGE, { cacheName: CACHE });
    if (saved) return saved;
    throw err;
  }
  if (response.ok && !response.redirected && (response.headers.get("content-type") || "").startsWith("text/html")) {
    event.waitUntil(remember(response.clone()));
    return response;
  }
  // The tunnel or the edge is down (a 5xx error page): the saved console explains it better.
  if (response.status >= 500) return (await caches.match(PAGE, { cacheName: CACHE })) || response;
  return response;
}

/** Keeps the page that just loaded and the build files it names; a new deploy drops the old build's files. */
async function remember(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  const before = await cache.match(PAGE);
  await cache.put(PAGE, response);
  if (before && (await before.text()) !== html) {
    // Lazily loaded files of the new build are fetched (and kept) again on use.
    for (const key of await cache.keys()) {
      const path = new URL(key.url).pathname;
      if (path.startsWith("/assets/") && !html.includes(path)) await cache.delete(key);
    }
  }
  const named = new Set(html.match(/\/assets\/[^"'\s)]+/g) || []);
  await Promise.all([...named].map(async (path) => {
    if (await cache.match(path)) return;
    const file = await fetch(path).catch(() => undefined);
    if (file && file.status === 200) await cache.put(path, file);
  }));
}

async function buildFile(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(event.request);
  if (saved) return saved;
  const response = await fetch(event.request);
  if (response.ok && response.status === 200) event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "一站", {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  }));
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
