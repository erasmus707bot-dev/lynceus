const CACHE = 'lynceus-spike-v1';
const FILES = ['./', 'index.html', 'py.html', 'js.html', 'exfil.html', 'boot.js', 'guard.js', 'page.js', 'py-worker.js', 'js-worker.js',
  'vendor/istanbul.mjs', 'vendor/pyodide/pyodide.mjs', 'vendor/pyodide/pyodide.asm.mjs', 'vendor/pyodide/pyodide.asm.wasm',
  'vendor/pyodide/python_stdlib.zip', 'vendor/pyodide/pyodide-lock.json', 'vendor/pyodide/package.json', 'vendor/wheels/manifest.json',
  'samples/manifest.json'];
self.addEventListener('install', (e) => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  const wheels = await (await fetch('vendor/wheels/manifest.json')).json();
  const samples = await (await fetch('samples/manifest.json')).json();
  await c.addAll([...FILES, ...wheels.map((w) => 'vendor/wheels/' + w), ...samples.map((s) => 'samples/' + s)]);
  self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).origin !== location.origin) return; // never touch foreign requests
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
