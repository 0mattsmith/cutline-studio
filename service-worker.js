/*
 * Cutline Studio service worker — makes the PWA usable offline after first load.
 *
 *   Strategy:
 *     • version.json: network-first (no-store) so update checks always read the latest release.
 *     • App shell & vendored libs (HTML/CSS/JS/icons/manifest): stale-while-revalidate
 *       with ignoreSearch matching so cache-bust query strings work seamlessly.
 *     • Everything else: try network, fall back to cache.
 *
 * Bump CACHE_VERSION when shipping any asset change so old caches get pruned.
 */

const CACHE_VERSION = "v17";
const CACHE_NAME = `cutline-studio-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./layout.js",
  "./borders.js",
  "./app.js",
  "./image-worker.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-maskable.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./vendor/libheif-bundle.js",
  "./vendor/jspdf.umd.min.js",
  "./vendor/docx.umd.min.js",
  "./vendor/FileSaver.min.js",
];

// ─── install ──────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

// ─── activate ─────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ─── fetch ────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Always check network for version.json so the update checker sees new releases immediately.
  if (url.pathname.endsWith("/version.json")) {
    event.respondWith(
      fetch(new Request(req, { cache: "no-store" })).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Stale-while-revalidate for local app shell & vendored assets
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    const networkPromise = fetch(req).then((res) => {
      if (res && res.ok) {
        const cleanUrl = url.origin + url.pathname;
        cache.put(cleanUrl, res.clone());
      }
      return res;
    }).catch(() => null);
    return cached || (await networkPromise) || new Response("Offline", { status: 503 });
  })());
});

// Allow the page to trigger an immediate activation
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
