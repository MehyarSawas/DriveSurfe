const CACHE_PREFIX = 'preview-';
const GENERAL_CACHE = 'preview-general';
const SHELL_CACHE   = 'app-shell-v1'; // index.html + hashed bundles for offline open

// Take control of open clients as soon as an updated worker is deployed, so
// fixes (and cache purges) reach the installed PWA without waiting for every
// tab to close.
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(precacheShell());
});

self.addEventListener('activate', event => event.waitUntil((async () => {
  // Drop old shell cache versions.
  const keys = await caches.keys();
  await Promise.all(
    keys.filter(k => k.startsWith('app-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))
  );
  await self.clients.claim();
})()));

/** Cache index.html + the JS/CSS bundles it references, so the app can open
 *  offline. Best-effort: if we're offline there's nothing to refresh — it'll
 *  fill in on the next online load. Re-run on every online navigation so the
 *  cached index and its bundles always come from the SAME (latest) version —
 *  otherwise a later deploy leaves the cached index pointing at bundle hashes
 *  that aren't cached, and the app opens to a white screen offline. */
async function precacheShell() {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const res = await fetch('index.html', { cache: 'no-store' });
    if (!res.ok) return;
    await cache.put('/index.html', res.clone());
    const html = await res.text();
    const assets = Array.from(html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))(?:\?[^"]*)?"/g))
      .map(m => m[1])
      .filter(u => !/^https?:/.test(u)); // same-origin only
    await Promise.allSettled(assets.map(a => cache.add(a)));
  } catch { /* offline — skip */ }
}

const isPreviewRequest = url =>
  /\/api\/files\/[^/]+\/(thumbnail|preview)/.test(new URL(url).pathname);

// Immutable, content-hashed bundles (safe to serve cache-first — the filename
// changes on every deploy, so a cached copy is never stale).
const isHashedAsset = url =>
  url.origin === self.location.origin &&
  !url.pathname.startsWith('/api/') &&
  /\.(js|css)$/.test(url.pathname);

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const req = event.request;
  const url = new URL(req.url);
  if (isPreviewRequest(req.url)) {
    event.respondWith(serve(req));
  } else if (req.mode === 'navigate') {
    event.respondWith(navigate(req));
  } else if (isHashedAsset(url)) {
    event.respondWith(asset(req));
  }
  // Everything else (API calls, fonts, images) is left untouched.
});

// Navigations: pure network when online (identical to no-SW behaviour, so it
// can't break normal loading), falling back to the cached shell only when the
// network genuinely fails. The nav response itself is never cached (avoids
// navigate-mode caching pitfalls); the offline shell comes from precache.
async function navigate(request) {
  try {
    const response = await fetch(request);
    // Keep the offline snapshot in sync with the version just loaded online:
    // refresh the cached index AND its bundle list so they never drift apart.
    precacheShell();
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('/index.html')) || Response.error();
  }
}

// Hashed JS/CSS: cache-first, fetch + cache on miss. Refreshes the precache as
// new bundles appear online, so the offline snapshot stays consistent.
async function asset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    return cached || Response.error();
  }
}

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
  try {
    const response = await fetch(request);
    if (response.ok) general.put(request, response.clone());
    return response;
  } catch (err) {
    return hit || Response.error();
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
