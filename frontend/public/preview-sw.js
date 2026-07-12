const CACHE_PREFIX = 'preview-';
const GENERAL_CACHE = 'preview-general';
const OFFLINE_CACHE = 'offline-media'; // "available offline" items — never evicted
const SHELL_CACHE   = 'app-shell';     // index.html + hashed bundles for offline app-open

// Take control of open clients as soon as an updated worker is deployed, so
// fixes (and cache purges) reach the installed PWA without waiting for every
// tab to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const isPreviewRequest = url =>
  /\/api\/files\/[^/]+\/(thumbnail|preview)/.test(new URL(url).pathname);

// True for the app shell: navigations and same-origin static assets (JS/CSS/
// manifest/icons). NOT /api (needs fresh, authenticated data).
const isShellRequest = (request, url) =>
  request.mode === 'navigate' ||
  (url.origin === self.location.origin &&
    !url.pathname.startsWith('/api/') &&
    /\.(js|css|webmanifest|ico|png|svg|woff2?)$/.test(url.pathname));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (isPreviewRequest(event.request.url)) {
    event.respondWith(serve(event.request));
  } else if (isShellRequest(event.request, url)) {
    event.respondWith(shell(event.request));
  }
});

async function serve(request) {
  // Offline ("available offline") items first — they must survive eviction.
  const offline = await caches.open(OFFLINE_CACHE);
  const offlineHit = await offline.match(request);
  if (offlineHit) return offlineHit;

  // Then per-session caches (most recently saved first)
  const allCaches = await caches.keys();
  const sessionCaches = allCaches
    .filter(n => n.startsWith(CACHE_PREFIX) && n !== GENERAL_CACHE)
    .reverse();

  for (const name of sessionCaches) {
    const c = await caches.open(name);
    const hit = await c.match(request);
    if (hit) return hit;
  }

  // General overflow cache
  const general = await caches.open(GENERAL_CACHE);
  const hit = await general.match(request);
  if (hit) return hit;

  // Cache miss — fetch and store in general cache
  try {
    const response = await fetch(request);
    if (response.ok) general.put(request, response.clone());
    return response;
  } catch (err) {
    return hit || Response.error();
  }
}

// App shell: network-first (so online always gets the latest deploy — the
// in-app update check still works), falling back to cache when offline.
async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Navigation offline with no cached page → fall back to the cached shell.
    if (request.mode === 'navigate') {
      const index = await cache.match('/index.html') || await cache.match('/');
      if (index) return index;
    }
    return Response.error();
  }
}

// Message API
self.addEventListener('message', event => {
  const { type, sessionId, urls } = event.data ?? {};

  if (type === 'CACHE_SESSION') {
    // Only promote what is already in the general cache — no extra fetches.
    event.waitUntil(
      (async () => {
        const general = await caches.open(GENERAL_CACHE);
        const session = await caches.open(CACHE_PREFIX + sessionId);
        await Promise.allSettled(
          urls.map(async url => {
            const cached = await general.match(url);
            if (cached) await session.put(url, cached);
          })
        );
      })()
    );
  }

  if (type === 'DELETE_SESSION') {
    event.waitUntil(caches.delete(CACHE_PREFIX + sessionId));
  }
});
