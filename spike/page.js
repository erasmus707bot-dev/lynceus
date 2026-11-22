import { cspWorker as blobWorker, run } from './boot.js';
// Test-only variants: ?noguard=1 disables the JS/Python stubs (CSP alone); ?urlworker=1 loads workers by URL instead of blob:.
const Q = new URLSearchParams(location.search);
const noguard = Q.get('noguard') === '1';
const cspWorker = Q.get('urlworker') === '1' ? (p) => new Worker(p, { type: 'module' }) : blobWorker;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    const el = document.getElementById('sw'); if (el) el.textContent = 'service worker: ready (app files cached for offline)';
  }).catch((e) => { const el = document.getElementById('sw'); if (el) el.textContent = 'service worker failed: ' + e; });
}

async function readSamples(dir) {
  const list = await (await fetch('samples/manifest.json')).json();
  const files = {};
  for (const f of list.filter((x) => x.startsWith(dir + '/'))) files[f.slice(dir.length + 1)] = await (await fetch('samples/' + f)).text();
  return files;
}

const spikes = {
  py: async () => run(cspWorker('py-worker.js'), { files: await readSamples('py') }),
  js: async () => {
    const f = await readSamples('js');
    return run(cspWorker('js-worker.js'), { files: Object.fromEntries(Object.entries(f).map(([k, v]) => ['/src/' + k, v])) });
  },
  exfil: async () => {
    const f = await readSamples('exfil');
    const py = await run(cspWorker('py-worker.js'), { files: { 'test_exfil.py': f['test_exfil.py'] }, noguard });
    const js = await run(cspWorker('js-worker.js'), { files: { '/src/exfil.test.js': f['exfil.test.js'] }, noguard });
    return { py, js };
  },
};

window.runSpike = async () => {
  const kind = document.body.dataset.spike;
  const status = document.getElementById('status');
  status.textContent = 'running…';
  const t = performance.now();
  const res = await spikes[kind]();
  status.textContent = `done in ${Math.round(performance.now() - t)} ms`;
  document.getElementById('out').textContent = JSON.stringify(res, null, 2);
  return res;
};
document.getElementById('run')?.addEventListener('click', () => window.runSpike());
document.addEventListener('securitypolicyviolation', (e) => console.warn('CSP violation', e.violatedDirective, e.blockedURI));
