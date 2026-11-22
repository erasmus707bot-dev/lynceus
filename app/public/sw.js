// Lynceus service worker. Caches APP FILES ONLY (list written at build time).
// It never caches or sees user code: code lives in page memory (or, if the user opts in, IndexedDB).
const VERSION = '__LYNCEUS_VERSION__';
const CACHE = 'lynceus-app-' + VERSION;
const FILES = self.__LYNCEUS_FILES__;
// Pyodide (Lynceus's own self-hosted Python runtime, ~13 MB) is NOT precached. It is stored the
// first time a Python review downloads it, so later Python reviews work offline.
const PYODIDE_CACHE = '__PYODIDE_CACHE__';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('lynceus-app-') && key !== CACHE) await caches.delete(key);
      if (key.startsWith('lynceus-pyodide-') && key !== PYODIDE_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // never touch anything else
  if (url.pathname.includes('/vendor/pyodide/')) {
    event.respondWith((async () => {
      const cache = await caches.open(PYODIDE_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const shell = await cache.match('./'); if (shell) return shell; }
    return fetch(req); // app file not in the list: network only, never stored
  })());
});
