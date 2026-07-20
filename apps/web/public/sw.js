/*
 * DineDirect service worker — offline resilience for the app shell.
 *
 * Scope, deliberately narrow: this caches the STATIC app shell (HTML document, JS, CSS,
 * fonts, images) so the dashboard still *loads* when the Wi-Fi blips, instead of the
 * browser's dinosaur page. It NEVER caches `/api` responses — serving a kitchen a stale
 * "active orders" list from cache would be worse than showing nothing, and mixing tenants'
 * cached data behind one cache is a security hazard. Data freshness stays with the app
 * (React Query in memory + the online/offline banner). Payments never happen offline.
 *
 * Strategy:
 *   - navigations (HTML): network-first, fall back to the cached shell when offline.
 *   - static assets (_next/static, fonts, images): cache-first (they're content-hashed).
 *   - everything else, and all /api: passthrough (network only).
 */
const CACHE = 'dinedirect-shell-v1';
const OFFLINE_URL = '/dashboard';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL]).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never touch the API or cross-origin requests — those must always hit the network.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;

  // HTML navigations: network-first so staff always get the live app when online, with
  // the last-cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(OFFLINE_URL, copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Content-hashed static assets: cache-first (a hashed URL never changes contents).
  if (
    url.pathname.startsWith('/_next/static') ||
    /\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
            return res;
          }),
      ),
    );
  }
});
