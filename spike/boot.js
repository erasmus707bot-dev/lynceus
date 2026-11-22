// Workers loaded from a normal URL take their CSP from their OWN HTTP response
// headers, and GitHub Pages sends none, so a <meta> CSP would not cover them.
// A worker created from a blob: URL inherits the creating document's policy,
// including a <meta> policy. This helper builds that blob.
export function cspWorker(path) {
  const abs = new URL(path, location.href).href;
  const blob = new Blob([`import ${JSON.stringify(abs)};`], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}
export function run(worker, msg) {
  return new Promise((res) => { worker.onmessage = (e) => res(e.data); worker.onerror = (e) => res({ fatal: e.message || String(e) }); worker.postMessage(msg); });
}
