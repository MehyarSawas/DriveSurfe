const CACHE_PREFIX = 'preview-';
const GENERAL_CACHE = 'preview-general';

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
    event.waitUntil(
      caches.open(CACHE_PREFIX + sessionId).then(cache =>
        Promise.allSettled(
          urls.map(url =>
            fetch(url).then(r => { if (r.ok) cache.put(url, r); })
          )
        )
      )
    );
  }

  if (type === 'DELETE_SESSION') {
    event.waitUntil(caches.delete(CACHE_PREFIX + sessionId));
  }
});
