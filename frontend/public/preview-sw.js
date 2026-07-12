const CACHE_PREFIX = 'preview-';
const GENERAL_CACHE = 'preview-general';

// Take control of open clients as soon as an updated worker is deployed, so
// fixes (and cache purges) reach the installed PWA without waiting for every
// tab to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const isPreviewRequest = url =>
  /\/api\/files\/[^/]+\/(thumbnail|preview)/.test(new URL(url).pathname);

// Intercept thumbnail and preview requests only
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!isPreviewRequest(event.request.url)) return;
  event.respondWith(serve(event.request));
});

async function serve(request) {
  // Check all session caches first (most recently saved files are prioritised)
  const allCaches = await caches.keys();
  const sessionCaches = allCaches
    .filter(n => n.startsWith(CACHE_PREFIX) && n !== GENERAL_CACHE)
    .reverse(); // newest sessions first

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
  const response = await fetch(request);
  if (response.ok) general.put(request, response.clone());
  return response;
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
