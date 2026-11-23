// Lynceus service worker. Caches APP FILES ONLY (list written at build time).
// It never caches user code: code lives in page memory (or, if the user opts in, IndexedDB).
// One exception, "Share to Lynceus" (Android): the phone POSTs the shared text or files to ./share. This worker
// holds them in a separate cache only until the page opens, and the page deletes that cache as soon as it reads it.
const VERSION = '__LYNCEUS_VERSION__';
const CACHE = 'lynceus-app-' + VERSION;
const FILES = self.__LYNCEUS_FILES__;
// Pyodide (Lynceus's own self-hosted Python runtime, ~13 MB) is NOT precached. It is stored the
// first time a Python review downloads it, so later Python reviews work offline.
const PYODIDE_CACHE = '__PYODIDE_CACHE__';
const SHARE_CACHE = 'lynceus-share';
const MAX_SHARED_FILES = 50;
const MAX_SHARED_BYTES = 20_000_000;

async function receiveShare(req) {
  const scope = self.registration.scope;
  try {
    const form = await req.formData();
    await caches.delete(SHARE_CACHE); // never keep an older share around
    const cache = await caches.open(SHARE_CACHE);
    const str = (k) => { const v = form.get(k); return typeof v === 'string' ? v.slice(0, 2_000_000) : ''; };
    const meta = { title: str('title'), text: str('text'), url: str('url'), files: [], dropped: [] };
    let total = 0;
    for (const f of form.getAll('files')) {
      if (typeof f === 'string') continue;
      if (meta.files.length >= MAX_SHARED_FILES || total + f.size > MAX_SHARED_BYTES) { meta.dropped.push(f.name || 'file'); continue; }
      total += f.size;
      const key = new URL('__share/' + meta.files.length, scope).href;
      await cache.put(key, new Response(f));
      meta.files.push({ key, name: f.name || 'shared-file' });
    }
    await cache.put(new URL('__share/meta', scope).href, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect(scope + '?shared=1', 303);
  } catch {
    return Response.redirect(scope + '?shared=error', 303);
  }
}

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
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === new URL('share', self.registration.scope).pathname) {
    event.respondWith(receiveShare(req));
    return;
  }
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
