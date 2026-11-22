// Lynceus Phase 0 automated check. Run from this folder:  node check.mjs
// Needs: python3, Playwright + Chromium. Writes ../docs/logs/phase0-check.json
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = 'http://127.0.0.1:8000/';
const HITS = path.join(HERE, 'sink-hits.jsonl');
const sinkHits = () => (fs.existsSync(HITS) ? fs.readFileSync(HITS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const clearHits = () => fs.existsSync(HITS) && fs.unlinkSync(HITS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const p = spawn('python3', [path.join(HERE, 'serve.py')], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res) => p.stdout.once('data', () => res(p)));
}
const out = { started: new Date().toISOString(), checks: {}, notes: [] };
const verdict = (name, pass, detail) => { out.checks[name] = { pass, ...detail }; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); };

const server = await startServer();
const browser = await chromium.launch();
try {
  // ---------- main context: service worker ON ----------
  const ctx = await browser.newContext();
  const requests = [];
  ctx.on('request', (r) => requests.push({ url: r.url(), phase: out.phase, req: r }));
  const failedReasons = new Map();
  ctx.on('requestfailed', (r) => failedReasons.set(r, r.failure()?.errorText));
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  out.phase = 'install';
  await page.goto(APP + 'index.html');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== undefined);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });

  const runOn = async (file) => { await page.goto(APP + file); return page.evaluate(() => window.runSpike()); };

  // (b) JS
  out.phase = 'b-online';
  const js = await runOn('js.html');
  const jsOk = !js.fatal && js.results.length === 6 && js.results.filter((r) => r.outcome === 'passed').length === 4
    && js.contexts['/src/calc.js']['3']?.includes('classify > negative') && js.analysis['/src/calc.js'].missing.includes(19);
  verdict('b_istanbul_worker', jsOk, { results: js.results, missing: js.analysis?.['/src/calc.js']?.missing, timing: js.timing });

  // (c) exfiltration, full defenses
  out.phase = 'c-exfil';
  clearHits();
  const before = requests.length;
  const ex = await runOn('exfil.html');
  await sleep(1500);
  const foreign = requests.slice(before).filter((r) => !r.url.startsWith(APP));
  const exOk = !ex.py.fatal && !ex.js.fatal && ex.py.results.every((r) => r.outcome === 'passed') && ex.js.results.every((r) => r.outcome === 'passed')
    && sinkHits().length === 0;
  verdict('c_exfil_blocked', exOk, { py: ex.py.stdout_tail?.match(/EXFIL_RESULTS (.*)/)?.[1], js: ex.js.logs, sinkHits: sinkHits(), foreignRequestsSeenByBrowser: foreign });

  // (a) Python, online first (timing reference)
  out.phase = 'a-online';
  const pyOn = await runOn('py.html');
  const pyCheck = (r) => !r.fatal && r.results.length === 4 && r.results.filter((x) => x.outcome === 'passed').length === 3
    && r.contexts['calc.py']['3']?.includes('test_calc.test_negative') && r.analysis['calc.py'].missing.join() === '5,20,21';
  verdict('a_pyodide_online', pyCheck(pyOn), { core: pyOn.core, timing: pyOn.timing, missing: pyOn.analysis?.['calc.py']?.missing });

  // ---------- CSP variants (service worker blocked, fresh contexts) ----------
  const variant = async (url, mutateCsp) => {
    const c = await browser.newContext({ serviceWorkers: 'block' });
    if (mutateCsp) await c.route('**/*.html', async (route) => {
      const resp = await route.fetch(); let body = await resp.text(); body = mutateCsp(body);
      route.fulfill({ response: resp, body });
    });
    const p = await c.newPage();
    const csp = [];
    p.on('console', (m) => { if (m.text().includes('Content Security Policy') || m.text().includes('CSP')) csp.push(m.text().slice(0, 300)); });
    await p.goto(APP + url);
    const r = await p.evaluate(() => window.runSpike());
    await sleep(1000);
    await c.close();
    return { r, csp };
  };
  clearHits();
  const v1 = await variant('exfil.html?noguard=1');
  verdict('c_csp_alone_blocks_in_blob_worker', sinkHits().length === 0, { sinkHits: sinkHits(), cspConsole: v1.csp.slice(0, 12) });
  clearHits();
  const v2 = await variant('exfil.html?noguard=1&urlworker=1');
  const leaked = sinkHits();
  verdict('info_url_worker_without_stubs_LEAKS_as_expected', leaked.length > 0, { sinkHits: leaked.map((h) => h.path),
    meaning: 'A worker loaded by URL does not inherit a <meta> CSP. Lynceus must create workers from blob: URLs.' });
  clearHits();
  const noEval = (b) => b.replace(" 'unsafe-eval'", '');
  const v3 = await variant('js.html', noEval);
  verdict('info_js_without_unsafe_eval', !!(v3.r.results && v3.r.results.some((t) => t.outcome === 'passed')), { result: v3.r.fatal || v3.r.results?.slice(0, 3), cspConsole: v3.csp.slice(0, 5) });
  const v4 = await variant('py.html', noEval);
  verdict('info_py_without_unsafe_eval', pyCheck(v4.r), { result: v4.r.fatal ? String(v4.r.fatal).slice(0, 400) : 'ran', cspConsole: v4.csp.slice(0, 5) });

  // ---------- (a) OFFLINE: kill the server AND set the browser offline ----------
  server.kill(); await sleep(500);
  await ctx.setOffline(true);
  out.phase = 'a-offline';
  const offStart = requests.length;
  const pyOff = await runOn('py.html');
  const jsOff = await runOn('js.html');
  verdict('a_pyodide_offline', pyCheck(pyOff), { timing: pyOff.timing, fatal: pyOff.fatal, requestsWhileOffline: requests.length - offStart });
  verdict('b_js_offline', !jsOff.fatal && jsOff.results?.length === 6, { fatal: jsOff.fatal });

  // zero foreign requests across the whole main context
  // A request the browser refuses under CSP still shows up as a request *event* (DevTools shows it as
  // "(blocked:csp)") but no bytes leave the machine. Count those separately; the sink log is ground truth.
  const foreignAll = requests.filter((r) => !r.url.startsWith(APP) && !r.url.startsWith('blob:'))
    .map((r) => ({ url: r.url, phase: r.phase, failure: failedReasons.get(r.req) || null }));
  const sent = foreignAll.filter((r) => !/blocked|csp/i.test(r.failure || ''));
  verdict('zero_foreign_requests_main_context', sent.length === 0, { foreignAttemptsBlockedByBrowser: foreignAll.filter((r) => !sent.includes(r)), foreignSent: sent, totalRequests: requests.length });
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
out.finished = new Date().toISOString();
const logDir = path.join(HERE, '..', 'docs', 'logs');
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, 'phase0-check.json'), JSON.stringify(out, null, 2));
const failed = Object.entries(out.checks).filter(([k, v]) => !v.pass && !k.startsWith('info_'));
console.log(failed.length ? `\n${failed.length} required check(s) FAILED` : '\nALL REQUIRED CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
