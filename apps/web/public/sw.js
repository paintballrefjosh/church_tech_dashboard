/* Church Dashboard service worker.
 *
 * Conservative caching strategy:
 *  - Static assets (Next chunks, /icon.svg, /manifest) — cache-first.
 *  - Top-level HTML navigations — network-first with a cached fallback so
 *    the app stays usable for a few seconds during a wifi blip.
 *  - Everything else (API, attachments, search) — go straight to network.
 *    Caching API responses would leak between users in a multi-tenant
 *    scenario and stale the bell badge in the single-tenant case; not
 *    worth the trouble.
 *
 * No build step, no Workbox — just a few dozen lines of plain JS. Update
 * CACHE_VERSION when you ship a breaking change so old clients fetch
 * fresh assets.
 */
const CACHE_VERSION = "v1";
const SHELL_CACHE = `church-shell-${CACHE_VERSION}`;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(["/icon.svg", "/manifest.webmanifest"]).catch(() => undefined),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("church-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API + WS + search + auth — always go to network.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/socket.io/") ||
    url.pathname.startsWith("/_next/data/")
  ) {
    return;
  }

  // Cache-first for static asset paths emitted by Next + our public/.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).catch(() => undefined);
        return res;
      }),
    );
    return;
  }

  // HTML navigations: network-first, fall back to whatever's cached so the
  // app still opens to *something* during a wifi blip. We never cache
  // bell-state pages aggressively because they'd be stale.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit ?? new Response("Offline", { status: 503 }))),
    );
  }
});
